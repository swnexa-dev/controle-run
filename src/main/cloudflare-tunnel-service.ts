import { app, clipboard, safeStorage, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import type {
  CloudflareTunnelAction,
  CloudflareTunnelDraft,
  CloudflareTunnelState,
  CloudflareTunnelView,
  ProcessStatus,
  StoredCloudflareTunnelConfig
} from '../shared/types'
import { controlManagedProcess, getProcesses, removeManagedProcess } from './pm2-service'
import { loadSettings, saveSettings } from './store'

interface CloudflaredRelease {
  tag_name: string
  body?: string
  assets: Array<{ name: string; browser_download_url: string; digest?: string | null }>
}

interface CloudflaredPackage {
  version: string
  filename: string
  downloadUrl: string
  sha256?: string
  checksumUrl?: string
}

const CLOUDFLARED_ASSET = 'cloudflared-windows-amd64.exe'
let binaryCache: string | null | undefined
let versionCache: { binary: string; version?: string } | undefined

function requireWindows() {
  if (process.platform !== 'win32') throw new Error('O gerenciamento do Cloudflare Tunnel está disponível somente no Windows.')
}

export function sanitizeTunnelName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function normalizeHttpUrl(value: string, label: string) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error(`Informe uma URL válida para ${label}.`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} precisa usar http:// ou https:// e não pode conter credenciais.`)
  }
  return url.toString().replace(/\/$/, '')
}

export function selectCloudflaredPackage(release: CloudflaredRelease): CloudflaredPackage {
  const asset = release.assets.find((item) => item.name.toLowerCase() === CLOUDFLARED_ASSET)
  if (!asset) throw new Error('A versão mais recente do cloudflared não possui o executável Windows x64.')
  const digest = asset.digest?.replace(/^sha256:/i, '').toLowerCase()
  const escapedName = asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bodyDigest = release.body?.match(new RegExp(`${escapedName}:?\\s+([a-f0-9]{64})`, 'i'))?.[1]?.toLowerCase()
  const publishedDigest = digest && /^[a-f0-9]{64}$/.test(digest) ? digest : bodyDigest
  const checksum = release.assets.find((item) => item.name.toLowerCase() === `${CLOUDFLARED_ASSET}.sha256`)
  if (!publishedDigest && !checksum) {
    throw new Error('A Cloudflare não publicou um SHA-256 verificável para o executável.')
  }
  return {
    version: release.tag_name.replace(/^v/i, ''),
    filename: CLOUDFLARED_ASSET,
    downloadUrl: asset.browser_download_url,
    sha256: publishedDigest,
    checksumUrl: checksum?.browser_download_url
  }
}

function runProcess(file: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function hashFile(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function latestPackage() {
  const response = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Controle-Run' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Não foi possível consultar o cloudflared mais recente (HTTP ${response.status}).`)
  const pkg = selectCloudflaredPackage(await response.json() as CloudflaredRelease)
  if (!pkg.sha256 && pkg.checksumUrl) {
    const checksumResponse = await fetch(pkg.checksumUrl, { headers: { 'User-Agent': 'Controle-Run' }, signal: AbortSignal.timeout(20_000) })
    if (!checksumResponse.ok) throw new Error('Não foi possível baixar o SHA-256 oficial do cloudflared.')
    const checksum = (await checksumResponse.text()).match(/[a-f0-9]{64}/i)?.[0].toLowerCase()
    if (!checksum) throw new Error('O arquivo de SHA-256 oficial do cloudflared é inválido.')
    pkg.sha256 = checksum
  }
  return pkg as CloudflaredPackage & { sha256: string }
}

async function managedBinaryPath() {
  return path.join(app.getPath('userData'), 'cloudflared', 'cloudflared.exe')
}

async function resolveCloudflared() {
  requireWindows()
  if (binaryCache !== undefined) return binaryCache || undefined
  const candidates = [
    await managedBinaryPath(),
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe') : ''
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) {
      binaryCache = candidate
      return candidate
    }
  }
  const located = await runProcess('where.exe', ['cloudflared.exe']).catch(() => null)
  const first = located?.code === 0 ? located.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) : undefined
  binaryCache = first || null
  return first
}

export async function installCloudflaredBinary() {
  requireWindows()
  const existing = await resolveCloudflared()
  if (existing) return existing
  const pkg = await latestPackage()
  const destination = await managedBinaryPath()
  const temporary = `${destination}.${randomUUID()}.download`
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const response = await fetch(pkg.downloadUrl, { headers: { 'User-Agent': 'Controle-Run' }, signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error(`Falha no download do cloudflared (HTTP ${response.status}).`)
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temporary))
    const actual = await hashFile(temporary)
    if (actual !== pkg.sha256) throw new Error('O SHA-256 do cloudflared baixado não corresponde ao publicado pela Cloudflare.')
    await fs.rename(temporary, destination)
    binaryCache = destination
    versionCache = undefined
    return destination
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined)
    throw error
  }
}

function encryptToken(token: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('A proteção de credenciais do Windows não está disponível neste momento.')
  return safeStorage.encryptString(token).toString('base64')
}

function decryptToken(value?: string) {
  if (!value) throw new Error('O token deste túnel não foi encontrado. Remova o cadastro e adicione-o novamente.')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('A proteção de credenciais do Windows não está disponível neste momento.')
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

function processName(id: string) {
  return `controle-run-tunnel-${id}`
}

function tunnelPaths(id: string) {
  const directory = path.join(app.getPath('userData'), 'cloudflared', 'tunnels', id)
  return { directory, logPath: path.join(directory, 'cloudflared.log') }
}

async function buildOptions(config: StoredCloudflareTunnelConfig, binary: string) {
  const { directory, logPath } = tunnelPaths(config.id)
  await fs.mkdir(directory, { recursive: true })
  const args = ['tunnel', '--no-autoupdate', '--loglevel', config.logLevel, '--logfile', logPath, '--protocol', config.protocol]
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  // Isola o processo de arquivos config.yml globais do usuário, que podem impedir Quick Tunnels.
  env.HOME = directory
  env.USERPROFILE = directory
  if (config.mode === 'quick') args.push('--url', config.originUrl)
  else {
    env.TUNNEL_TOKEN = decryptToken(config.encryptedToken)
    args.push('run')
  }
  return {
    name: processName(config.id),
    cwd: directory,
    script: binary,
    args,
    interpreter: 'none',
    autorestart: true,
    max_restarts: 10,
    time: true,
    windowsHide: true,
    env
  }
}

export function quickUrlFromLog(content: string) {
  return content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)?.at(-1)
}

async function readLog(config: StoredCloudflareTunnelConfig) {
  const { logPath } = tunnelPaths(config.id)
  const content = await fs.readFile(logPath, 'utf8').catch(() => '')
  return { logPath, content: content.slice(-250_000) }
}

async function versionOf(binary: string) {
  if (versionCache?.binary === binary) return versionCache.version
  const result = await runProcess(binary, ['--version']).catch(() => null)
  const version = result?.code === 0 ? result.stdout.match(/\d{4}\.\d+\.\d+|\d+\.\d+\.\d+/)?.[0] : undefined
  versionCache = { binary, version }
  return version
}

export async function getCloudflareTunnelState(): Promise<CloudflareTunnelState> {
  requireWindows()
  const settings = await loadSettings()
  const binary = await resolveCloudflared()
  const processes = await getProcesses().catch(() => [])
  const tunnels: CloudflareTunnelView[] = await Promise.all(Object.values(settings.cloudflareTunnels).map(async (config) => {
    const current = processes.find((process) => process.name === processName(config.id))
    const env = current?.pm2_env
    const log = await readLog(config)
    const quickUrl = config.mode === 'quick' ? quickUrlFromLog(log.content) : undefined
    const status = (env?.status as ProcessStatus) || 'stopped'
    const connectionStatus = status === 'errored'
      ? 'error' as const
      : status === 'launching'
        ? 'connecting' as const
      : status !== 'online'
        ? 'offline' as const
        : /Registered tunnel connection/i.test(log.content)
          ? 'connected' as const
          : 'connecting' as const
    const errorLine = status === 'errored'
      ? log.content.split(/\r?\n/).filter(Boolean).slice(-1)[0]
      : undefined
    return {
      id: config.id,
      name: config.name,
      projectId: config.projectId,
      originUrl: config.originUrl,
      publicUrl: quickUrl || config.publicUrl,
      mode: config.mode,
      protocol: config.protocol,
      logLevel: config.logLevel,
      autoStart: config.autoStart,
      createdAt: config.createdAt,
      status,
      connectionStatus,
      hasToken: Boolean(config.encryptedToken),
      pid: current?.pid,
      uptime: env?.pm_uptime && env.status === 'online' ? Date.now() - env.pm_uptime : 0,
      restarts: env?.restart_time || 0,
      logPath: log.logPath,
      error: errorLine
    }
  }))
  return {
    tunnels,
    cloudflaredInstalled: Boolean(binary),
    cloudflaredPath: binary,
    cloudflaredVersion: binary ? await versionOf(binary) : undefined
  }
}

export async function installCloudflared() {
  await installCloudflaredBinary()
  return getCloudflareTunnelState()
}

function validateDraft(draft: CloudflareTunnelDraft, projectExists: boolean) {
  const name = sanitizeTunnelName(draft.name)
  if (!name || name !== draft.name.trim()) throw new Error('O nome pode conter apenas letras, números, ponto, hífen e sublinhado.')
  if (!projectExists) throw new Error('Selecione um serviço cadastrado no Controle Run.')
  const originUrl = normalizeHttpUrl(draft.originUrl, 'o endereço local')
  const publicUrl = draft.publicUrl?.trim() ? normalizeHttpUrl(draft.publicUrl, 'o endereço público') : undefined
  if (draft.mode === 'token' && !draft.token?.trim()) throw new Error('Cole o token do túnel permanente criado no painel da Cloudflare.')
  if (!['auto', 'quic', 'http2'].includes(draft.protocol)) throw new Error('O protocolo selecionado é inválido.')
  if (!['debug', 'info', 'warn', 'error'].includes(draft.logLevel)) throw new Error('O nível de log selecionado é inválido.')
  return { name, originUrl, publicUrl }
}

export async function addCloudflareTunnel(draft: CloudflareTunnelDraft) {
  requireWindows()
  const settings = await loadSettings()
  const normalized = validateDraft(draft, Boolean(settings.projects[draft.projectId]))
  if (Object.values(settings.cloudflareTunnels).some((item) => item.name.toLowerCase() === normalized.name.toLowerCase())) {
    throw new Error('Já existe um túnel com esse nome.')
  }
  const binary = await installCloudflaredBinary()
  const id = createHash('sha1').update(`${normalized.name}|${draft.projectId}|${Date.now()}`).digest('hex').slice(0, 12)
  const config: StoredCloudflareTunnelConfig = {
    id,
    name: normalized.name,
    projectId: draft.projectId,
    originUrl: normalized.originUrl,
    publicUrl: normalized.publicUrl,
    mode: draft.mode,
    protocol: draft.protocol,
    logLevel: draft.logLevel,
    autoStart: draft.autoStart,
    createdAt: new Date().toISOString(),
    encryptedToken: draft.mode === 'token' ? encryptToken(draft.token!.trim()) : undefined
  }
  settings.cloudflareTunnels[id] = config
  await saveSettings(settings)
  await controlManagedProcess(processName(id), await buildOptions(config, binary), 'start')
  return getCloudflareTunnelState()
}

export async function actionCloudflareTunnel(id: string, action: CloudflareTunnelAction) {
  const settings = await loadSettings()
  const config = settings.cloudflareTunnels[id]
  if (!config) throw new Error('Túnel não encontrado.')
  const binary = await resolveCloudflared()
  if (!binary) throw new Error('O cloudflared não está instalado. Use o botão Instalar cloudflared.')
  await controlManagedProcess(processName(id), await buildOptions(config, binary), action)
  return getCloudflareTunnelState()
}

export async function removeCloudflareTunnel(id: string) {
  const settings = await loadSettings()
  const config = settings.cloudflareTunnels[id]
  if (!config) throw new Error('Túnel não encontrado.')
  await removeManagedProcess(processName(id))
  delete settings.cloudflareTunnels[id]
  await saveSettings(settings)
  await fs.rm(tunnelPaths(id).directory, { recursive: true, force: true }).catch((error) => {
    console.warn(`O túnel ${config.name} foi removido, mas os logs locais não puderam ser apagados:`, error)
  })
  return getCloudflareTunnelState()
}

export async function openCloudflareTunnelLogs(id: string) {
  const settings = await loadSettings()
  if (!settings.cloudflareTunnels[id]) throw new Error('Túnel não encontrado.')
  const paths = tunnelPaths(id)
  await fs.mkdir(paths.directory, { recursive: true })
  if (await fs.access(paths.logPath).then(() => true).catch(() => false)) shell.showItemInFolder(paths.logPath)
  else await shell.openPath(paths.directory)
}

async function publicUrlFor(id: string) {
  const state = await getCloudflareTunnelState()
  const tunnel = state.tunnels.find((item) => item.id === id)
  if (!tunnel?.publicUrl) throw new Error('O endereço público ainda não está disponível. Aguarde a conexão ou informe o hostname configurado na Cloudflare.')
  return tunnel.publicUrl
}

export async function openCloudflareTunnelUrl(id: string) {
  await shell.openExternal(await publicUrlFor(id))
}

export async function copyCloudflareTunnelUrl(id: string) {
  clipboard.writeText(await publicUrlFor(id))
}

export async function autoStartCloudflareTunnels() {
  const errors: string[] = []
  const settings = await loadSettings()
  const configs = Object.values(settings.cloudflareTunnels).filter((item) => item.autoStart)
  if (!configs.length) return errors
  const binary = await resolveCloudflared()
  if (!binary) {
    errors.push('O cloudflared não foi encontrado para restaurar os túneis automáticos.')
    return errors
  }
  const processes = await getProcesses().catch(() => [])
  for (const config of configs) {
    const current = processes.find((process) => process.name === processName(config.id))
    if (current?.pm2_env?.status === 'online') continue
    try { await controlManagedProcess(processName(config.id), await buildOptions(config, binary), 'start') }
    catch (error) {
      const message = `Falha ao iniciar o túnel ${config.name}: ${error instanceof Error ? error.message : String(error)}`
      errors.push(message)
      console.error(message)
    }
  }
  return errors
}
