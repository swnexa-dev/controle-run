import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubRunnerConfig, GitHubRunnerDeploymentView, ProjectConfig } from '../shared/types'
import { projectId } from './discovery'
import type { Settings } from './store'

export interface RunnerDeploymentConfigFile {
  version: 2
  repository: string
  projectPath: string
  services: Array<{
    name: string
    relativePath: string
    buildScript?: string
    buildOnDeploy: boolean
    installDependenciesOnDeploy: boolean
  }>
  gitCommand: string
  pm2Command: string
  configuredAt: string
}

interface RunnerDeploymentResultFile {
  repository?: string
  commit?: string
  status?: 'success' | 'failed'
  message?: string
  finishedAt?: string
}

export const CHECKOUT_ACTION_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803'

export function runnerRoutingLabel(runner: Pick<GitHubRunnerConfig, 'id' | 'routingLabel'>) {
  const label = runner.routingLabel || `controle-run-${runner.id}`
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(label)) throw new Error('A label exclusiva do runner é inválida.')
  return label.toLowerCase()
}

export function buildControlRunWorkflow(routingLabel: string) {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(routingLabel)) throw new Error('A label de roteamento do workflow é inválida.')
  return `name: Controle Run Deploy

on:
  push:
    branches:
      - main
      - master
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: controle-run-\${{ github.repository }}
  cancel-in-progress: false

jobs:
  deploy:
    name: Atualizar servidor
    runs-on: [self-hosted, Windows, X64, ${routingLabel}]
    timeout-minutes: 30

    steps:
      - name: Baixar versão enviada
        uses: actions/checkout@${CHECKOUT_ACTION_SHA} # v6.1.0
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Atualizar projeto pelo Controle Run
        shell: powershell
        run: |
          $deployCandidates = @()
          if ($env:CONTROLE_RUN_DEPLOY_SCRIPT) {
            $deployCandidates += [string]$env:CONTROLE_RUN_DEPLOY_SCRIPT
          }

          if ($env:RUNNER_TEMP) {
            $runnerWorkDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($env:RUNNER_TEMP))
            $runnerDirectory = Split-Path -Parent $runnerWorkDirectory
            $deployCandidates += Join-Path $runnerDirectory '.controle-run\\deploy.ps1'
          }

          $deployScript = $deployCandidates |
            Select-Object -Unique |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1

          if (-not $deployScript) {
            throw 'O executor local do Controle Run nao foi encontrado. Abra o app no servidor e clique em Reconfigurar.'
          }

          & $deployScript \`
            -Repository '\${{ github.repository }}' \`
            -SourcePath "$env:GITHUB_WORKSPACE" \`
            -Commit "$env:GITHUB_SHA"
`
}

export const CONTROL_RUN_WORKFLOW = buildControlRunWorkflow('controle-run-runner-especifico')

export const CONTROL_RUN_DEPLOY_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Repository,
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$Commit
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ConfigPath = Join-Path $PSScriptRoot 'deployment.json'
$StatusPath = Join-Path $PSScriptRoot 'last-deploy.json'
$TransactionPath = Join-Path $PSScriptRoot 'deploy-transaction.json'
$LockPath = Join-Path $PSScriptRoot 'deploy.lock'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$GitCommand = 'git.exe'

function Write-AtomicJson([string]$Destination, $Value) {
  $temporary = "$Destination.$PID.tmp"
  $payload = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($temporary, $payload, $Utf8NoBom)
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    $backup = "$Destination.$PID.bak"
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    [System.IO.File]::Replace($temporary, $Destination, $backup)
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::Move($temporary, $Destination)
  }
}

function Write-Status([string]$Status, [string]$Message) {
  Write-AtomicJson $StatusPath @{
    repository = $Repository
    commit = $Commit
    status = $Status
    message = $Message
    finishedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Enter-DeployLock([int]$TimeoutSeconds = 120) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    try {
      return [System.IO.File]::Open(
        $LockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
    }
    catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw 'Outro deploy deste runner ainda está em andamento. Aguarde a conclusão e tente novamente.'
      }
      Start-Sleep -Seconds 1
    }
  }
}

function Write-Transaction($Config, [string]$PreviousCommit, [string]$TargetCommit, [string]$Phase) {
  Write-AtomicJson $TransactionPath @{
    version = 1
    repository = $Repository
    projectPath = [System.IO.Path]::GetFullPath([string]$Config.projectPath)
    previousCommit = $PreviousCommit
    targetCommit = $TargetCommit
    phase = $Phase
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Remove-Transaction {
  Remove-Item -LiteralPath $TransactionPath -Force -ErrorAction SilentlyContinue
}

function Invoke-Git([string[]]$Arguments) {
  $preference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $script:GitCommand @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $preference
  }
  if ($exitCode -ne 0) {
    throw "Git falhou (código $exitCode): $($output.Trim())"
  }
  return $output.Trim()
}

function Restart-Services($Config) {
  foreach ($service in @($Config.services)) {
    $serviceName = [string]$service.name
    Write-Host "[Controle Run] Reiniciando $serviceName..."
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $output = & ([string]$Config.pm2Command) restart ([string]$serviceName) --update-env 2>&1 | Out-String
      $exitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $preference
    }
    if ($exitCode -ne 0) {
      throw "PM2 não conseguiu reiniciar $serviceName (código $exitCode): $($output.Trim())"
    }
    if ($output.Trim()) { Write-Host $output.Trim() }
  }
}

function Invoke-External([string]$File, [string[]]$Arguments, [string]$Description, [string]$WorkingDirectory) {
  $preference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = & $File @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $preference
  }
  if ($exitCode -ne 0) {
    throw "$Description falhou (código $exitCode): $($output.Trim())"
  }
  if ($output.Trim()) { Write-Host $output.Trim() }
}

function Build-Services($Config, [string]$FromCommit, [string]$ToCommit) {
  $target = [System.IO.Path]::GetFullPath([string]$Config.projectPath)
  $targetPrefix = $target.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $npmCommand = Join-Path (Split-Path -Parent ([string]$Config.pm2Command)) 'npm.cmd'

  foreach ($service in @($Config.services)) {
    if (-not [bool]$service.buildOnDeploy) { continue }
    $buildScript = [string]$service.buildScript
    if (-not $buildScript) { throw "O serviço $($service.name) está com build automático ativo, mas não possui um script de build." }
    if ($buildScript -notmatch '^[a-zA-Z0-9:_.-]+$') { throw "O script de build configurado para $($service.name) é inválido." }

    $servicePath = [System.IO.Path]::GetFullPath((Join-Path $target ([string]$service.relativePath)))
    if ($servicePath -ine $target -and -not $servicePath.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "O caminho de build de $($service.name) está fora do projeto publicado."
    }
    if (-not (Test-Path -LiteralPath (Join-Path $servicePath 'package.json') -PathType Leaf)) {
      throw "O package.json de $($service.name) não foi encontrado."
    }
    if (-not (Test-Path -LiteralPath $npmCommand -PathType Leaf)) {
      throw 'O npm.cmd não foi encontrado ao lado do PM2. Reinstale o Node.js ou o PM2 para a conta do runner.'
    }

    $lockPath = Join-Path $servicePath 'package-lock.json'
    $needsInstall = -not (Test-Path -LiteralPath (Join-Path $servicePath 'node_modules') -PathType Container)
    if ([bool]$service.installDependenciesOnDeploy -and (Test-Path -LiteralPath $lockPath -PathType Leaf) -and $FromCommit -and $ToCommit) {
      $relativeLock = if ([string]$service.relativePath -eq '.') { 'package-lock.json' } else { ([string]$service.relativePath).Replace('\', '/') + '/package-lock.json' }
      $lockChanges = Invoke-Git @('-C', $target, 'diff', '--name-only', $FromCommit, $ToCommit, '--', $relativeLock)
      if ($lockChanges) { $needsInstall = $true }
    }

    if ($needsInstall) {
      Write-Host "[Controle Run] Instalando dependências de $($service.name)..."
      if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
        Invoke-External $npmCommand @('ci') "A instalação de dependências de $($service.name)" $servicePath
      } else {
        Invoke-External $npmCommand @('install') "A instalação de dependências de $($service.name)" $servicePath
      }
    }

    Write-Host "[Controle Run] Executando npm run $buildScript em $($service.name)..."
    Invoke-External $npmCommand @('run', $buildScript) "O build de $($service.name)" $servicePath
  }
}

function Recover-InterruptedDeployment($Config) {
  if (-not (Test-Path -LiteralPath $TransactionPath -PathType Leaf)) { return }

  try {
    $transaction = Get-Content -LiteralPath $TransactionPath -Raw | ConvertFrom-Json
  } catch {
    throw 'Foi encontrado um diário de deploy inválido. Não é seguro continuar; reconfigure o deploy pelo Controle Run.'
  }

  if ([string]$transaction.repository -ine $Repository) {
    throw 'O diário pendente pertence a outro repositório. Não é seguro continuar.'
  }
  $configuredTarget = [System.IO.Path]::GetFullPath([string]$Config.projectPath)
  $transactionTarget = [System.IO.Path]::GetFullPath([string]$transaction.projectPath)
  if ($configuredTarget -ine $transactionTarget) {
    throw 'O diário pendente aponta para outra pasta de projeto. Não é seguro continuar.'
  }
  if ([string]$transaction.phase -eq 'committed') {
    Remove-Transaction
    return
  }

  $previous = [string]$transaction.previousCommit
  $interruptedTarget = [string]$transaction.targetCommit
  if ($previous -notmatch '^[a-f0-9]{40}$') {
    throw 'O diário pendente não contém um commit anterior válido. A recuperação automática foi interrompida.'
  }

  Write-Warning '[Controle Run] Um deploy anterior foi interrompido. Restaurando a versão estável antes de continuar...'
  Invoke-Git @('-C', $configuredTarget, 'reset', '--hard', $previous) | Out-Null
  Build-Services $Config $interruptedTarget $previous
  Restart-Services $Config
  Write-Status 'failed' 'O deploy anterior foi interrompido e a versão estável foi restaurada automaticamente.'
  Remove-Transaction
}

$previousCommit = $null
$transactionStarted = $false
$committed = $false
$config = $null
$deployLock = $null

try {
  $deployLock = Enter-DeployLock

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'A configuração local de deploy não foi encontrada. Prepare o deploy novamente no Controle Run.'
  }

  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ([int]$config.version -ne 2) {
    throw 'A configuração de deploy está desatualizada. Abra o Controle Run e clique em Reconfigurar neste runner.'
  }
  if ([string]$config.repository -ine $Repository) {
    throw "O runner está associado a $($config.repository), mas recebeu uma tarefa de $Repository."
  }
  $GitCommand = [string]$config.gitCommand

  $source = [System.IO.Path]::GetFullPath($SourcePath)
  $target = [System.IO.Path]::GetFullPath([string]$config.projectPath)
  if ($source -eq $target) { throw 'A pasta temporária do runner não pode ser a mesma pasta publicada.' }
  if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) { throw 'O checkout temporário do GitHub não contém um repositório Git.' }
  if (-not (Test-Path -LiteralPath (Join-Path $target '.git'))) { throw 'A pasta publicada não contém um clone Git válido.' }
  if (-not (Test-Path -LiteralPath $GitCommand -PathType Leaf)) { throw 'O executável do Git configurado não foi encontrado.' }
  if (-not (Test-Path -LiteralPath ([string]$config.pm2Command) -PathType Leaf)) { throw 'O comando PM2 configurado não foi encontrado.' }

  Recover-InterruptedDeployment $config

  $sourceCommit = Invoke-Git @('-C', $source, 'rev-parse', 'HEAD')
  if ($sourceCommit -ine $Commit) { throw "O checkout recebido ($sourceCommit) não corresponde ao commit solicitado ($Commit)." }

  $trackedChanges = Invoke-Git @('-C', $target, 'status', '--porcelain', '--untracked-files=no')
  if ($trackedChanges) {
    throw 'Existem alterações locais em arquivos controlados pelo Git. Reverta ou salve essas alterações antes do deploy automático.'
  }

  $previousCommit = Invoke-Git @('-C', $target, 'rev-parse', 'HEAD')
  Write-Host "[Controle Run] Atualizando $target para $Commit..."
  $fetchOutput = Invoke-Git @('-C', $target, 'fetch', '--force', '--no-tags', $source, 'HEAD')
  if ($fetchOutput) { Write-Host $fetchOutput }
  $fetchedCommit = Invoke-Git @('-C', $target, 'rev-parse', 'FETCH_HEAD')
  if ($fetchedCommit -ine $Commit) { throw "O commit recebido pelo clone local ($fetchedCommit) não corresponde ao esperado ($Commit)." }
  Write-Transaction $config $previousCommit $Commit 'prepared'
  $transactionStarted = $true
  $resetOutput = Invoke-Git @('-C', $target, 'reset', '--hard', 'FETCH_HEAD')
  if ($resetOutput) { Write-Host $resetOutput }
  Write-Transaction $config $previousCommit $Commit 'updated'

  Build-Services $config $previousCommit $Commit
  Write-Transaction $config $previousCommit $Commit 'built'
  Restart-Services $config
  Write-Transaction $config $previousCommit $Commit 'committed'
  $committed = $true
  Remove-Transaction
  $transactionStarted = $false
  Write-Status 'success' 'Projeto atualizado, builds concluídos e serviços reiniciados.'
  Write-Host '[Controle Run] Deploy concluído com sucesso.'
}
catch {
  $message = $_.Exception.Message
  if ($transactionStarted -and -not $committed -and $previousCommit -and $previousCommit -match '^[a-f0-9]{40}$' -and $config) {
    try {
      Write-Warning '[Controle Run] O deploy falhou. Restaurando a versão anterior...'
      Invoke-Git @('-C', ([string]$config.projectPath), 'reset', '--hard', $previousCommit) | Out-Null
      Build-Services $config $Commit $previousCommit
      Restart-Services $config
      Remove-Transaction
      $transactionStarted = $false
      $message = "$message A versão anterior foi restaurada."
    }
    catch {
      $message = "$message A restauração automática também falhou: $($_.Exception.Message)"
    }
  }
  if ($deployLock) { try { Write-Status 'failed' $message } catch { } }
  throw $message
}
finally {
  if ($deployLock) { $deployLock.Dispose() }
}
`

export function runnerDeploymentPaths(installPath: string) {
  const directory = path.join(installPath, '.controle-run')
  return {
    directory,
    scriptPath: path.join(directory, 'deploy.ps1'),
    configPath: path.join(directory, 'deployment.json'),
    statusPath: path.join(directory, 'last-deploy.json')
  }
}

export function workflowPath(projectPath: string) {
  return path.join(projectPath, '.github', 'workflows', 'controle-run.yml')
}

export function githubRepositoryFromRemote(value: string) {
  const remote = value.trim()
  const scpMatch = remote.match(/^git@github\.com:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i)
  if (scpMatch) return `${scpMatch[1]}/${scpMatch[2]}`
  let url: URL
  try { url = new URL(remote) } catch { throw new Error('O remote origin do projeto não é uma URL válida do GitHub.') }
  if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('O projeto precisa usar um remote origin hospedado no github.com.')
  }
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (segments.length !== 2) throw new Error('O remote origin não identifica um repositório GitHub válido.')
  const owner = segments[0]
  const repository = segments[1].replace(/\.git$/i, '')
  if (![owner, repository].every((segment) => /^[a-zA-Z0-9_.-]+$/.test(segment))) throw new Error('O remote origin contém um nome inválido.')
  return `${owner}/${repository}`
}

export function repositoryFromTargetUrl(targetUrl: string) {
  return githubRepositoryFromRemote(targetUrl)
}

export function projectRootForGroup(settings: Settings, groupId: string) {
  const configured = settings.projectPaths.find((projectPath) => projectId(projectPath) === groupId)
  if (configured) return path.resolve(configured)
  const service = Object.values(settings.projects).find((project) => project.groupId === groupId)
  return service?.groupPath ? path.resolve(service.groupPath) : undefined
}

export function servicesForGroup(settings: Settings, groupId: string): ProjectConfig[] {
  const priority = { backend: 0, root: 1, frontend: 2 }
  return Object.values(settings.projects)
    .filter((project) => project.groupId === groupId)
    .sort((a, b) => priority[a.serviceType] - priority[b.serviceType])
}

export async function readProjectGitHubRepository(projectPath: string) {
  const config = await fs.readFile(path.join(projectPath, '.git', 'config'), 'utf8').catch(() => '')
  if (!config) throw new Error('A pasta associada precisa ser um clone Git e conter .git/config.')
  const originSection = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\r?\n\[|$)/i)?.[1]
  const originUrl = originSection?.match(/^\s*url\s*=\s*(.+?)\s*$/im)?.[1]
  if (!originUrl) throw new Error('O clone não possui um remote origin configurado.')
  return githubRepositoryFromRemote(originUrl)
}

export async function writeStandardWorkflow(projectPath: string, overwrite = false, routingLabel = 'controle-run-runner-especifico') {
  const workflow = buildControlRunWorkflow(routingLabel)
  const destination = workflowPath(projectPath)
  const current = await fs.readFile(destination, 'utf8').catch(() => null)
  if (current !== null && normalizeText(current) !== normalizeText(workflow) && !overwrite) {
    throw new Error('Já existe um workflow controle-run.yml diferente. Confirme a substituição para continuar.')
  }
  await fs.mkdir(path.dirname(destination), { recursive: true })
  if (current !== null && normalizeText(current) === normalizeText(workflow)) return { path: destination, created: false }
  const temporary = `${destination}.writing`
  await fs.writeFile(temporary, workflow, 'utf8')
  await fs.rename(temporary, destination)
  return { path: destination, created: true }
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, '\n').trim()
}

function deploymentConfigMatches(actual: RunnerDeploymentConfigFile, expected: RunnerDeploymentConfigFile) {
  return actual.version === expected.version
    && actual.repository.toLowerCase() === expected.repository.toLowerCase()
    && path.resolve(actual.projectPath).toLowerCase() === path.resolve(expected.projectPath).toLowerCase()
    && actual.gitCommand.toLowerCase() === expected.gitCommand.toLowerCase()
    && actual.pm2Command.toLowerCase() === expected.pm2Command.toLowerCase()
    && JSON.stringify(actual.services) === JSON.stringify(expected.services)
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8').then((value) => value.replace(/^\uFEFF/, ''))) as T } catch { return null }
}

export async function inspectRunnerDeployment(
  runner: GitHubRunnerConfig,
  settings: Settings,
  commands?: { gitCommand: string; pm2Command: string }
): Promise<GitHubRunnerDeploymentView> {
  if (runner.scope !== 'repository' || !runner.projectGroupId) return { state: 'not-configured' }
  const projectPath = projectRootForGroup(settings, runner.projectGroupId)
  const services = servicesForGroup(settings, runner.projectGroupId)
  const repository = repositoryFromTargetUrl(runner.targetUrl)
  const workflow = projectPath ? workflowPath(projectPath) : undefined
  const paths = runnerDeploymentPaths(runner.installPath)
  const [actual, lastResult, workflowContent] = await Promise.all([
    readJson<RunnerDeploymentConfigFile>(paths.configPath),
    readJson<RunnerDeploymentResultFile>(paths.statusPath),
    workflow ? fs.readFile(workflow, 'utf8').catch(() => null) : Promise.resolve(null)
  ])
  const last = lastResult ? {
    lastDeployAt: lastResult.finishedAt,
    lastDeployCommit: lastResult.commit,
    lastDeployStatus: lastResult.status,
    lastDeployMessage: lastResult.message
  } : {}
  if (!actual) return { state: 'not-configured', repository, projectPath, workflowPath: workflow, ...last }
  if (!projectPath || !services.length || !commands) return { state: 'invalid', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  const routingLabel = runnerRoutingLabel(runner)
  if (!runner.routingLabel || !runner.labels.some((label) => label.toLowerCase() === routingLabel)) {
    return { state: 'invalid', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  }
  const expected: RunnerDeploymentConfigFile = {
    version: 2,
    repository,
    projectPath,
    services: services.map((service) => ({
      name: service.pm2Name,
      relativePath: path.relative(projectPath, service.path) || '.',
      buildScript: service.buildScript,
      buildOnDeploy: Boolean(service.buildScript && service.buildOnDeploy),
      installDependenciesOnDeploy: service.installDependenciesOnDeploy !== false
    })),
    gitCommand: commands.gitCommand,
    pm2Command: commands.pm2Command,
    configuredAt: actual.configuredAt
  }
  if (!deploymentConfigMatches(actual, expected)) return { state: 'invalid', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  if (workflowContent === null) return { state: 'workflow-missing', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  if (normalizeText(workflowContent) !== normalizeText(buildControlRunWorkflow(routingLabel))) return { state: 'workflow-outdated', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  return { state: 'ready', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
}
