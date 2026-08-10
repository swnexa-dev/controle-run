import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
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
import {
  CONTROL_RUN_DEPLOY_SCRIPT,
  inspectRunnerDeployment,
  projectRootForGroup,
  readProjectGitHubRepository,
  repositoryFromTargetUrl,
  runnerRoutingLabel,
  runnerDeploymentPaths,
  servicesForGroup,
  writeStandardWorkflow
} from './deployment-service'
import { loadSettings, saveSettings, type Settings } from './store'
import {
  ADMIN_HELPER_PUBLIC_KEY,
  ADMIN_HELPER_SHA256,
  ADMIN_HELPER_SIGNATURE
} from './admin-helper-integrity.generated'

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
  data?: { serviceName?: string; managementId?: string; cleanupWarning?: string; helperPath?: string }
}

type ProgressCallback = (progress: GitHubRunnerProgress) => void

const FALLBACK_PACKAGE: RunnerPackage = {
  version: '2.335.1',
  filename: 'actions-runner-win-x64-2.335.1.zip',
  downloadUrl: 'https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-win-x64-2.335.1.zip',
  sha256: 'eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d'
}

export const ADMIN_HELPER = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Utf8WithBom = New-Object System.Text.UTF8Encoding($true)
$clearBytes = $null
$request = $null

function Write-AdminResult([bool]$Ok, [string]$Message, $Data = $null) {
  $payload = @{ ok = $Ok; message = $Message; data = $Data } | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($ResultPath, $payload, $Utf8NoBom)
}

function Assert-NoReparsePoint([string]$PathValue) {
  $probe = $PathValue
  while (-not (Test-Path -LiteralPath $probe)) {
    $parent = Split-Path -Parent $probe
    if (-not $parent -or $parent -eq $probe) { break }
    $probe = $parent
  }
  $item = Get-Item -LiteralPath $probe -Force -ErrorAction Stop
  while ($item) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "O caminho administrativo não pode atravessar links ou junções: $($item.FullName)"
    }
    $item = $item.Parent
  }
}

function Resolve-SafeRunnerPath([string]$Value) {
  if (-not $Value) { throw 'O diretório do runner não foi informado.' }
  $fullPath = [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
  $root = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\')
  if (-not $fullPath -or $fullPath -ieq $root) { throw 'Não é permitido usar a raiz do disco como diretório do runner.' }

  $programFilesX86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $blocked = @($env:windir, $env:ProgramFiles, $programFilesX86, $env:ProgramData) |
    Where-Object { $_ } |
    ForEach-Object { [System.IO.Path]::GetFullPath([string]$_).TrimEnd('\') }
  foreach ($blockedPath in $blocked) {
    if ($fullPath -ieq $blockedPath -or $fullPath.StartsWith($blockedPath + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "O runner não pode ser instalado ou removido dentro de uma pasta protegida do Windows: $blockedPath"
    }
  }
  Assert-NoReparsePoint $fullPath
  return $fullPath
}

function Get-RunnerIdentity([string]$InstallPath, [string]$ExpectedName, [string]$ExpectedTargetUrl) {
  $configPath = Join-Path $InstallPath 'config.cmd'
  $runnerPath = Join-Path $InstallPath '.runner'
  $servicePath = Join-Path $InstallPath '.service'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $runnerPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $servicePath -PathType Leaf)) {
    throw 'O diretório informado não contém uma instalação completa administrada do GitHub Actions Runner.'
  }

  $metadata = Get-Content -LiteralPath $runnerPath -Raw | ConvertFrom-Json
  $actualName = [string]$metadata.agentName
  $actualTarget = ([string]$metadata.gitHubUrl).TrimEnd('/')
  if (-not $actualName -or -not $actualTarget) { throw 'A identidade do runner local é inválida ou está incompleta.' }
  if ($ExpectedName -and $actualName -ine $ExpectedName) { throw 'O nome salvo não corresponde à identidade do runner instalado.' }
  if ($ExpectedTargetUrl -and $actualTarget -ine $ExpectedTargetUrl.TrimEnd('/')) { throw 'O repositório salvo não corresponde à identidade do runner instalado.' }

  $serviceName = (Get-Content -LiteralPath $servicePath -Raw).Trim()
  if ($serviceName -notmatch '^actions\.runner\.[a-zA-Z0-9._-]+$') { throw 'O nome do serviço registrado pelo runner é inválido.' }

  $escapedServiceName = $serviceName.Replace("'", "''")
  $service = Get-CimInstance Win32_Service -Filter "Name='$escapedServiceName'" -ErrorAction Stop
  if (-not $service) { throw 'O serviço registrado pelo runner não existe no Windows.' }
  $expectedExecutable = [System.IO.Path]::GetFullPath((Join-Path $InstallPath 'bin\RunnerService.exe'))
  $serviceCommand = ([string]$service.PathName).Trim()
  $executableMatch = [System.Text.RegularExpressions.Regex]::Match($serviceCommand, '^"([^"]+)"')
  $actualExecutable = if ($executableMatch.Success) { $executableMatch.Groups[1].Value } else { $serviceCommand.Split(' ')[0] }
  if ([System.IO.Path]::GetFullPath($actualExecutable) -ine $expectedExecutable -or -not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
    throw 'O executável do serviço não pertence ao diretório informado do runner.'
  }
  return @{ ServiceName = $serviceName; Name = $actualName; TargetUrl = $actualTarget }
}

function Assert-ProtectedMarkerAcl([string]$MarkerPath) {
  $acl = Get-Acl -LiteralPath $MarkerPath
  $ownerSid = $acl.Owner
  try { $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
  if ($ownerSid -notin @('S-1-5-18', 'S-1-5-32-544')) { throw 'O marcador administrativo do runner não pertence aos Administradores do Windows.' }

  $allowedSids = @('S-1-5-18', 'S-1-5-32-544')
  $writeMask = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::FullControl
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Value
    try { $sid = ([System.Security.Principal.NTAccount]$rule.IdentityReference).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        ($rule.FileSystemRights -band $writeMask) -ne 0 -and
        $sid -notin $allowedSids) {
      throw 'O marcador administrativo do runner pode ser modificado por uma conta não autorizada.'
    }
  }
}

function Confirm-ManagementMarker([string]$InstallPath, [string]$ManagementId, [bool]$AllowLegacyAdoption) {
  if ($ManagementId -notmatch '^[a-f0-9-]{36}$') { throw 'A identidade administrativa do runner é inválida.' }
  $markerPath = Join-Path $InstallPath '.controle-run-managed.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    if (-not $AllowLegacyAdoption) { throw 'Este runner não possui o marcador administrativo protegido. Reinstale ou adote novamente o runner.' }
    $markerJson = @{ version = 1; managementId = $ManagementId; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
    [System.IO.File]::WriteAllText($markerPath, $markerJson, $Utf8NoBom)
    & icacls.exe $markerPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível restringir o marcador administrativo do runner.' }
    & icacls.exe $markerPath /setowner '*S-1-5-32-544' /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível proteger o marcador administrativo do runner.' }
  }
  Assert-NoReparsePoint $markerPath
  Assert-ProtectedMarkerAcl $markerPath
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  if ([int]$marker.version -ne 1 -or [string]$marker.managementId -ine $ManagementId) {
    throw 'O marcador administrativo não corresponde ao cadastro local do runner.'
  }
  return $ManagementId
}

function Wait-RunnerService([string]$Name, [System.ServiceProcess.ServiceControllerStatus]$ExpectedStatus) {
  $service = Get-Service -Name $Name -ErrorAction Stop
  $service.WaitForStatus($ExpectedStatus, [TimeSpan]::FromSeconds(30))
  $service.Refresh()
  if ($service.Status -ne $ExpectedStatus) {
    throw "O serviço $Name não alcançou o estado $ExpectedStatus."
  }
}

function Start-RunnerService([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction Stop
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
    Start-Service -Name $Name
    Wait-RunnerService $Name ([System.ServiceProcess.ServiceControllerStatus]::Running)
  }
}

function Stop-RunnerService([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction Stop
  if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    Stop-Service -Name $Name -Force
    Wait-RunnerService $Name ([System.ServiceProcess.ServiceControllerStatus]::Stopped)
  }
}

function Restart-RunnerService([string]$Name) {
  Stop-RunnerService $Name
  Start-RunnerService $Name
}

try {
  for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path -LiteralPath $RequestPath); $attempt++) {
    Start-Sleep -Milliseconds 100
  }
  if (-not (Test-Path -LiteralPath $RequestPath)) {
    throw "A solicitação administrativa protegida não ficou disponível em: $RequestPath"
  }
  $encryptedBytes = [System.IO.File]::ReadAllBytes($RequestPath)
  Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue
  $clearBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $encryptedBytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::LocalMachine
  )
  $requestJson = [System.Text.Encoding]::UTF8.GetString($clearBytes)
  $request = $requestJson | ConvertFrom-Json

  if ($request.operation -eq 'install') {
    $installPath = Resolve-SafeRunnerPath ([string]$request.installPath)
    $zipPath = [System.IO.Path]::GetFullPath([string]$request.zipPath)
    if ([System.IO.Path]::GetExtension($zipPath) -ine '.zip' -or -not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
      throw 'O pacote do runner não é um arquivo ZIP válido.'
    }
    Assert-NoReparsePoint $zipPath
    $expectedPackageSha256 = ([string]$request.packageSha256).ToLowerInvariant()
    if ($expectedPackageSha256 -notmatch '^[a-f0-9]{64}$') { throw 'O SHA-256 esperado do pacote é inválido.' }
    $actualPackageSha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualPackageSha256 -ne $expectedPackageSha256) { throw 'O pacote do runner foi alterado depois da validação inicial.' }
    if (Test-Path -LiteralPath $installPath) {
      $existing = Get-ChildItem -LiteralPath $installPath -Force | Select-Object -First 1
      if ($existing) { throw 'A pasta de instalação precisa estar vazia.' }
    } else {
      New-Item -ItemType Directory -Path $installPath -Force | Out-Null
    }

    Expand-Archive -LiteralPath $zipPath -DestinationPath $installPath -Force
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
    $identity = Get-RunnerIdentity $installPath ([string]$request.name) ([string]$request.targetUrl)
    $serviceName = [string]$identity.ServiceName
    $managementId = Confirm-ManagementMarker $installPath ([string]$request.managementId) $true
    Start-RunnerService $serviceName
    Write-AdminResult $true 'Runner instalado e serviço iniciado.' @{ serviceName = $serviceName; managementId = $managementId }
  }
  elseif ($request.operation -eq 'service') {
    $installPath = Resolve-SafeRunnerPath ([string]$request.installPath)
    $identity = Get-RunnerIdentity $installPath ([string]$request.expectedName) ([string]$request.expectedTargetUrl)
    $serviceName = [string]$identity.ServiceName
    if ($request.serviceName -and $serviceName -ine [string]$request.serviceName) { throw 'O serviço salvo não corresponde ao runner instalado.' }
    $managementId = Confirm-ManagementMarker $installPath ([string]$request.managementId) ([bool]$request.allowLegacyAdoption)
    if ($request.action -eq 'start') { Start-RunnerService $serviceName }
    elseif ($request.action -eq 'stop') { Stop-RunnerService $serviceName }
    elseif ($request.action -eq 'restart') { Restart-RunnerService $serviceName }
    else { throw 'Ação de serviço inválida.' }
    Write-AdminResult $true 'Ação concluída.' @{ serviceName = $serviceName; managementId = $managementId }
  }
  elseif ($request.operation -eq 'configure-deploy') {
    $installPath = Resolve-SafeRunnerPath ([string]$request.installPath)
    $identity = Get-RunnerIdentity $installPath ([string]$request.expectedName) ([string]$request.expectedTargetUrl)
    $managementId = Confirm-ManagementMarker $installPath ([string]$request.managementId) ([bool]$request.allowLegacyAdoption)
    $deployDir = Join-Path $installPath '.controle-run'
    New-Item -ItemType Directory -Path $deployDir -Force | Out-Null
    $scriptPath = Join-Path $deployDir 'deploy.ps1'
    $configPath = Join-Path $deployDir 'deployment.json'
    [System.IO.File]::WriteAllText($scriptPath, [string]$request.deployScript, $Utf8WithBom)
    [System.IO.File]::WriteAllText($configPath, [string]$request.configJson, $Utf8WithBom)

    $runnerEnvPath = Join-Path $installPath '.env'
    $runnerEnv = @()
    if (Test-Path -LiteralPath $runnerEnvPath) { $runnerEnv = @(Get-Content -LiteralPath $runnerEnvPath) }
    $runnerEnv = @($runnerEnv | Where-Object { $_ -notmatch '^CONTROLE_RUN_DEPLOY_SCRIPT=' })
    $runnerEnv += "CONTROLE_RUN_DEPLOY_SCRIPT=$scriptPath"
    [System.IO.File]::WriteAllLines($runnerEnvPath, [string[]]$runnerEnv, $Utf8NoBom)

    $serviceAccount = [string]$request.serviceAccount
    if ($serviceAccount) {
      & icacls.exe $deployDir /grant:r "\${serviceAccount}:(OI)(CI)M" /T /C | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Não foi possível conceder acesso do executor ao diretório de deploy.' }
    }

    $serviceName = [string]$identity.ServiceName
    if ($request.serviceName -and $serviceName -ine [string]$request.serviceName) { throw 'O serviço salvo não corresponde ao runner instalado.' }
    Restart-RunnerService $serviceName
    Write-AdminResult $true 'Deploy automático preparado e runner reiniciado.' @{ serviceName = $serviceName; helperPath = $scriptPath; managementId = $managementId }
  }
  elseif ($request.operation -eq 'remove') {
    $installPath = Resolve-SafeRunnerPath ([string]$request.installPath)
    $identity = Get-RunnerIdentity $installPath ([string]$request.expectedName) ([string]$request.expectedTargetUrl)
    if ($request.serviceName -and [string]$identity.ServiceName -ine [string]$request.serviceName) { throw 'O serviço salvo não corresponde ao runner instalado.' }
    $managementId = Confirm-ManagementMarker $installPath ([string]$request.managementId) ([bool]$request.allowLegacyAdoption)
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

function windowsPowerShellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function validateAdminHelper() {
  const adminDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'admin')
    : path.join(app.getAppPath(), 'build-resources', 'admin')
  const helperPath = path.join(adminDirectory, 'runner-admin-helper.ps1')
  const [realDirectory, realHelper, helperStat] = await Promise.all([
    fs.realpath(adminDirectory),
    fs.realpath(helperPath),
    fs.lstat(helperPath)
  ]).catch(() => { throw new Error('O helper administrativo protegido não foi encontrado. Reinstale o Controle Run.') })
  const relative = path.relative(realDirectory, realHelper)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || helperStat.isSymbolicLink()) {
    throw new Error('O caminho do helper administrativo foi adulterado.')
  }

  const content = await fs.readFile(realHelper)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const signatureValid = verify(
    'sha256',
    content,
    createPublicKey(ADMIN_HELPER_PUBLIC_KEY),
    Buffer.from(ADMIN_HELPER_SIGNATURE, 'base64')
  )
  if (sha256 !== ADMIN_HELPER_SHA256 || !signatureValid) {
    throw new Error('A assinatura do helper administrativo é inválida. Reinstale o Controle Run antes de continuar.')
  }
  return { helperPath: realHelper, sha256 }
}

export async function protectAdminRequest(requestPath: string, request: unknown) {
  await fs.mkdir(path.dirname(requestPath), { recursive: true })
  const writingPath = `${requestPath}.${randomUUID()}.writing`
  const protector = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$envelope = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
$bytes = [System.Convert]::FromBase64String([string]$envelope.payloadBase64)
$protected = [System.Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::LocalMachine
)
[System.IO.File]::WriteAllBytes([string]$envelope.outputPath, $protected)
[Array]::Clear($bytes, 0, $bytes.Length)
`.trim()
  try {
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', protector], {
      input: JSON.stringify({
        outputPath: writingPath,
        payloadBase64: Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
      })
    })
    if (result.code !== 0) throw new Error(`Não foi possível proteger a solicitação administrativa. ${result.stderr.trim()}`)
    const stat = await fs.stat(writingPath).catch(() => null)
    if (!stat?.isFile() || stat.size === 0) {
      const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join(' ')
      throw new Error(`A solicitação administrativa protegida não foi gravada corretamente.${detail ? ` ${detail}` : ''}`)
    }
    await fs.rename(writingPath, requestPath)
    await fs.access(requestPath)
  } catch (error) {
    await fs.unlink(writingPath).catch(() => undefined)
    throw error
  }
}

export function adminExchangePaths(basePath: string, operationId: string) {
  const exchangeDir = path.join(basePath, 'runner-admin-exchange')
  return {
    exchangeDir,
    requestPath: path.join(exchangeDir, `${operationId}.request.bin`),
    resultPath: path.join(exchangeDir, `${operationId}.result.json`)
  }
}

async function runElevated(request: unknown): Promise<AdminResult> {
  requireWindows()
  const helper = await validateAdminHelper()
  const powershellPath = windowsPowerShellPath()
  await fs.access(powershellPath).catch(() => { throw new Error('O Windows PowerShell protegido não foi encontrado no System32.') })
  const operationId = randomUUID()
  const { exchangeDir, requestPath, resultPath } = adminExchangePaths(app.getPath('userData'), operationId)
  await fs.mkdir(exchangeDir, { recursive: true })
  await protectAdminRequest(requestPath, request)
  const protectedRequest = await fs.stat(requestPath).catch(() => null)
  if (!protectedRequest?.isFile() || protectedRequest.size === 0) {
    throw new Error('A solicitação administrativa não ficou disponível para o processo elevado.')
  }
  const elevatedBootstrap = String.raw`
$ErrorActionPreference = 'Stop'
$helperBytes = [System.IO.File]::ReadAllBytes($env:CONTROLE_RUN_HELPER)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $actualHash = ([System.BitConverter]::ToString($sha256.ComputeHash($helperBytes))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
if ($actualHash -ne $env:CONTROLE_RUN_HELPER_SHA256) { throw 'A integridade do helper administrativo mudou durante a elevação.' }
$helperText = [System.Text.Encoding]::UTF8.GetString($helperBytes).TrimStart([char]0xFEFF)
$helperScript = [System.Management.Automation.ScriptBlock]::Create($helperText)
& $helperScript -RequestPath $env:CONTROLE_RUN_REQUEST -ResultPath $env:CONTROLE_RUN_RESULT
`.trim()
  const encodedBootstrap = Buffer.from(elevatedBootstrap, 'utf16le').toString('base64')
  const launcher = String.raw`
$arguments = @(
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', $env:CONTROLE_RUN_ELEVATED_BOOTSTRAP
)
$process = Start-Process -FilePath $env:CONTROLE_RUN_POWERSHELL -ArgumentList $arguments -Verb RunAs -Wait -PassThru -WindowStyle Hidden
exit $process.ExitCode
`.trim()
  try {
    const elevated = await runProcess(powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher], {
      env: {
        ...process.env,
        CONTROLE_RUN_HELPER: helper.helperPath,
        CONTROLE_RUN_HELPER_SHA256: helper.sha256,
        CONTROLE_RUN_ELEVATED_BOOTSTRAP: encodedBootstrap,
        CONTROLE_RUN_POWERSHELL: powershellPath,
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

export function isRunnerVersionProbeLog(content: string) {
  return /CommandLineParser].*arg:\s*version|CommandSettings].*Flag 'version':\s*'True'/i.test(content)
}

async function latestRunnerLog(installPath: string) {
  const diagPath = path.join(installPath, '_diag')
  const files = await fs.readdir(diagPath).catch(() => [])
  const candidates = files.filter((file) => /^Runner_.*\.log$/i.test(file)).sort().reverse().slice(0, 100)
  for (const candidate of candidates) {
    const filePath = path.join(diagPath, candidate)
    const content = await fs.readFile(filePath, 'utf8').catch(() => '')
    if (!content || isRunnerVersionProbeLog(content)) continue
    const stat = await fs.stat(filePath).catch(() => null)
    return { content: content.slice(-250_000), modifiedAt: stat?.mtime.toISOString() }
  }
  return null
}

async function actualRunnerVersion(config: GitHubRunnerConfig) {
  const executable = path.join(config.installPath, 'bin', 'Runner.Listener.exe')
  try {
    await fs.access(executable)
    const result = await runProcess('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:CONTROLE_RUN_VERSION_FILE).ProductVersion"
    ], { env: { ...process.env, CONTROLE_RUN_VERSION_FILE: executable } })
    const version = result.stdout.trim().match(/\d+\.\d+\.\d+/)?.[0]
    return version || config.installedVersion
  } catch {
    return config.installedVersion
  }
}

let pm2CommandCache: string | null | undefined
let gitCommandCache: string | null | undefined

async function resolvePm2Command() {
  if (pm2CommandCache !== undefined) return pm2CommandCache || undefined
  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'pm2.cmd') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm', 'pm2.cmd') : ''
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { await fs.access(candidate); pm2CommandCache = candidate; return candidate } catch { /* tenta o próximo */ }
  }
  const located = await runProcess('where.exe', ['pm2.cmd']).catch(() => null)
  const first = located?.code === 0 ? located.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) : undefined
  pm2CommandCache = first || null
  return first
}

async function resolveGitCommand() {
  if (gitCommandCache !== undefined) return gitCommandCache || undefined
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe') : ''
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { await fs.access(candidate); gitCommandCache = candidate; return candidate } catch { /* tenta o próximo */ }
  }
  const located = await runProcess('where.exe', ['git.exe']).catch(() => null)
  const first = located?.code === 0 ? located.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) : undefined
  gitCommandCache = first || null
  return first
}

async function runnerView(config: GitHubRunnerConfig, settings: Settings, commands?: { gitCommand: string; pm2Command: string }): Promise<GitHubRunnerView> {
  try {
    const name = await serviceName(config)
    const status = await serviceStatus(name)
    const [log, installedVersion, deployment] = await Promise.all([
      latestRunnerLog(config.installPath),
      actualRunnerVersion(config),
      inspectRunnerDeployment(config, settings, commands)
    ])
    const connected = status === 'running' && Boolean(log && /Listening for Jobs|Runner connect complete|Message listener created/i.test(log.content))
    return {
      ...config,
      installedVersion,
      deployment,
      serviceName: name || config.serviceName,
      serviceStatus: status,
      connectionStatus: connected ? 'connected' : status === 'running' ? 'unknown' : 'offline',
      latestLogAt: log?.modifiedAt
    }
  } catch (error) {
    return {
      ...config,
      deployment: { state: 'invalid' },
      serviceStatus: 'unknown',
      connectionStatus: 'unknown',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function getGitHubRunnerState(): Promise<GitHubRunnerState> {
  requireWindows()
  const settings = await loadSettings()
  const [gitCommand, pm2Command] = await Promise.all([resolveGitCommand(), resolvePm2Command()])
  const commands = gitCommand && pm2Command ? { gitCommand, pm2Command } : undefined
  return { runners: await Promise.all(Object.values(settings.githubRunners).map((runner) => runnerView(runner, settings, commands))) }
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
  const managementId = randomUUID()
  const id = createHash('sha1').update(`${normalized.targetUrl}|${normalized.name}|${normalized.installPath}`.toLowerCase()).digest('hex').slice(0, 12)
  const routingLabel = runnerRoutingLabel({ id })
  const effectiveLabels = [...new Map([...normalized.labels, routingLabel].map((label) => [label.toLowerCase(), label])).values()]
  if (effectiveLabels.length > 100) throw new Error('O runner aceita no máximo 100 labels, incluindo a label exclusiva criada pelo Controle Run.')
  progress({ stage: 'elevating', message: 'Aguardando autorização administrativa do Windows...' })
  const admin = await runElevated({
    operation: 'install',
    zipPath,
    packageSha256: pkg.sha256,
    installPath: normalized.installPath,
    targetUrl: normalized.targetUrl,
    registrationToken: draft.registrationToken.trim(),
    managementId,
    name: normalized.name,
    workFolder: normalized.workFolder,
    labels: effectiveLabels,
    windowsAccount: normalized.windowsAccount,
    windowsPassword: draft.serviceAccount === 'custom' ? draft.windowsPassword : undefined
  })
  progress({ stage: 'configuring', message: 'Salvando o cadastro local do runner...' })
  settings.githubRunners[id] = {
    id,
    name: normalized.name,
    scope: draft.scope,
    targetUrl: normalized.targetUrl,
    installPath: normalized.installPath,
    workFolder: normalized.workFolder,
    labels: effectiveLabels,
    routingLabel,
    serviceAccount: normalized.windowsAccount,
    serviceName: admin.data?.serviceName,
    managementId: admin.data?.managementId || managementId,
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
  const managementId = runner.managementId || randomUUID()
  const admin = await runElevated({
    operation: 'service',
    action,
    installPath: runner.installPath,
    serviceName: runner.serviceName,
    expectedName: runner.name,
    expectedTargetUrl: runner.targetUrl,
    managementId,
    allowLegacyAdoption: !runner.managementId
  })
  if (!runner.managementId && admin.data?.managementId) {
    runner.managementId = admin.data.managementId
    await saveSettings(settings)
  }
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

export async function prepareGitHubRunnerDeployment(id: string, overwriteWorkflow = false) {
  requireWindows()
  const settings = await loadSettings()
  const runner = settings.githubRunners[id]
  if (!runner) throw new Error('Runner não encontrado.')
  if (runner.scope !== 'repository') throw new Error('O deploy automático isolado exige um runner com escopo de repositório.')
  if (!runner.projectGroupId) throw new Error('Associe o runner a um projeto antes de preparar o deploy.')
  if (runner.serviceAccount.toUpperCase() === 'NT AUTHORITY\\NETWORK SERVICE') {
    throw new Error('Este runner usa Network Service. Reinstale-o usando a conta Windows que administra os processos PM2.')
  }
  const projectPath = projectRootForGroup(settings, runner.projectGroupId)
  if (!projectPath) throw new Error('A pasta do projeto associado não está mais cadastrada.')
  const services = servicesForGroup(settings, runner.projectGroupId)
  if (!services.length) throw new Error('O projeto associado não possui serviços configurados.')
  const repository = repositoryFromTargetUrl(runner.targetUrl)
  const localRepository = await readProjectGitHubRepository(projectPath)
  if (repository.toLowerCase() !== localRepository.toLowerCase()) {
    throw new Error(`O runner pertence a ${repository}, mas a pasta associada é um clone de ${localRepository}.`)
  }
  const [gitCommand, pm2Command] = await Promise.all([resolveGitCommand(), resolvePm2Command()])
  if (!gitCommand) throw new Error('O executável git.exe não foi encontrado para a conta atual do Windows.')
  if (!pm2Command) throw new Error('O comando pm2.cmd não foi encontrado para a conta atual do Windows.')

  const routingLabel = runnerRoutingLabel(runner)
  if (!runner.routingLabel || !runner.labels.some((label) => label.toLowerCase() === routingLabel)) {
    throw new Error(`Este runner foi criado antes do roteamento exclusivo. Reinstale-o pelo Controle Run para registrar a label ${routingLabel} no GitHub.`)
  }
  const workflow = await writeStandardWorkflow(projectPath, overwriteWorkflow, routingLabel)
  const configuredAt = new Date().toISOString()
  const config = {
    version: 2 as const,
    repository,
    projectPath,
    services: services.map((service) => ({
      name: service.pm2Name,
      relativePath: path.relative(projectPath, service.path) || '.',
      buildScript: service.buildScript,
      buildOnDeploy: Boolean(service.buildScript && service.buildOnDeploy),
      installDependenciesOnDeploy: service.installDependenciesOnDeploy !== false
    })),
    gitCommand,
    pm2Command,
    configuredAt
  }
  const paths = runnerDeploymentPaths(runner.installPath)
  const managementId = runner.managementId || randomUUID()
  const admin = await runElevated({
    operation: 'configure-deploy',
    installPath: runner.installPath,
    serviceName: runner.serviceName,
    expectedName: runner.name,
    expectedTargetUrl: runner.targetUrl,
    managementId,
    allowLegacyAdoption: !runner.managementId,
    serviceAccount: runner.serviceAccount,
    deployScript: CONTROL_RUN_DEPLOY_SCRIPT,
    configJson: JSON.stringify(config, null, 2)
  })
  if (!runner.managementId && admin.data?.managementId) {
    runner.managementId = admin.data.managementId
    await saveSettings(settings)
  }
  await fs.access(paths.scriptPath)
  return {
    state: await getGitHubRunnerState(),
    repository,
    projectPath,
    workflowPath: workflow.path,
    workflowCreated: workflow.created
  }
}

export async function openGitHubRunnerWorkflow(id: string) {
  const settings = await loadSettings()
  const runner = settings.githubRunners[id]
  if (!runner?.projectGroupId) throw new Error('Runner ou projeto associado não encontrado.')
  const projectPath = projectRootForGroup(settings, runner.projectGroupId)
  if (!projectPath) throw new Error('A pasta do projeto associado não está mais cadastrada.')
  const workflow = path.join(projectPath, '.github', 'workflows', 'controle-run.yml')
  await fs.access(workflow).catch(() => { throw new Error('O workflow ainda não foi criado para este projeto.') })
  shell.showItemInFolder(workflow)
}

export async function removeGitHubRunner(id: string, removalToken: string) {
  if (!removalToken.trim()) throw new Error('Informe o token temporário de remoção fornecido pelo GitHub.')
  const settings = await loadSettings()
  const runner = settings.githubRunners[id]
  if (!runner) throw new Error('Runner não encontrado.')
  const managementId = runner.managementId || randomUUID()
  const result = await runElevated({
    operation: 'remove',
    installPath: runner.installPath,
    serviceName: runner.serviceName,
    expectedName: runner.name,
    expectedTargetUrl: runner.targetUrl,
    managementId,
    allowLegacyAdoption: !runner.managementId,
    removalToken: removalToken.trim()
  })
  delete settings.githubRunners[id]
  await saveSettings(settings)
  if (result.data?.cleanupWarning) console.warn('Runner removido, mas a pasta não pôde ser apagada:', result.data.cleanupWarning)
  return getGitHubRunnerState()
}
