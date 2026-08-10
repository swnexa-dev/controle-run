import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubRunnerConfig, ProjectConfig } from '../shared/types'
import {
  buildControlRunWorkflow,
  CHECKOUT_ACTION_SHA,
  CONTROL_RUN_DEPLOY_SCRIPT,
  CONTROL_RUN_WORKFLOW,
  githubRepositoryFromRemote,
  inspectRunnerDeployment,
  runnerDeploymentPaths,
  runnerRoutingLabel,
  writeStandardWorkflow
} from './deployment-service'
import { projectId } from './discovery'
import type { Settings } from './store'

const execute = promisify(execFile)
const temporaryDirectories: string[] = []

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-deploy-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('Controle Run deployment', () => {
  it('normalizes HTTPS and SSH GitHub remotes', () => {
    expect(githubRepositoryFromRemote('https://github.com/swnexa-dev/teste3.git')).toBe('swnexa-dev/teste3')
    expect(githubRepositoryFromRemote('git@github.com:swnexa-dev/teste3.git')).toBe('swnexa-dev/teste3')
    expect(githubRepositoryFromRemote('ssh://git@github.com/swnexa-dev/teste3.git')).toBe('swnexa-dev/teste3')
    expect(() => githubRepositoryFromRemote('https://example.com/swnexa-dev/teste3')).toThrow()
  })

  it('writes one stable workflow and protects customized files', async () => {
    const projectPath = await temporaryDirectory()
    const first = await writeStandardWorkflow(projectPath)
    expect(first.created).toBe(true)
    expect(await fs.readFile(first.path, 'utf8')).toBe(CONTROL_RUN_WORKFLOW)
    expect(CONTROL_RUN_WORKFLOW).toContain(`uses: actions/checkout@${CHECKOUT_ACTION_SHA} # v6.1.0`)
    expect(CHECKOUT_ACTION_SHA).toMatch(/^[a-f0-9]{40}$/)
    expect(CONTROL_RUN_WORKFLOW).not.toMatch(/uses:\s+actions\/checkout@v\d/)
    expect(CONTROL_RUN_WORKFLOW).toContain('fetch-depth: 0')
    expect(CONTROL_RUN_WORKFLOW).toContain('cancel-in-progress: false')
    expect(CONTROL_RUN_WORKFLOW).toContain('timeout-minutes: 30')
    expect(buildControlRunWorkflow('controle-run-abc123')).toContain('runs-on: [self-hosted, Windows, X64, controle-run-abc123]')
    expect(runnerRoutingLabel({ id: 'ABC123' })).toBe('controle-run-abc123')
    expect(CONTROL_RUN_WORKFLOW).toContain("Join-Path $runnerDirectory '.controle-run\\deploy.ps1'")
    expect(CONTROL_RUN_WORKFLOW).toContain('Test-Path -LiteralPath $_ -PathType Leaf')
    expect(CONTROL_RUN_WORKFLOW).not.toContain('if (-not $env:CONTROLE_RUN_DEPLOY_SCRIPT)')
    expect(CONTROL_RUN_DEPLOY_SCRIPT).toContain('Build-Services $config $previousCommit $Commit')
    expect(CONTROL_RUN_DEPLOY_SCRIPT).toContain("Invoke-External $npmCommand @('run', $buildScript)")
    expect(CONTROL_RUN_DEPLOY_SCRIPT).toContain('Enter-DeployLock')
    expect(CONTROL_RUN_DEPLOY_SCRIPT).toContain('Recover-InterruptedDeployment $config')
    expect(CONTROL_RUN_DEPLOY_SCRIPT).toContain("Write-Transaction $config $previousCommit $Commit 'committed'")
    expect((await writeStandardWorkflow(projectPath)).created).toBe(false)
    await fs.writeFile(first.path, 'name: personalizado\n', 'utf8')
    await expect(writeStandardWorkflow(projectPath)).rejects.toThrow('Confirme a substituição')
    expect((await writeStandardWorkflow(projectPath, true)).created).toBe(true)
  })

  it('reports a runner as ready only when its local mapping and workflow match', async () => {
    const projectPath = await temporaryDirectory()
    const installPath = await temporaryDirectory()
    const groupId = projectId(projectPath)
    const project: ProjectConfig = {
      id: projectId(path.join(projectPath, 'backend')),
      groupId,
      groupName: 'teste3',
      groupPath: projectPath,
      serviceType: 'backend',
      name: 'Backend',
      path: path.join(projectPath, 'backend'),
      pm2Name: 'controle-run-teste3-backend',
      mode: 'npm',
      npmScript: 'start',
      buildScript: 'build',
      buildOnDeploy: true,
      installDependenciesOnDeploy: true,
      autoStart: true,
      detected: true
    }
    const runner: GitHubRunnerConfig = {
      id: 'runner-1',
      name: 'runner-1',
      scope: 'repository',
      targetUrl: 'https://github.com/swnexa-dev/teste3',
      installPath,
      workFolder: '_work',
      labels: ['controle-run', 'controle-run-runner-1'],
      routingLabel: 'controle-run-runner-1',
      serviceAccount: 'DOMAIN\\user',
      installedVersion: '2.336.0',
      projectGroupId: groupId,
      createdAt: new Date().toISOString()
    }
    const settings: Settings = { projectPaths: [projectPath], projects: { [project.id]: project }, githubRunners: { [runner.id]: runner }, cloudflareTunnels: {} }
    const pm2Command = 'C:\\Users\\user\\AppData\\Roaming\\npm\\pm2.cmd'
    const gitCommand = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const paths = runnerDeploymentPaths(installPath)
    await fs.mkdir(paths.directory, { recursive: true })
    await fs.writeFile(paths.configPath, JSON.stringify({
      version: 2,
      repository: 'swnexa-dev/teste3',
      projectPath,
      services: [{
        name: project.pm2Name,
        relativePath: 'backend',
        buildScript: 'build',
        buildOnDeploy: true,
        installDependenciesOnDeploy: true
      }],
      gitCommand,
      pm2Command,
      configuredAt: '2026-07-22T20:00:00.000Z'
    }), 'utf8')
    await writeStandardWorkflow(projectPath, false, runnerRoutingLabel(runner))
    await expect(inspectRunnerDeployment(runner, settings, { gitCommand, pm2Command })).resolves.toMatchObject({ state: 'ready', repository: 'swnexa-dev/teste3' })
    const legacyRunner: GitHubRunnerConfig = { ...runner, labels: ['controle-run'], routingLabel: undefined }
    await expect(inspectRunnerDeployment(legacyRunner, settings, { gitCommand, pm2Command })).resolves.toMatchObject({ state: 'invalid' })
  })

  it.runIf(process.platform === 'win32')('produces a PowerShell deployment script without syntax errors', async () => {
    const directory = await temporaryDirectory()
    const scriptPath = path.join(directory, 'deploy.ps1')
    await fs.writeFile(scriptPath, CONTROL_RUN_DEPLOY_SCRIPT, 'utf8')
    const parser = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:DEPLOY_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
    await expect(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { env: { ...process.env, DEPLOY_SCRIPT: scriptPath } })).resolves.toBeTruthy()
  })

  it.runIf(process.platform === 'win32')('finds the local deploy script from RUNNER_TEMP when the service variable is missing', async () => {
    const runnerDirectory = await temporaryDirectory()
    const runnerTemp = path.join(runnerDirectory, 'custom-work', '_temp')
    const deployDirectory = path.join(runnerDirectory, '.controle-run')
    const deployScript = path.join(deployDirectory, 'deploy.ps1')
    const workflowStep = path.join(runnerDirectory, 'workflow-step.ps1')
    const resultPath = path.join(runnerDirectory, 'result.txt')
    const sourcePath = path.join(runnerDirectory, 'custom-work', 'repository', 'repository')
    const commit = 'a'.repeat(40)
    const marker = '        run: |\n'
    const stepStart = CONTROL_RUN_WORKFLOW.indexOf(marker)
    expect(stepStart).toBeGreaterThan(-1)
    const stepScript = CONTROL_RUN_WORKFLOW
      .slice(stepStart + marker.length)
      .split('\n')
      .map((line) => line.startsWith('          ') ? line.slice(10) : line)
      .join('\r\n')
      .replace(/\$\{\{\s*github\.repository\s*\}\}/g, 'swnexa-dev/teste')
      .trim()

    await fs.mkdir(runnerTemp, { recursive: true })
    await fs.mkdir(deployDirectory, { recursive: true })
    await fs.writeFile(deployScript, `\uFEFFparam([string]$Repository,[string]$SourcePath,[string]$Commit)\r\n[IO.File]::WriteAllText($env:DEPLOY_RESULT, "$Repository|$SourcePath|$Commit")\r\n`, 'utf8')
    await fs.writeFile(workflowStep, `\uFEFF${stepScript}\r\n`, 'utf8')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      GITHUB_WORKSPACE: sourcePath,
      GITHUB_SHA: commit,
      DEPLOY_RESULT: resultPath
    }
    delete env.CONTROLE_RUN_DEPLOY_SCRIPT

    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workflowStep], { env })
    await expect(fs.readFile(resultPath, 'utf8')).resolves.toBe(`swnexa-dev/teste|${sourcePath}|${commit}`)
  })

  it.runIf(process.platform === 'win32')('updates a clone from the runner checkout without GitHub credentials', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'runner-workspace')
    const targetPath = path.join(directory, 'published-project')
    const deployDirectory = path.join(directory, 'runner-helper')
    const pm2Command = path.join(directory, 'pm2.cmd')
    await fs.mkdir(sourcePath, { recursive: true })
    await execute('git.exe', ['init', '-b', 'master'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.email', 'controle-run@example.invalid'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.name', 'Controle Run Test'], { cwd: sourcePath })
    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'version 1', 'utf8')
    await execute('git.exe', ['add', 'version.txt'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'version 1'], { cwd: sourcePath })
    await execute('git.exe', ['clone', sourcePath, targetPath])
    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'version 2', 'utf8')
    await execute('git.exe', ['add', 'version.txt'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'version 2'], { cwd: sourcePath })
    const { stdout: commitOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: sourcePath })
    const commit = commitOutput.trim()

    await fs.mkdir(deployDirectory, { recursive: true })
    const scriptPath = path.join(deployDirectory, 'deploy.ps1')
    await fs.writeFile(scriptPath, CONTROL_RUN_DEPLOY_SCRIPT, 'utf8')
    await fs.writeFile(pm2Command, '@echo off\r\nexit /b 0\r\n', 'utf8')
    await fs.writeFile(path.join(deployDirectory, 'deployment.json'), JSON.stringify({
      version: 2,
      repository: 'swnexa-dev/teste3',
      projectPath: targetPath,
      services: [{
        name: 'controle-run-test',
        relativePath: '.',
        buildOnDeploy: false,
        installDependenciesOnDeploy: true
      }],
      gitCommand: 'C:\\Program Files\\Git\\cmd\\git.exe',
      pm2Command,
      configuredAt: new Date().toISOString()
    }), 'utf8')

    await execute('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Repository', 'swnexa-dev/teste3',
      '-SourcePath', sourcePath,
      '-Commit', commit
    ])
    expect(await fs.readFile(path.join(targetPath, 'version.txt'), 'utf8')).toBe('version 2')
    await expect(fs.readFile(path.join(targetPath, '.git', 'FETCH_HEAD'), 'utf8')).resolves.toContain(commit)
    const result = JSON.parse(await fs.readFile(path.join(deployDirectory, 'last-deploy.json'), 'utf8')) as { status: string; commit: string }
    expect(result).toMatchObject({ status: 'success', commit })
  }, 20_000)

  it.runIf(process.platform === 'win32')('runs a configured build before restarting PM2', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'runner-workspace')
    const targetPath = path.join(directory, 'published-project')
    const deployDirectory = path.join(directory, 'runner-helper')
    const pm2Command = path.join(directory, 'pm2.cmd')
    const npmCommand = path.join(directory, 'npm.cmd')
    await fs.mkdir(sourcePath, { recursive: true })
    await execute('git.exe', ['init', '-b', 'master'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.email', 'controle-run@example.invalid'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.name', 'Controle Run Test'], { cwd: sourcePath })
    await fs.writeFile(path.join(sourcePath, 'package.json'), JSON.stringify({ scripts: { build: 'ignored-by-test' } }), 'utf8')
    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'version 1', 'utf8')
    await execute('git.exe', ['add', '.'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'version 1'], { cwd: sourcePath })
    await execute('git.exe', ['clone', sourcePath, targetPath])
    await fs.mkdir(path.join(targetPath, 'node_modules'))
    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'version 2', 'utf8')
    await execute('git.exe', ['add', 'version.txt'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'version 2'], { cwd: sourcePath })
    const { stdout: commitOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: sourcePath })
    const commit = commitOutput.trim()

    await fs.mkdir(deployDirectory, { recursive: true })
    const scriptPath = path.join(deployDirectory, 'deploy.ps1')
    await fs.writeFile(scriptPath, CONTROL_RUN_DEPLOY_SCRIPT, 'utf8')
    await fs.writeFile(pm2Command, '@echo off\r\nexit /b 0\r\n', 'utf8')
    await fs.writeFile(npmCommand, '@echo off\r\nif "%1"=="run" echo build-ok>build-marker.txt\r\nexit /b 0\r\n', 'utf8')
    await fs.writeFile(path.join(deployDirectory, 'deployment.json'), JSON.stringify({
      version: 2,
      repository: 'swnexa-dev/teste3',
      projectPath: targetPath,
      services: [{ name: 'controle-run-test', relativePath: '.', buildScript: 'build', buildOnDeploy: true, installDependenciesOnDeploy: true }],
      gitCommand: 'C:\\Program Files\\Git\\cmd\\git.exe',
      pm2Command,
      configuredAt: new Date().toISOString()
    }), 'utf8')

    await execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-Repository', 'swnexa-dev/teste3', '-SourcePath', sourcePath, '-Commit', commit
    ])
    await expect(fs.readFile(path.join(targetPath, 'build-marker.txt'), 'utf8')).resolves.toContain('build-ok')
  }, 20_000)

  it.runIf(process.platform === 'win32')('rolls back the published project when an intermediate build fails', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'runner-workspace')
    const targetPath = path.join(directory, 'published-project')
    const deployDirectory = path.join(directory, 'runner-helper')
    const pm2Command = path.join(directory, 'pm2.cmd')
    const npmCommand = path.join(directory, 'npm.cmd')
    await fs.mkdir(sourcePath, { recursive: true })
    await execute('git.exe', ['init', '-b', 'master'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.email', 'controle-run@example.invalid'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.name', 'Controle Run Test'], { cwd: sourcePath })
    await fs.writeFile(path.join(sourcePath, 'package.json'), JSON.stringify({ scripts: { build: 'ignored-by-test' } }), 'utf8')
    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'stable', 'utf8')
    await execute('git.exe', ['add', '.'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'stable'], { cwd: sourcePath })
    await execute('git.exe', ['clone', sourcePath, targetPath])
    await fs.mkdir(path.join(targetPath, 'node_modules'))
    const { stdout: stableOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: targetPath })
    const stableCommit = stableOutput.trim()

    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'broken', 'utf8')
    await execute('git.exe', ['add', 'version.txt'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'broken'], { cwd: sourcePath })
    const { stdout: brokenOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: sourcePath })
    const brokenCommit = brokenOutput.trim()

    await fs.mkdir(deployDirectory, { recursive: true })
    const scriptPath = path.join(deployDirectory, 'deploy.ps1')
    await fs.writeFile(scriptPath, CONTROL_RUN_DEPLOY_SCRIPT, 'utf8')
    await fs.writeFile(pm2Command, '@echo off\r\nexit /b 0\r\n', 'utf8')
    await fs.writeFile(npmCommand, '@echo off\r\nfindstr /C:"broken" version.txt >nul\r\nif %ERRORLEVEL% EQU 0 exit /b 7\r\nexit /b 0\r\n', 'utf8')
    await fs.writeFile(path.join(deployDirectory, 'deployment.json'), JSON.stringify({
      version: 2,
      repository: 'swnexa-dev/teste3',
      projectPath: targetPath,
      services: [{ name: 'controle-run-test', relativePath: '.', buildScript: 'build', buildOnDeploy: true, installDependenciesOnDeploy: true }],
      gitCommand: 'C:\\Program Files\\Git\\cmd\\git.exe',
      pm2Command,
      configuredAt: new Date().toISOString()
    }), 'utf8')

    await expect(execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-Repository', 'swnexa-dev/teste3', '-SourcePath', sourcePath, '-Commit', brokenCommit
    ])).rejects.toThrow()

    const { stdout: restoredOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: targetPath })
    expect(restoredOutput.trim()).toBe(stableCommit)
    expect(await fs.readFile(path.join(targetPath, 'version.txt'), 'utf8')).toBe('stable')
    await expect(fs.access(path.join(deployDirectory, 'deploy-transaction.json'))).rejects.toThrow()
    const result = JSON.parse(await fs.readFile(path.join(deployDirectory, 'last-deploy.json'), 'utf8')) as { status: string; message: string }
    expect(result.status).toBe('failed')
    expect(result.message).toContain('anterior foi restaurada')
  }, 25_000)

  it.runIf(process.platform === 'win32')('recovers an interrupted transaction before applying the next deploy', async () => {
    const directory = await temporaryDirectory()
    const sourcePath = path.join(directory, 'runner-workspace')
    const targetPath = path.join(directory, 'published-project')
    const deployDirectory = path.join(directory, 'runner-helper')
    const pm2Command = path.join(directory, 'pm2.cmd')
    const pm2Log = path.join(directory, 'pm2-restarts.txt')
    await fs.mkdir(sourcePath, { recursive: true })
    await execute('git.exe', ['init', '-b', 'master'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.email', 'controle-run@example.invalid'], { cwd: sourcePath })
    await execute('git.exe', ['config', 'user.name', 'Controle Run Test'], { cwd: sourcePath })
    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'version 1', 'utf8')
    await execute('git.exe', ['add', 'version.txt'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'version 1'], { cwd: sourcePath })
    await execute('git.exe', ['clone', sourcePath, targetPath])
    const { stdout: previousOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: targetPath })
    const previousCommit = previousOutput.trim()

    await fs.writeFile(path.join(sourcePath, 'version.txt'), 'version 2', 'utf8')
    await execute('git.exe', ['add', 'version.txt'], { cwd: sourcePath })
    await execute('git.exe', ['commit', '-m', 'version 2'], { cwd: sourcePath })
    const { stdout: commitOutput } = await execute('git.exe', ['rev-parse', 'HEAD'], { cwd: sourcePath })
    const commit = commitOutput.trim()
    await execute('git.exe', ['fetch', sourcePath, 'HEAD'], { cwd: targetPath })
    await execute('git.exe', ['reset', '--hard', commit], { cwd: targetPath })

    await fs.mkdir(deployDirectory, { recursive: true })
    const scriptPath = path.join(deployDirectory, 'deploy.ps1')
    await fs.writeFile(scriptPath, CONTROL_RUN_DEPLOY_SCRIPT, 'utf8')
    await fs.writeFile(pm2Command, '@echo off\r\necho restart>>"%PM2_LOG%"\r\nexit /b 0\r\n', 'utf8')
    await fs.writeFile(path.join(deployDirectory, 'deployment.json'), JSON.stringify({
      version: 2,
      repository: 'swnexa-dev/teste3',
      projectPath: targetPath,
      services: [{ name: 'controle-run-test', relativePath: '.', buildOnDeploy: false, installDependenciesOnDeploy: true }],
      gitCommand: 'C:\\Program Files\\Git\\cmd\\git.exe',
      pm2Command,
      configuredAt: new Date().toISOString()
    }), 'utf8')
    await fs.writeFile(path.join(deployDirectory, 'deploy-transaction.json'), JSON.stringify({
      version: 1,
      repository: 'swnexa-dev/teste3',
      projectPath: targetPath,
      previousCommit,
      targetCommit: commit,
      phase: 'updated',
      updatedAt: new Date().toISOString()
    }), 'utf8')

    await execute('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-Repository', 'swnexa-dev/teste3', '-SourcePath', sourcePath, '-Commit', commit
    ], { env: { ...process.env, PM2_LOG: pm2Log } })

    expect(await fs.readFile(path.join(targetPath, 'version.txt'), 'utf8')).toBe('version 2')
    await expect(fs.access(path.join(deployDirectory, 'deploy-transaction.json'))).rejects.toThrow()
    const restarts = (await fs.readFile(pm2Log, 'utf8')).trim().split(/\r?\n/)
    expect(restarts).toHaveLength(2)
  }, 25_000)
})
