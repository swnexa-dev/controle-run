import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
import type {
  AppState,
  EnvVarDraft,
  GitHubRunnerAction,
  GitHubRunnerInstallDraft,
  ProcessStatus,
  ProjectAction,
  ProjectDraft,
  ProjectView
} from '../shared/types'

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
  const processes = await getProcesses().catch(() => [])
  for (const project of state.projects.filter((item) => item.autoStart && (item.npmScript || item.entry))) {
    const current = processes.find((process) => process.name === project.pm2Name)
    if (current?.pm2_env?.status !== 'online') {
      try {
        if (current) await controlProject(project, 'start')
        else await startProject(project)
      } catch (error) { console.error(`Falha ao iniciar ${project.name}`, error) }
    }
  }
}

function registerIpc() {
  ipcMain.handle('state:get', buildState)
  ipcMain.handle('project:add', async () => {
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
  ipcMain.handle('projects:refresh', buildState)
  ipcMain.handle('project:remove', async (_event, groupId: string) => {
    const settings = await loadSettings()
    await migrateLegacyFolder(settings)
    const services = Object.values(settings.projects).filter((project) => project.groupId === groupId)
    for (const service of services) await removeProjectProcess(service).catch(() => undefined)
    settings.projectPaths = settings.projectPaths.filter((projectPath) => projectId(projectPath) !== groupId)
    for (const service of services) delete settings.projects[service.id]
    await saveSettings(settings)
    return buildState()
  })
  ipcMain.handle('project:configure', async (_event, draft: ProjectDraft) => {
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
  ipcMain.handle('project:action', async (_event, id: string, action: ProjectAction) => {
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (!project) throw new Error('Projeto não encontrado.')
    await controlProject(project, action)
    return buildState()
  })
  ipcMain.handle('project:open-folder', async (_event, id: string) => {
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (project) await shell.openPath(project.path)
  })
  ipcMain.handle('project:open-url', async (_event, id: string) => {
    const settings = await loadSettings()
    const project = settings.projects[id]
    const processes = await getProcesses().catch(() => [])
    const processInfo = project ? processes.find((process) => process.name === project.pm2Name) : undefined
    const url = project ? await detectLocalUrl(project, processInfo?.pid) : null
    if (url) await shell.openExternal(url)
  })
  ipcMain.handle('project:env-read', async (_event, id: string) => {
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (!project) throw new Error('Projeto não encontrado.')
    return readEnvFile(project.path)
  })
  ipcMain.handle('project:env-save', async (_event, id: string, variables: EnvVarDraft[]) => {
    const settings = await loadSettings()
    const project = settings.projects[id]
    if (!project) throw new Error('Projeto não encontrado.')
    await saveEnvFile(project.path, variables)
  })
  ipcMain.handle('runner:state', getGitHubRunnerState)
  ipcMain.handle('runner:defaults', () => getGitHubRunnerDefaults())
  ipcMain.handle('runner:suggest-path', (_event, name: string) => suggestedRunnerPath(name))
  ipcMain.handle('runner:install', async (event, draft: GitHubRunnerInstallDraft) => {
    return installGitHubRunner(draft, (progress) => event.sender.send('runner:progress', progress))
  })
  ipcMain.handle('runner:action', (_event, id: string, action: GitHubRunnerAction) => actionGitHubRunner(id, action))
  ipcMain.handle('runner:open-logs', (_event, id: string) => openGitHubRunnerLogs(id))
  ipcMain.handle('runner:prepare-deployment', (_event, id: string, overwriteWorkflow = false) => prepareGitHubRunnerDeployment(id, overwriteWorkflow))
  ipcMain.handle('runner:copy-workflow', () => { clipboard.writeText(CONTROL_RUN_WORKFLOW) })
  ipcMain.handle('runner:open-workflow', (_event, id: string) => openGitHubRunnerWorkflow(id))
  ipcMain.handle('runner:remove', (_event, id: string, removalToken: string) => removeGitHubRunner(id, removalToken))
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 650,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#a9b0bf', height: 42 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(path.join(__dirname, '../../dist/index.html'))
}

app.whenReady().then(async () => {
  registerIpc()
  createWindow()
  const state = await buildState()
  await autoStart(state)
})

app.on('window-all-closed', () => {
  disconnectPm2()
  if (process.platform !== 'darwin') app.quit()
})
