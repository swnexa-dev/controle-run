import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'
import { discoverProjectFolder, discoverProjects, mergeProjectConfig, projectId } from './discovery'
import { readEnvFile, saveEnvFile } from './env-file'
import { controlProject, disconnectPm2, getProcesses, removeProjectProcess, startProject } from './pm2-service'
import { loadSettings, saveSettings } from './store'
import { detectLocalUrl } from './urls'
import {
  actionGitHubRunner,
  getGitHubRunnerDefaults,
  getGitHubRunnerState,
  installGitHubRunner,
  openGitHubRunnerLogs,
  openGitHubRunnerWorkflow,
  prepareGitHubRunnerDeployment,
  removeGitHubRunner,
  suggestedRunnerPath
} from './github-runner-service'
import { CONTROL_RUN_WORKFLOW } from './deployment-service'
import { buildProject } from './build-service'
import {
  actionCloudflareTunnel,
  addCloudflareTunnel,
  autoStartCloudflareTunnels,
  copyCloudflareTunnelUrl,
  getCloudflareTunnelState,
  installCloudflared,
  openCloudflareTunnelLogs,
  openCloudflareTunnelUrl,
  removeCloudflareTunnel
} from './cloudflare-tunnel-service'
import type {
  AppState,
  CloudflareTunnelAction,
  CloudflareTunnelDraft,
  EnvVarDraft,
  GitHubRunnerAction,
  GitHubRunnerInstallDraft,
  ProcessStatus,
  ProjectAction,
  ProjectDraft,
  ProjectView
} from '../shared/types'
import {
  appendRecoveryLog,
  isBackgroundRecovery,
  recoveryLoginItem
} from './startup-recovery'

async function migrateLegacyFolder(settings: Awaited<ReturnType<typeof loadSettings>>) {
  if (settings.projectPaths.length || !settings.rootPath) return
  const entries = await fs.readdir(settings.rootPath, { withFileTypes: true }).catch(() => [])
  settings.projectPaths = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(settings.rootPath!, entry.name))
  settings.rootPath = null
  await saveSettings(settings)
}

async function buildState(): Promise<AppState> {
  const settings = await loadSettings()
  await migrateLegacyFolder(settings)
  if (!settings.projectPaths.length) return { projectPaths: [], projects: [] }

  const discovered = await discoverProjects(settings.projectPaths)
  for (const item of discovered) {
    settings.projects[item.id] = mergeProjectConfig(item, settings.projects[item.id])
  }
  await saveSettings(settings)

  let processes: Awaited<ReturnType<typeof getProcesses>> = []
  try { processes = await getProcesses() } catch { /* UI mostra os projetos sem métricas */ }

  const projects: ProjectView[] = await Promise.all(discovered.map(async (item) => {
    const config = settings.projects[item.id]
    const processInfo = processes.find((process) => process.name === config.pm2Name)
    const env = processInfo?.pm2_env
    const runtime = env as (typeof env & { node_version?: string; version?: string })
    return {
      ...item,
      ...config,
      availableScripts: item.availableScripts,
      packageName: item.packageName,
      localUrl: await detectLocalUrl(config, processInfo?.pid),
      status: (env?.status as ProcessStatus) || 'stopped',
      cpu: processInfo?.monit?.cpu || 0,
      memory: processInfo?.monit?.memory || 0,
      uptime: env?.pm_uptime && env.status === 'online' ? Date.now() - env.pm_uptime : 0,
      restarts: env?.restart_time || 0,
      pid: processInfo?.pid,
      nodeVersion: runtime?.node_version,
      version: runtime?.version
    }
  }))
  return { projectPaths: settings.projectPaths, projects }
}

async function autoStart(state: AppState) {
  const errors: string[] = []
  const processes = await getProcesses().catch(() => [])
  for (const project of state.projects.filter((item) => item.autoStart && (item.npmScript || item.entry))) {
    const current = processes.find((process) => process.name === project.pm2Name)
    if (current?.pm2_env?.status !== 'online') {
      try {
        if (current) await controlProject(project, 'start')
        else await startProject(project)
      } catch (error) {
        const message = `Falha ao iniciar ${project.name}: ${error instanceof Error ? error.message : String(error)}`
        errors.push(message)
        console.error(message)
      }
    }
  }
  return errors
}

function isTrustedRendererUrl(value: string) {
  try {
    const candidate = new URL(value)
    const developmentUrl = process.env.ELECTRON_RENDERER_URL
    if (developmentUrl) return candidate.origin === new URL(developmentUrl).origin
    if (candidate.protocol !== 'file:') return false
    const expected = path.resolve(__dirname, '../../dist/index.html')
    const actual = path.resolve(fileURLToPath(candidate))
    return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
  } catch {
    return false
  }
}

function assertTrustedIpcEvent(event: IpcMainInvokeEvent) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL()
  if (!isTrustedRendererUrl(senderUrl)) throw new Error('Origem não autorizada para acessar as funções do Controle Run.')
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`)
  return value as Record<string, unknown>
}

function stringOf(value: unknown, label: string, maximum = 4096, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim())) throw new Error(`${label} inválido.`)
  return value
}

function optionalStringOf(value: unknown, label: string, maximum = 4096) {
  return value === undefined || value === null || value === '' ? undefined : stringOf(value, label, maximum)
}

function booleanOf(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} inválido.`)
  return value
}

function enumOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} inválido.`)
  return value as T
}

function idOf(value: unknown, label = 'Identificador') {
  const id = stringOf(value, label, 64)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`${label} inválido.`)
  return id
}

function projectDraftOf(value: unknown): ProjectDraft {
  const draft = recordOf(value, 'Configuração do projeto')
  return {
    id: idOf(draft.id),
    name: stringOf(draft.name, 'Nome do projeto', 120),
    mode: enumOf(draft.mode, 'Modo de execução', ['npm', 'script']),
    npmScript: optionalStringOf(draft.npmScript, 'Script NPM', 120),
    buildScript: optionalStringOf(draft.buildScript, 'Script de build', 120),
    buildOnDeploy: booleanOf(draft.buildOnDeploy, 'Opção de build no deploy'),
    installDependenciesOnDeploy: booleanOf(draft.installDependenciesOnDeploy, 'Opção de dependências no deploy'),
    entry: optionalStringOf(draft.entry, 'Arquivo de entrada', 1024),
    args: optionalStringOf(draft.args, 'Argumentos', 2048),
    autoStart: booleanOf(draft.autoStart, 'Inicialização automática')
  }
}

function envVariablesOf(value: unknown): EnvVarDraft[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error('Lista de variáveis de ambiente inválida.')
  return value.map((item, index) => {
    const variable = recordOf(item, `Variável ${index + 1}`)
    return {
      key: stringOf(variable.key, `Chave da variável ${index + 1}`, 256, true),
      value: stringOf(variable.value, `Valor da variável ${index + 1}`, 65_536, true)
    }
  })
}

function runnerDraftOf(value: unknown): GitHubRunnerInstallDraft {
  const draft = recordOf(value, 'Configuração do runner')
  if (!Array.isArray(draft.labels) || draft.labels.length > 100) throw new Error('Labels do runner inválidas.')
  return {
    name: stringOf(draft.name, 'Nome do runner', 64),
    scope: enumOf(draft.scope, 'Escopo do runner', ['organization', 'repository']),
    targetUrl: stringOf(draft.targetUrl, 'URL do GitHub', 2048),
    registrationToken: stringOf(draft.registrationToken, 'Token de registro', 8192),
    installPath: stringOf(draft.installPath, 'Diretório de instalação', 1024),
    workFolder: stringOf(draft.workFolder, 'Pasta de trabalho', 120),
    labels: draft.labels.map((label, index) => stringOf(label, `Label ${index + 1}`, 120)),
    serviceAccount: enumOf(draft.serviceAccount, 'Conta do serviço', ['network-service', 'custom']),
    windowsAccount: optionalStringOf(draft.windowsAccount, 'Conta do Windows', 256),
    windowsPassword: optionalStringOf(draft.windowsPassword, 'Senha da conta', 1024),
    projectGroupId: draft.projectGroupId === undefined ? undefined : idOf(draft.projectGroupId, 'Projeto associado')
  }
}

function tunnelDraftOf(value: unknown): CloudflareTunnelDraft {
  const draft = recordOf(value, 'Configuração do túnel')
  return {
    name: stringOf(draft.name, 'Nome do túnel', 64),
    projectId: idOf(draft.projectId, 'Projeto do túnel'),
    originUrl: stringOf(draft.originUrl, 'URL de origem', 2048),
    publicUrl: optionalStringOf(draft.publicUrl, 'URL pública', 2048),
    mode: enumOf(draft.mode, 'Modo do túnel', ['quick', 'token']),
    token: optionalStringOf(draft.token, 'Token do túnel', 16_384),
    protocol: enumOf(draft.protocol, 'Protocolo do túnel', ['auto', 'quic', 'http2']),
    logLevel: enumOf(draft.logLevel, 'Nível de log', ['debug', 'info', 'warn', 'error']),
    autoStart: booleanOf(draft.autoStart, 'Inicialização automática do túnel')
  }
}

function secureHandle<T extends unknown[]>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: T) => unknown
) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedIpcEvent(event)
    return listener(event, ...args as T)
  })
}

function registerIpc() {
  secureHandle('state:get', () => buildState())
  secureHandle('project:add', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Selecione a pasta do projeto' })
    if (result.canceled || !result.filePaths[0]) return buildState()
    const selectedPath = path.resolve(result.filePaths[0])
    const services = await discoverProjectFolder(selectedPath)
    if (!services.some((service) => service.serviceType === 'frontend' || service.serviceType === 'backend')) {
      throw new Error('A pasta selecionada precisa conter uma pasta frontend ou backend.')
    }
    const settings = await loadSettings()
    await migrateLegacyFolder(settings)
    const alreadyAdded = settings.projectPaths.some((item) => path.resolve(item).toLowerCase() === selectedPath.toLowerCase())
    if (!alreadyAdded) settings.projectPaths.push(selectedPath)
    await saveSettings(settings)
    const state = await buildState()
    await autoStart(state)
    return buildState()
  })
  secureHandle('projects:refresh', () => buildState())
  secureHandle('project:remove', async (_event, groupId: unknown) => {
    const validatedGroupId = idOf(groupId, 'Projeto')
    const settings = await loadSettings()
    await migrateLegacyFolder(settings)
    const services = Object.values(settings.projects).filter((project) => project.groupId === validatedGroupId)
    for (const service of services) await removeProjectProcess(service)
    settings.projectPaths = settings.projectPaths.filter((projectPath) => projectId(projectPath) !== validatedGroupId)
    for (const service of services) delete settings.projects[service.id]
    await saveSettings(settings)
    return buildState()
  })
  secureHandle('project:configure', async (_event, input: unknown) => {
    const draft = projectDraftOf(input)
    const settings = await loadSettings()
    const current = settings.projects[draft.id]
    if (!current) throw new Error('Projeto não encontrado.')
    let npmCommand = current.npmCommand
    if (draft.mode === 'npm' && draft.npmScript) {
      const packageJsonPath = path.join(current.path, 'package.json')
      const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8').catch(() => '{}')) as { scripts?: Record<string, string> }
      npmCommand = pkg.scripts?.[draft.npmScript]
    }
    settings.projects[draft.id] = { ...current, ...draft, npmCommand, detected: current.detected }
    await saveSettings(settings)
    return buildState()
  })
  secureHandle('project:action', async (_event, inputId: unknown, inputAction: unknown) => {
    const id = idOf(inputId, 'Projeto')
    const action = enumOf<ProjectAction>(inputAction, 'Ação do projeto', ['start', 'stop', 'restart', 'build-restart'])
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (!project) throw new Error('Projeto não encontrado.')
    if (action === 'build-restart') {
      await buildProject(project)
      await controlProject(project, 'start')
    } else {
      await controlProject(project, action)
    }
    return buildState()
  })
  secureHandle('project:open-folder', async (_event, inputId: unknown) => {
    const id = idOf(inputId, 'Projeto')
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (project) await shell.openPath(project.path)
  })
  secureHandle('project:open-url', async (_event, inputId: unknown) => {
    const id = idOf(inputId, 'Projeto')
    const settings = await loadSettings()
    const project = settings.projects[id]
    const processes = await getProcesses().catch(() => [])
    const processInfo = project ? processes.find((process) => process.name === project.pm2Name) : undefined
    const url = project ? await detectLocalUrl(project, processInfo?.pid) : null
    if (url) await shell.openExternal(url)
  })
  secureHandle('project:env-read', async (_event, inputId: unknown) => {
    const id = idOf(inputId, 'Projeto')
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (!project) throw new Error('Projeto não encontrado.')
    return readEnvFile(project.path)
  })
  secureHandle('project:env-save', async (_event, inputId: unknown, inputVariables: unknown) => {
    const id = idOf(inputId, 'Projeto')
    const variables = envVariablesOf(inputVariables)
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (!project) throw new Error('Projeto não encontrado.')
    await saveEnvFile(project.path, variables)
  })
  secureHandle('runner:state', () => getGitHubRunnerState())
  secureHandle('runner:defaults', () => getGitHubRunnerDefaults())
  secureHandle('runner:suggest-path', (_event, name: unknown) => suggestedRunnerPath(stringOf(name, 'Nome do runner', 64)))
  secureHandle('runner:install', async (event, input: unknown) => {
    const draft = runnerDraftOf(input)
    return installGitHubRunner(draft, (progress) => event.sender.send('runner:progress', progress))
  })
  secureHandle('runner:action', (_event, inputId: unknown, inputAction: unknown) => actionGitHubRunner(
    idOf(inputId, 'Runner'),
    enumOf<GitHubRunnerAction>(inputAction, 'Ação do runner', ['start', 'stop', 'restart'])
  ))
  secureHandle('runner:open-logs', (_event, id: unknown) => openGitHubRunnerLogs(idOf(id, 'Runner')))
  secureHandle('runner:prepare-deployment', (_event, id: unknown, overwriteWorkflow: unknown = false) => prepareGitHubRunnerDeployment(
    idOf(id, 'Runner'),
    booleanOf(overwriteWorkflow, 'Confirmação de substituição')
  ))
  secureHandle('runner:copy-workflow', () => { clipboard.writeText(CONTROL_RUN_WORKFLOW) })
  secureHandle('runner:open-workflow', (_event, id: unknown) => openGitHubRunnerWorkflow(idOf(id, 'Runner')))
  secureHandle('runner:remove', (_event, id: unknown, removalToken: unknown) => removeGitHubRunner(
    idOf(id, 'Runner'),
    stringOf(removalToken, 'Token de remoção', 8192)
  ))
  secureHandle('tunnel:state', () => getCloudflareTunnelState())
  secureHandle('tunnel:install-cloudflared', () => installCloudflared())
  secureHandle('tunnel:add', (_event, draft: unknown) => addCloudflareTunnel(tunnelDraftOf(draft)))
  secureHandle('tunnel:action', (_event, id: unknown, action: unknown) => actionCloudflareTunnel(
    idOf(id, 'Túnel'),
    enumOf<CloudflareTunnelAction>(action, 'Ação do túnel', ['start', 'stop', 'restart'])
  ))
  secureHandle('tunnel:remove', (_event, id: unknown) => removeCloudflareTunnel(idOf(id, 'Túnel')))
  secureHandle('tunnel:open-logs', (_event, id: unknown) => openCloudflareTunnelLogs(idOf(id, 'Túnel')))
  secureHandle('tunnel:open-url', (_event, id: unknown) => openCloudflareTunnelUrl(idOf(id, 'Túnel')))
  secureHandle('tunnel:copy-url', (_event, id: unknown) => copyCloudflareTunnelUrl(idOf(id, 'Túnel')))
}

let mainWindow: BrowserWindow | null = null

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'app-icon.png')
    : path.join(
        app.getAppPath(),
        'build-resources',
        'icons',
        process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png'
      )
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) console.warn(`Nao foi possivel carregar o icone do aplicativo: ${iconPath}`)

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 650,
    icon,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#a9b0bf', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false
    }
  })
  const blockUntrustedNavigation = (event: Electron.Event, url: string) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  }
  window.webContents.on('will-navigate', blockUntrustedNavigation)
  window.webContents.on('will-redirect', blockUntrustedNavigation)
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  if (!icon.isEmpty() && process.platform !== 'darwin') window.setIcon(icon)
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../../dist/index.html'))
  mainWindow = window
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  return window
}

app.setAppUserModelId('br.com.controlerun.app')
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
const backgroundRecovery = isBackgroundRecovery(process.argv)

function configureStartupRecovery() {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const loginItem = recoveryLoginItem(process.execPath)
  app.setLoginItemSettings(loginItem)
  const actual = app.getLoginItemSettings({ path: loginItem.path, args: [...loginItem.args] })
  if (!actual.openAtLogin || !actual.executableWillLaunchAtLogin) {
    throw new Error('O Windows não confirmou a entrada de recuperação automática do Controle Run.')
  }
}

async function runBackgroundRecovery() {
  try {
    const state = await buildState()
    const errors = [
      ...await autoStart(state),
      ...await autoStartCloudflareTunnels()
    ]
    if (errors.length) throw new Error(errors.join(' | '))
    await appendRecoveryLog(app.getPath('userData'), 'success', `Recuperação concluída: ${state.projects.filter((project) => project.autoStart).length} serviço(s) verificado(s).`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRecoveryLog(app.getPath('userData'), 'failed', message).catch(() => undefined)
    console.error('Falha na recuperação automática do Controle Run:', error)
    process.exitCode = 1
  } finally {
    disconnectPm2()
    app.quit()
  }
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  try {
    configureStartupRecovery()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRecoveryLog(app.getPath('userData'), 'failed', `Registro de inicialização: ${message}`).catch(() => undefined)
    console.error('Falha ao registrar a recuperação automática:', error)
    if (!backgroundRecovery) dialog.showErrorBox('Recuperação automática não configurada', message)
  }
  if (backgroundRecovery) {
    await runBackgroundRecovery()
    return
  }
  registerIpc()
  createWindow()
  const state = await buildState()
  await autoStart(state)
  await autoStartCloudflareTunnels()
})

app.on('window-all-closed', () => {
  disconnectPm2()
  if (process.platform !== 'darwin') app.quit()
})
