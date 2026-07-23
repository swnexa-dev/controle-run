import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubRunnerConfig, ProjectConfig } from '../shared/types'
import {
  CONTROL_RUN_DEPLOY_SCRIPT,
  CONTROL_RUN_WORKFLOW,
  githubRepositoryFromRemote,
  inspectRunnerDeployment,
  runnerDeploymentPaths,
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
      labels: ['controle-run'],
      serviceAccount: 'DOMAIN\\user',
      installedVersion: '2.336.0',
      projectGroupId: groupId,
      createdAt: new Date().toISOString()
    }
    const settings: Settings = { projectPaths: [projectPath], projects: { [project.id]: project }, githubRunners: { [runner.id]: runner } }
    const pm2Command = 'C:\\Users\\user\\AppData\\Roaming\\npm\\pm2.cmd'
    const gitCommand = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const paths = runnerDeploymentPaths(installPath)
    await fs.mkdir(paths.directory, { recursive: true })
    await fs.writeFile(paths.configPath, JSON.stringify({
      version: 1,
      repository: 'swnexa-dev/teste3',
      projectPath,
      serviceNames: [project.pm2Name],
      gitCommand,
      pm2Command,
      configuredAt: '2026-07-22T20:00:00.000Z'
    }), 'utf8')
    await writeStandardWorkflow(projectPath)
    await expect(inspectRunnerDeployment(runner, settings, { gitCommand, pm2Command })).resolves.toMatchObject({ state: 'ready', repository: 'swnexa-dev/teste3' })
  })

  it.runIf(process.platform === 'win32')('produces a PowerShell deployment script without syntax errors', async () => {
    const directory = await temporaryDirectory()
    const scriptPath = path.join(directory, 'deploy.ps1')
    await fs.writeFile(scriptPath, CONTROL_RUN_DEPLOY_SCRIPT, 'utf8')
    const parser = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:DEPLOY_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
    await expect(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { env: { ...process.env, DEPLOY_SCRIPT: scriptPath } })).resolves.toBeTruthy()
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
      version: 1,
      repository: 'swnexa-dev/teste3',
      projectPath: targetPath,
      serviceNames: ['controle-run-test'],
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
})
