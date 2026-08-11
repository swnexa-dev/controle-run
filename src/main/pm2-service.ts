import pm2 from 'pm2'
import { app } from 'electron'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { ProjectAction, ProjectConfig } from '../shared/types'

const connect = () => new Promise<void>((resolve, reject) => pm2.connect((error) => error ? reject(error) : resolve()))
const list = () => new Promise<pm2.ProcessDescription[]>((resolve, reject) => pm2.list((error, value) => error ? reject(error) : resolve(value)))
const remove = (name: string) => new Promise<void>((resolve, reject) => pm2.delete(name, (error) => error ? reject(error) : resolve()))
const runAction = (name: string, action: Exclude<ProjectAction, 'build-restart'>) => new Promise<void>((resolve, reject) => {
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

export const MAX_START_ATTEMPTS = 10

export function buildStartOptions(project: ProjectConfig, hiddenRunnerPath = runnerPath): pm2.StartOptions {
  const options: pm2.StartOptions & { windowsHide?: boolean } = {
    name: project.pm2Name,
    cwd: project.path,
    autorestart: true,
    // O padrão de 1s do PM2 considera processos que duram pouco como estáveis,
    // o que pode resultar em centenas de reinícios.
    min_uptime: 10_000,
    restart_delay: 1_000,
    max_restarts: MAX_START_ATTEMPTS,
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

function normalizedArgs(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value.map(String)
  return value ? [String(value)] : []
}

export function launchMatches(processInfo: pm2.ProcessDescription, options: pm2.StartOptions) {
  const currentScript = processInfo.pm2_env?.pm_exec_path
  const expectedScript = options.script
  if (!currentScript || !expectedScript || path.basename(currentScript).toLowerCase() !== path.basename(expectedScript).toLowerCase()) return false
  const currentCwd = (processInfo.pm2_env as { pm_cwd?: string } | undefined)?.pm_cwd
  const expectedCwd = options.cwd
  if (currentCwd && expectedCwd && path.resolve(currentCwd).toLowerCase() !== path.resolve(expectedCwd).toLowerCase()) return false
  const currentArgs = normalizedArgs((processInfo.pm2_env as { args?: string | string[] } | undefined)?.args)
  const expectedArgs = normalizedArgs(options.args)
  return JSON.stringify(currentArgs) === JSON.stringify(expectedArgs)
}

export async function startProject(project: ProjectConfig) {
  await ensureConnection()
  const options = buildStartOptions(project, await ensureRunner())

  await new Promise<void>((resolve, reject) => pm2.start(options, (error) => error ? reject(error) : resolve()))
}

export async function controlProject(project: ProjectConfig, action: ProjectAction) {
  if (action === 'build-restart' || action === 'permanent-stop') throw new Error('Ação de projeto deve ser executada pelo serviço principal.')
  await ensureConnection()
  const processes = await list()
  const current = processes.find((process) => process.name === project.pm2Name)
  if ((action === 'start' || action === 'restart') && current) {
    const options = buildStartOptions(project, await ensureRunner())
    if (launchMatches(current, options)) return runAction(project.pm2Name, action)
    await remove(project.pm2Name)
    await new Promise<void>((resolve, reject) => pm2.start(options, (error) => error ? reject(error) : resolve()))
    return
  }
  if (action === 'start' && !current) return startProject(project)
  if (!current) throw new Error('O projeto ainda não foi iniciado pelo Controle Run.')
  return runAction(project.pm2Name, action)
}

export async function controlManagedProcess(name: string, options: pm2.StartOptions, action: 'start' | 'stop' | 'restart') {
  await ensureConnection()
  const processes = await list()
  const current = processes.find((process) => process.name === name)
  if (action === 'stop') {
    if (!current) throw new Error('O processo ainda não foi iniciado.')
    return runAction(name, 'stop')
  }
  if (current && launchMatches(current, options)) return runAction(name, action)
  if (current) await remove(name)
  await new Promise<void>((resolve, reject) => pm2.start(options, (error) => error ? reject(error) : resolve()))
}

export async function removeManagedProcess(name: string) {
  await ensureConnection()
  const processes = await list()
  if (!processes.some((process) => process.name === name)) return
  await remove(name)
  await waitForManagedProcessRemoval(name, list)
}

export async function removeProjectProcess(project: ProjectConfig) {
  await removeManagedProcess(project.pm2Name)
}

export async function waitForManagedProcessRemoval(
  name: string,
  readProcesses: () => Promise<Array<{ name?: string }>>,
  options: { attempts?: number; intervalMs?: number } = {}
) {
  const attempts = options.attempts ?? 20
  const intervalMs = options.intervalMs ?? 150
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = await readProcesses()
    if (!processes.some((process) => process.name === name)) return
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`O processo ${name} ainda aparece no PM2 após a tentativa de remoção. O cadastro foi preservado.`)
}

export function disconnectPm2() {
  if (connected) pm2.disconnect()
  connected = false
}
