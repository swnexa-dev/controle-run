import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubRunnerConfig, GitHubRunnerDeploymentView, ProjectConfig } from '../shared/types'
import { projectId } from './discovery'
import type { Settings } from './store'

export interface RunnerDeploymentConfigFile {
  version: 1
  repository: string
  projectPath: string
  serviceNames: string[]
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

export const CONTROL_RUN_WORKFLOW = `name: Controle Run Deploy

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
  cancel-in-progress: true

jobs:
  deploy:
    name: Atualizar servidor
    runs-on: [self-hosted, Windows, X64]
    timeout-minutes: 15

    steps:
      - name: Baixar versão enviada
        uses: actions/checkout@v7
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Atualizar projeto pelo Controle Run
        shell: powershell
        run: |
          if (-not $env:CONTROLE_RUN_DEPLOY_SCRIPT) {
            throw 'Este runner ainda não foi preparado para deploy pelo Controle Run.'
          }

          & $env:CONTROLE_RUN_DEPLOY_SCRIPT \`
            -Repository '\${{ github.repository }}' \`
            -SourcePath "$env:GITHUB_WORKSPACE" \`
            -Commit "$env:GITHUB_SHA"
`

export const CONTROL_RUN_DEPLOY_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$Repository,
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$Commit
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ConfigPath = Join-Path $PSScriptRoot 'deployment.json'
$StatusPath = Join-Path $PSScriptRoot 'last-deploy.json'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$GitCommand = 'git.exe'

function Write-Status([string]$Status, [string]$Message) {
  $payload = @{
    repository = $Repository
    commit = $Commit
    status = $Status
    message = $Message
    finishedAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($StatusPath, $payload, $Utf8NoBom)
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
  foreach ($serviceName in @($Config.serviceNames)) {
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

$previousCommit = $null
$updated = $false

try {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'A configuração local de deploy não foi encontrada. Prepare o deploy novamente no Controle Run.'
  }

  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
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
  $resetOutput = Invoke-Git @('-C', $target, 'reset', '--hard', 'FETCH_HEAD')
  if ($resetOutput) { Write-Host $resetOutput }
  $updated = $true

  Restart-Services $config
  Write-Status 'success' 'Projeto atualizado e serviços reiniciados.'
  Write-Host '[Controle Run] Deploy concluído com sucesso.'
}
catch {
  $message = $_.Exception.Message
  if ($updated -and $previousCommit -and $previousCommit -match '^[a-f0-9]{40}$') {
    try {
      Write-Warning '[Controle Run] O reinício falhou. Restaurando a versão anterior...'
      Invoke-Git @('-C', ([string]$config.projectPath), 'reset', '--hard', $previousCommit) | Out-Null
      Restart-Services $config
      $message = "$message A versão anterior foi restaurada."
    }
    catch {
      $message = "$message A restauração automática também falhou: $($_.Exception.Message)"
    }
  }
  try { Write-Status 'failed' $message } catch { }
  throw $message
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

export async function writeStandardWorkflow(projectPath: string, overwrite = false) {
  const destination = workflowPath(projectPath)
  const current = await fs.readFile(destination, 'utf8').catch(() => null)
  if (current !== null && normalizeText(current) !== normalizeText(CONTROL_RUN_WORKFLOW) && !overwrite) {
    throw new Error('Já existe um workflow controle-run.yml diferente. Confirme a substituição para continuar.')
  }
  await fs.mkdir(path.dirname(destination), { recursive: true })
  if (current !== null && normalizeText(current) === normalizeText(CONTROL_RUN_WORKFLOW)) return { path: destination, created: false }
  const temporary = `${destination}.writing`
  await fs.writeFile(temporary, CONTROL_RUN_WORKFLOW, 'utf8')
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
    && JSON.stringify(actual.serviceNames) === JSON.stringify(expected.serviceNames)
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
  const expected: RunnerDeploymentConfigFile = {
    version: 1,
    repository,
    projectPath,
    serviceNames: services.map((service) => service.pm2Name),
    gitCommand: commands.gitCommand,
    pm2Command: commands.pm2Command,
    configuredAt: actual.configuredAt
  }
  if (!deploymentConfigMatches(actual, expected)) return { state: 'invalid', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  if (workflowContent === null) return { state: 'workflow-missing', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  if (normalizeText(workflowContent) !== normalizeText(CONTROL_RUN_WORKFLOW)) return { state: 'workflow-outdated', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
  return { state: 'ready', repository, projectPath, workflowPath: workflow, configuredAt: actual.configuredAt, ...last }
}
