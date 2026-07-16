import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProjectConfig } from '../shared/types'

const execFileAsync = promisify(execFile)
const URL_PATTERN = /https?:\/\/[^\s"'`]+/i
const PORT_PATTERNS = [
  /(?:--port|-p)\s+(\d{2,5})/i,
  /(?:--port|-p)=(\d{2,5})/i,
  /(?:^|\s)PORT=(\d{2,5})/i,
  /localhost:(\d{2,5})/i,
  /127\.0\.0\.1:(\d{2,5})/i
]

function defaultPort(project: ProjectConfig) {
  const command = `${project.npmCommand || ''} ${project.npmScript || ''}`.toLowerCase()
  if (project.serviceType === 'frontend' && /\bvite\b/.test(command)) return 5173
  if (project.serviceType === 'frontend' && /\bnext\b/.test(command)) return 3000
  return null
}

const IGNORED_PORTS = new Set(['135', '139', '445'])

function normalizePort(value?: string | number) {
  const port = value === undefined ? undefined : String(value).trim()
  return port && /^\d{2,5}$/.test(port) ? port : null
}

function localUrl(port: string | number) {
  return `http://localhost:${port}`
}

export function detectConfiguredLocalUrl(project: ProjectConfig) {
  const source = [project.npmCommand, project.args, project.entry].filter(Boolean).join(' ')
  const explicitUrl = source.match(URL_PATTERN)?.[0]
  if (explicitUrl) return explicitUrl.replace(/[),.;]+$/, '')

  for (const pattern of PORT_PATTERNS) {
    const port = source.match(pattern)?.[1]
    if (port) return localUrl(port)
  }

  const port = defaultPort(project)
  return port ? localUrl(port) : undefined
}

function normalizePowerShellJson<T>(value: T | T[] | null): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

async function getWindowsDescendantPids(rootPid: number) {
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true, timeout: 6000 })
  const processes = normalizePowerShellJson<{ ProcessId: number; ParentProcessId: number | null }>(JSON.parse(stdout || '[]'))
  const children = new Map<number, number[]>()
  for (const item of processes) {
    if (!item.ParentProcessId) continue
    children.set(item.ParentProcessId, [...(children.get(item.ParentProcessId) || []), item.ProcessId])
  }

  const pids = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length) {
    const parent = queue.shift()!
    for (const child of children.get(parent) || []) {
      if (pids.has(child)) continue
      pids.add(child)
      queue.push(child)
    }
  }
  return pids
}

async function getWindowsListeningPorts(pids: Set<number>) {
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 6000 })
  const ports: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue
    const columns = line.trim().split(/\s+/)
    const pid = Number(columns[columns.length - 1])
    const localAddress = columns[1]
    if (!pids.has(pid) || !localAddress) continue
    const port = normalizePort(localAddress.match(/:(\d+)$/)?.[1])
    if (port && !IGNORED_PORTS.has(port)) ports.push(port)
  }
  return [...new Set(ports)].sort((a, b) => Number(a) - Number(b))
}

async function getUnixListeningPorts(rootPid: number) {
  const { stdout } = await execFileAsync('lsof', ['-Pan', '-p', String(rootPid), '-iTCP', '-sTCP:LISTEN'], { timeout: 6000 })
  return [...new Set(stdout.split(/\r?\n/)
    .map((line) => normalizePort(line.match(/:(\d+)\s+\(LISTEN\)/)?.[1]))
    .filter((port): port is string => Boolean(port))
    .filter((port) => !IGNORED_PORTS.has(port)))]
}

export async function detectRunningLocalUrl(pid?: number) {
  if (!pid) return undefined
  try {
    const ports = process.platform === 'win32'
      ? await getWindowsListeningPorts(await getWindowsDescendantPids(pid))
      : await getUnixListeningPorts(pid)
    return ports[0] ? localUrl(ports[0]) : undefined
  } catch {
    return undefined
  }
}

export async function detectLocalUrl(project: ProjectConfig, pid?: number) {
  return await detectRunningLocalUrl(pid) || detectConfiguredLocalUrl(project)
}
