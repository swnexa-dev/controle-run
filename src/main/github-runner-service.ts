import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  GitHubRunnerAction,
  GitHubRunnerConfig,
  GitHubRunnerInstallDefaults,
  GitHubRunnerInstallDraft,
  GitHubRunnerProgress,
  GitHubRunnerScope,
  GitHubRunnerState,
  GitHubRunnerView
} from '../shared/types'
import { loadSettings, saveSettings } from './store'

interface RunnerRelease {
  tag_name: string
  body?: string
  assets: Array<{ name: string; browser_download_url: string; digest?: string | null }>
}

interface RunnerPackage {
  version: string
  filename: string
  downloadUrl: string
  sha256: string
}

interface AdminResult {
  ok: boolean
  message: string
  data?: { serviceName?: string; cleanupWarning?: string }
}

type ProgressCallback = (progress: GitHubRunnerProgress) => void

const FALLBACK_PACKAGE: RunnerPackage = {
  version: '2.335.1',
  filename: 'actions-runner-win-x64-2.335.1.zip',
  downloadUrl: 'https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-win-x64-2.335.1.zip',
  sha256: 'eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d'
}

const ADMIN_HELPER = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$clearBytes = $null
$request = $null

function Write-AdminResult([bool]$Ok, [string]$Message, $Data = $null) {
  $payload = @{ ok = $Ok; message = $Message; data = $Data } | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($ResultPath, $payload, $Utf8NoBom)
}

try {
  $encryptedBytes = [System.IO.File]::ReadAllBytes($RequestPath)
  $clearBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $encryptedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::LocalMachine
  )
  $requestJson = [System.Text.Encoding]::UTF8.GetString($clearBytes)
  $request = $requestJson | ConvertFrom-Json

  if ($request.operation -eq 'install') {
    $installPath = [System.IO.Path]::GetFullPath([string]$request.installPath)
    if (Test-Path -LiteralPath $installPath) {
      $existing = Get-ChildItem -LiteralPath $installPath -Force | Select-Object -First 1
      if ($existing) { throw 'A pasta de instalação precisa estar vazia.' }
    } else {
      New-Item -ItemType Directory -Path $installPath -Force | Out-Null
    }

    Expand-Archive -LiteralPath ([string]$request.zipPath) -DestinationPath $installPath -Force
    $configPath = Join-Path $installPath 'config.cmd'
    if (-not (Test-Path -LiteralPath $configPath)) { throw 'O pacote extraído não contém config.cmd.' }

    $configArgs = @(
      '--unattended',
      '--url', [string]$request.targetUrl,
      '--token', [string]$request.registrationToken,
      '--name', [string]$request.name,
      '--work', [string]$request.workFolder,
      '--runasservice',
      '--windowslogonaccount', [string]$request.windowsAccount
    )
    if ($request.labels -and $request.labels.Count -gt 0) {
      $configArgs += @('--labels', (($request.labels | ForEach-Object { [string]$_ }) -join ','))
    }
    if ($request.windowsPassword) {
      $configArgs += @('--windowslogonpassword', [string]$request.windowsPassword)
    }

    Push-Location $installPath
    try {
      $configOutput = & $configPath @configArgs 2>&1 | Out-String
      $configExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($configExitCode -ne 0) {
      if ($request.registrationToken) { $configOutput = $configOutput.Replace([string]$request.registrationToken, '***') }
      if ($request.windowsPassword) { $configOutput = $configOutput.Replace([string]$request.windowsPassword, '***') }
      throw "Falha ao registrar o runner (código $configExitCode). $($configOutput.Trim())"
    }

    $serviceFile = Join-Path $installPath '.service'
    if (-not (Test-Path -LiteralPath $serviceFile)) { throw 'O runner foi configurado, mas o serviço do Windows não foi criado.' }
    $serviceName = (Get-Content -LiteralPath $serviceFile -Raw).Trim()
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -ne 'Running') { Start-Service -Name $serviceName }
    Write-AdminResult $true 'Runner instalado e serviço iniciado.' @{ serviceName = $serviceName }
  }
  elseif ($request.operation -eq 'service') {
    $serviceName = [string]$request.serviceName
    if (-not $serviceName) {
      $serviceName = (Get-Content -LiteralPath (Join-Path ([string]$request.installPath) '.service') -Raw).Trim()
    }
    if ($request.action -eq 'start') { Start-Service -Name $serviceName }
    elseif ($request.action -eq 'stop') { Stop-Service -Name $serviceName -Force }
    elseif ($request.action -eq 'restart') { Restart-Service -Name $serviceName -Force }
    else { throw 'Ação de serviço inválida.' }
    Write-AdminResult $true 'Ação concluída.' @{ serviceName = $serviceName }
  }
  elseif ($request.operation -eq 'remove') {
    $installPath = [System.IO.Path]::GetFullPath([string]$request.installPath)
    $configPath = Join-Path $installPath 'config.cmd'
    if (-not (Test-Path -LiteralPath $configPath)) { throw 'config.cmd não foi encontrado na instalação.' }
    Push-Location $installPath
    try {
      $removeOutput = & $configPath remove --token ([string]$request.removalToken) 2>&1 | Out-String
      $removeExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ($removeExitCode -ne 0) {
      if ($request.removalToken) { $removeOutput = $removeOutput.Replace([string]$request.removalToken, '***') }
      throw "Falha ao remover o runner do GitHub (código $removeExitCode). $($removeOutput.Trim())"
    }
    $cleanupWarning = $null
    try { Remove-Item -LiteralPath $installPath -Recurse -Force } catch { $cleanupWarning = $_.Exception.Message }
    Write-AdminResult $true 'Runner removido.' @{ cleanupWarning = $cleanupWarning }
  }
  else {
    throw 'Operação administrativa inválida.'
  }
}
catch {
  Write-AdminResult $false $_.Exception.Message
  exit 1
}
finally {
  if ($clearBytes) { [Array]::Clear($clearBytes, 0, $clearBytes.Length) }
  $request = $null
}
`.trimStart()

function requireWindows() {
  if (process.platform !== 'win32') throw new Error('O gerenciamento de GitHub Actions Runner está disponível somente no Windows.')
}

export function sanitizeRunnerName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

export function normalizeGitHubTarget(value: string, scope: GitHubRunnerScope) {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Informe uma URL válida do GitHub.') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use uma URL HTTPS do github.com sem parâmetros adicionais.')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const expected = scope === 'organization' ? 1 : 2
  if (segments.length !== expected) {
    throw new Error(scope === 'organization'
      ? 'Para organização, use o formato https://github.com/minha-organizacao.'
      : 'Para repositório, use o formato https://github.com/organizacao/repositorio.')
  }
  segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '')
  if (segments.some((segment) => !/^[a-zA-Z0-9_.-]+$/.test(segment))) throw new Error('A URL contém um nome de organização ou repositório inválido.')
  return `https://github.com/${segments.join('/')}`
}

export function selectWindowsRunnerPackage(release: RunnerRelease): RunnerPackage {
  const asset = release.assets.find((item) => /^actions-runner-win-x64-[\d.]+\.zip$/i.test(item.name))
  if (!asset) throw new Error('A versão mais recente não possui pacote Windows x64.')
  const version = release.tag_name.replace(/^v/i, '')
  const digest = asset.digest?.replace(/^sha256:/i, '').toLowerCase()
  const escapedName = asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bodyDigest = release.body?.match(new RegExp(`${escapedName}\\s+([a-f0-9]{64})`, 'i'))?.[1]?.toLowerCase()
  const sha256 = digest || bodyDigest
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('O GitHub não informou o SHA-256 do pacote do runner.')
  return { version, filename: asset.name, downloadUrl: asset.browser_download_url, sha256 }
}

async function latestRunnerPackage(): Promise<RunnerPackage> {
  try {
    const response = await fetch('https://api.github.com/repos/actions/runner/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Controle-Run' },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`GitHub respondeu ${response.status}.`)
    return selectWindowsRunnerPackage(await response.json() as RunnerRelease)
  } catch (error) {
    console.warn('Não foi possível consultar a versão mais recente do runner; usando pacote de contingência validado.', error)
    return FALLBACK_PACKAGE
  }
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

async function downloadRunnerPackage(pkg: RunnerPackage, progress: ProgressCallback) {
  const cacheDir = path.join(app.getPath('userData'), 'runner-cache')
  const destination = path.join(cacheDir, pkg.filename)
  await fs.mkdir(cacheDir, { recursive: true })
  try {
    progress({ stage: 'verifying', message: 'Validando o pacote já armazenado...' })
    if (await hashFile(destination) === pkg.sha256) return destination
    await fs.unlink(destination)
  } catch { /* o pacote ainda não existe ou será baixado novamente */ }

  progress({ stage: 'downloading', message: `Baixando GitHub Actions Runner ${pkg.version}...` })
  const temporary = `${destination}.${randomUUID()}.download`
  const response = await fetch(pkg.downloadUrl, { headers: { 'User-Agent': 'Controle-Run' } })
  if (!response.ok || !response.body) throw new Error(`Falha no download do runner: HTTP ${response.status}.`)
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      createWriteStream(temporary)
    )
    progress({ stage: 'verifying', message: 'Conferindo a integridade SHA-256...' })
    const actual = await hashFile(temporary)
    if (actual !== pkg.sha256) throw new Error('O SHA-256 do pacote baixado não corresponde ao publicado pelo GitHub.')
    await fs.rename(temporary, destination)
    return destination
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined)
    throw error
  }
}

function runProcess(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

async function ensureAdminHelper() {
  const helperPath = path.join(app.getPath('userData'), 'runner-admin-helper.ps1')
  await fs.mkdir(path.dirname(helperPath), { recursive: true })
  await fs.writeFile(helperPath, ADMIN_HELPER, 'utf8')
  return helperPath
}

async function protectAdminRequest(requestPath: string, request: unknown) {
  const protector = String.raw`
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::LocalMachine
)
[System.IO.File]::WriteAllBytes($env:CONTROLE_RUN_REQUEST_PATH, $protected)
[Array]::Clear($bytes, 0, $bytes.Length)
`.trim()
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', protector], {
    env: { ...process.env, CONTROLE_RUN_REQUEST_PATH: requestPath },
    input: JSON.stringify(request)
  })
  if (result.code !== 0) throw new Error(`Não foi possível proteger a solicitação administrativa. ${result.stderr.trim()}`)
}

async function runElevated(request: unknown): Promise<AdminResult> {
  requireWindows()
  const helperPath = await ensureAdminHelper()
  const operationId = randomUUID()
  const requestPath = path.join(app.getPath('temp'), `controle-run-${operationId}.bin`)
  const resultPath = path.join(app.getPath('temp'), `controle-run-${operationId}.result.json`)
  await protectAdminRequest(requestPath, request)
  const launcher = String.raw`
$arguments = @(
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + $env:CONTROLE_RUN_HELPER + '"'),
  '-RequestPath', ('"' + $env:CONTROLE_RUN_REQUEST + '"'),
  '-ResultPath', ('"' + $env:CONTROLE_RUN_RESULT + '"')
)
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
exit $process.ExitCode
`.trim()
  try {
    const elevated = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
      env: {
        ...process.env,
        CONTROLE_RUN_HELPER: helperPath,
        CONTROLE_RUN_REQUEST: requestPath,
        CONTROLE_RUN_RESULT: resultPath
      }
    })
    let result: AdminResult | undefined
    try { result = JSON.parse((await fs.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, '')) as AdminResult } catch { /* UAC cancelado ou helper interrompido */ }
    if (!result) {
      const detail = elevated.stderr.trim() || elevated.stdout.trim()
      throw new Error(detail ? `A operação administrativa não foi concluída. ${detail}` : 'A operação administrativa foi cancelada ou não foi concluída.')
    }
    if (!result.ok) throw new Error(result.message)
    return result
  } finally {
    await fs.unlink(requestPath).catch(() => undefined)
    await fs.unlink(resultPath).catch(() => undefined)
  }
}

function validateDraft(draft: GitHubRunnerInstallDraft) {
  requireWindows()
  const name = sanitizeRunnerName(draft.name)
  if (!name || name !== draft.name.trim()) throw new Error('O nome do runner pode conter apenas letras, números, ponto, hífen e sublinhado.')
  const targetUrl = normalizeGitHubTarget(draft.targetUrl, draft.scope)
  if (!draft.registrationToken.trim()) throw new Error('Informe o token temporário de registro.')
  if (!path.win32.isAbsolute(draft.installPath)) throw new Error('Informe um caminho absoluto do Windows para a instalação.')
  const installPath = path.win32.resolve(draft.installPath)
  if (installPath === path.win32.parse(installPath).root) throw new Error('Não é permitido instalar diretamente na raiz do disco.')
  const workFolder = draft.workFolder.trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(workFolder) || workFolder === '.' || workFolder === '..') throw new Error('A pasta de trabalho deve ser um nome relativo simples, como _work.')
  const labels = [...new Set(draft.labels.map((label) => label.trim()).filter(Boolean))]
  if (labels.length > 100 || labels.some((label) => !/^[a-zA-Z0-9._-]+$/.test(label))) throw new Error('As labels podem conter apenas letras, números, ponto, hífen e sublinhado.')
  let windowsAccount = 'NT AUTHORITY\\NETWORK SERVICE'
  if (draft.serviceAccount === 'custom') {
    windowsAccount = draft.windowsAccount?.trim() || ''
    if (!windowsAccount || !draft.windowsPassword) throw new Error('Informe a conta do Windows e a senha usada pelo serviço.')
  }
  return { name, targetUrl, installPath, workFolder, labels, windowsAccount }
}

async function serviceName(config: GitHubRunnerConfig) {
  if (config.serviceName) return config.serviceName
  return fs.readFile(path.join(config.installPath, '.service'), 'utf8').then((value) => value.trim()).catch(() => '')
}

async function serviceStatus(name: string) {
  if (!name) return 'missing' as const
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$service = Get-Service -Name $env:CONTROLE_RUN_SERVICE -ErrorAction SilentlyContinue; if ($service) { $service.Status.ToString() } else { 'Missing' }"
  ], { env: { ...process.env, CONTROLE_RUN_SERVICE: name } })
  const status = result.stdout.trim().toLowerCase()
  if (status === 'running') return 'running' as const
  if (status === 'stopped' || status === 'paused') return 'stopped' as const
  if (status === 'missing') return 'missing' as const
  return 'unknown' as const
}

async function latestRunnerLog(installPath: string) {
  const diagPath = path.join(installPath, '_diag')
  const files = await fs.readdir(diagPath).catch(() => [])
  const latest = files.filter((file) => /^Runner_.*\.log$/i.test(file)).sort().at(-1)
  if (!latest) return null
  const filePath = path.join(diagPath, latest)
  const stat = await fs.stat(filePath).catch(() => null)
  const content = await fs.readFile(filePath, 'utf8').catch(() => '')
  return { content: content.slice(-250_000), modifiedAt: stat?.mtime.toISOString() }
}

async function actualRunnerVersion(config: GitHubRunnerConfig) {
  const executable = path.join(config.installPath, 'bin', 'Runner.Listener.exe')
  try {
    await fs.access(executable)
    const result = await runProcess(executable, ['--version'], { cwd: config.installPath })
    const version = result.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0]
    return version || config.installedVersion
  } catch {
    return config.installedVersion
  }
}

async function runnerView(config: GitHubRunnerConfig): Promise<GitHubRunnerView> {
  try {
    const name = await serviceName(config)
    const status = await serviceStatus(name)
    const [log, installedVersion] = await Promise.all([latestRunnerLog(config.installPath), actualRunnerVersion(config)])
    const connected = status === 'running' && Boolean(log && /Listening for Jobs|Runner connect complete|Message listener created/i.test(log.content))
    return {
      ...config,
      installedVersion,
      serviceName: name || config.serviceName,
      serviceStatus: status,
      connectionStatus: connected ? 'connected' : status === 'running' ? 'unknown' : 'offline',
      latestLogAt: log?.modifiedAt
    }
  } catch (error) {
    return {
      ...config,
      serviceStatus: 'unknown',
      connectionStatus: 'unknown',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function getGitHubRunnerState(): Promise<GitHubRunnerState> {
  requireWindows()
  const settings = await loadSettings()
  return { runners: await Promise.all(Object.values(settings.githubRunners).map(runnerView)) }
}

export function suggestedRunnerPath(name: string) {
  return path.win32.join('C:\\actions-runners', sanitizeRunnerName(name) || 'github-runner')
}

export function getGitHubRunnerDefaults(): GitHubRunnerInstallDefaults {
  requireWindows()
  const name = sanitizeRunnerName(`${os.hostname()}-runner`)
  const domain = process.env.USERDOMAIN?.trim()
  const username = os.userInfo().username
  return {
    name,
    installPath: suggestedRunnerPath(name),
    workFolder: '_work',
    currentWindowsAccount: domain ? `${domain}\\${username}` : username
  }
}

export async function installGitHubRunner(draft: GitHubRunnerInstallDraft, progress: ProgressCallback) {
  progress({ stage: 'validating', message: 'Validando a configuração...' })
  const normalized = validateDraft(draft)
  const settings = await loadSettings()
  if (Object.values(settings.githubRunners).some((runner) => path.win32.resolve(runner.installPath).toLowerCase() === normalized.installPath.toLowerCase())) {
    throw new Error('Já existe um runner cadastrado nesse diretório.')
  }
  const existing = await fs.readdir(normalized.installPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  if (existing.length) throw new Error('A pasta de instalação precisa estar vazia.')

  const pkg = await latestRunnerPackage()
  const zipPath = await downloadRunnerPackage(pkg, progress)
  progress({ stage: 'elevating', message: 'Aguardando autorização administrativa do Windows...' })
  const admin = await runElevated({
    operation: 'install',
    zipPath,
    installPath: normalized.installPath,
    targetUrl: normalized.targetUrl,
    registrationToken: draft.registrationToken.trim(),
    name: normalized.name,
    workFolder: normalized.workFolder,
    labels: normalized.labels,
    windowsAccount: normalized.windowsAccount,
    windowsPassword: draft.serviceAccount === 'custom' ? draft.windowsPassword : undefined
  })
  progress({ stage: 'configuring', message: 'Salvando o cadastro local do runner...' })
  const id = createHash('sha1').update(`${normalized.targetUrl}|${normalized.name}|${normalized.installPath}`.toLowerCase()).digest('hex').slice(0, 12)
  settings.githubRunners[id] = {
    id,
    name: normalized.name,
    scope: draft.scope,
    targetUrl: normalized.targetUrl,
    installPath: normalized.installPath,
    workFolder: normalized.workFolder,
    labels: normalized.labels,
    serviceAccount: normalized.windowsAccount,
    serviceName: admin.data?.serviceName,
    installedVersion: pkg.version,
    projectGroupId: draft.projectGroupId || undefined,
    createdAt: new Date().toISOString()
  }
  await saveSettings(settings)
  progress({ stage: 'complete', message: 'Runner instalado e conectado.' })
  return getGitHubRunnerState()
}

export async function actionGitHubRunner(id: string, action: GitHubRunnerAction) {
  const settings = await loadSettings()
  const runner = settings.githubRunners[id]
  if (!runner) throw new Error('Runner não encontrado.')
  await runElevated({ operation: 'service', action, installPath: runner.installPath, serviceName: runner.serviceName })
  return getGitHubRunnerState()
}

export async function openGitHubRunnerLogs(id: string) {
  const settings = await loadSettings()
  const runner = settings.githubRunners[id]
  if (!runner) throw new Error('Runner não encontrado.')
  const diagPath = path.join(runner.installPath, '_diag')
  await fs.mkdir(diagPath, { recursive: true })
  const error = await shell.openPath(diagPath)
  if (error) throw new Error(error)
}

export async function removeGitHubRunner(id: string, removalToken: string) {
  if (!removalToken.trim()) throw new Error('Informe o token temporário de remoção fornecido pelo GitHub.')
  const settings = await loadSettings()
  const runner = settings.githubRunners[id]
  if (!runner) throw new Error('Runner não encontrado.')
  const result = await runElevated({ operation: 'remove', installPath: runner.installPath, removalToken: removalToken.trim() })
  delete settings.githubRunners[id]
  await saveSettings(settings)
  if (result.data?.cleanupWarning) console.warn('Runner removido, mas a pasta não pôde ser apagada:', result.data.cleanupWarning)
  return getGitHubRunnerState()
}
