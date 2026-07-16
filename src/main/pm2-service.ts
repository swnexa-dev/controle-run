import pm2 from 'pm2'
import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { ProjectAction, ProjectConfig } from '../shared/types'

const connect = () => new Promise<void>((resolve, reject) => pm2.connect((error) => error ? reject(error) : resolve()))
const list = () => new Promise<pm2.ProcessDescription[]>((resolve, reject) => pm2.list((error, value) => error ? reject(error) : resolve(value)))
const remove = (name: string) => new Promise<void>((resolve, reject) => pm2.delete(name, (error) => error ? reject(error) : resolve()))
const runAction = (name: string, action: ProjectAction) => new Promise<void>((resolve, reject) => {
  const callback = (error?: Error | null) => error ? reject(error) : resolve()
  if (action === 'start') pm2.restart(name, callback)
  else if (action === 'restart') pm2.restart(name, callback)
  else pm2.stop(name, callback)
})

let connected = false
let runnerPath: string | null = null

const RUNNER_SOURCE = `
const { spawn } = require('node:child_process')
const path = require('node:path')

const command = process.argv.slice(2).join(' ')
if (!command) process.exit(1)

const binPath = path.join(process.cwd(), 'node_modules', '.bin')
const env = { ...process.env }
env.Path = [binPath, env.Path || env.PATH || ''].filter(Boolean).join(path.delimiter)
env.PATH = env.Path

const child = spawn(command, {
  cwd: process.cwd(),
  env,
  shell: true,
  windowsHide: true,
  stdio: ['ignore', 'inherit', 'inherit']
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
`.trimStart()
async function ensureConnection() {
  if (!connected) {
    // Permite que o executável do Electron funcione como o runtime Node do daemon
    // e dos projetos, inclusive no aplicativo empacotado e sem Node global.
    process.env.ELECTRON_RUN_AS_NODE = '1'
    await connect()
    connected = true
  }
}

async function ensureRunner() {
  if (runnerPath) return runnerPath
  const file = path.join(app.getPath('userData'), 'pm2-hidden-runner.cjs')
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, RUNNER_SOURCE, 'utf8')
  runnerPath = file
  return file
}

export async function getProcesses() {
  await ensureConnection()
  return list()
}

function customArgs(value?: string) {
  return value?.trim() ? value.trim().split(/\s+/) : []
}

export function buildStartOptions(project: ProjectConfig, hiddenRunnerPath = runnerPath): pm2.StartOptions {
  const options: pm2.StartOptions & { windowsHide?: boolean } = {
    name: project.pm2Name,
    cwd: project.path,
    autorestart: true,
    max_restarts: 10,
    time: true,
    windowsHide: true
  }

  if (project.mode === 'npm') {
    if (process.platform === 'win32') {
      if (!hiddenRunnerPath) throw new Error('Executor em segundo plano ainda nao foi preparado.')
      const command = [project.npmCommand || `npm run ${project.npmScript || 'start'}`, project.args || ''].filter(Boolean).join(' ')
      options.script = hiddenRunnerPath
      options.args = [command]
      options.interpreter = process.execPath
    } else {
      options.script = 'npm'
      options.args = ['run', project.npmScript || 'start', ...(project.args ? ['--', ...customArgs(project.args)] : [])]
      options.interpreter = 'none'
    }
  } else {
    options.script = path.resolve(project.path, project.entry || 'index.js')
    if (project.args) options.args = customArgs(project.args)
  }

  return options
}

function launchMatches(processInfo: pm2.ProcessDescription, options: pm2.StartOptions) {
  const currentScript = processInfo.pm2_env?.pm_exec_path
  const expectedScript = options.script
  if (!currentScript || !expectedScript || path.basename(currentScript).toLowerCase() !== path.basename(expectedScript).toLowerCase()) return false
  const currentArgs = (processInfo.pm2_env as { args?: string[] } | undefined)?.args || []
  const expectedArgs = options.args || []
  return JSON.stringify(currentArgs) === JSON.stringify(expectedArgs)
}

export async function startProject(project: ProjectConfig) {
  await ensureConnection()
  const options = buildStartOptions(project, await ensureRunner())

  await new Promise<void>((resolve, reject) => pm2.start(options, (error) => error ? reject(error) : resolve()))
}

export async function controlProject(project: ProjectConfig, action: ProjectAction) {
  await ensureConnection()
  const processes = await list()
  const current = processes.find((process) => process.name === project.pm2Name)
  if ((action === 'start' || action === 'restart') && current) {
    await remove(project.pm2Name)
    return startProject(project)
  }
  if (action === 'start' && !current) return startProject(project)
  if (!current) throw new Error('O projeto ainda não foi iniciado pelo Controle Run.')
  return runAction(project.pm2Name, action)
}

export async function removeProjectProcess(project: ProjectConfig) {
  await ensureConnection()
  const processes = await list()
  if (processes.some((process) => process.name === project.pm2Name)) await remove(project.pm2Name)
}

export function disconnectPm2() {
  if (connected) pm2.disconnect()
  connected = false
}
