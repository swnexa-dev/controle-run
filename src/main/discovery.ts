import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectConfig } from '../shared/types'

export interface DiscoveredProject extends ProjectConfig {
  packageName?: string
  availableScripts: string[]
}

export function mergeProjectConfig(item: DiscoveredProject, saved?: ProjectConfig): ProjectConfig {
  return {
    ...item,
    ...saved,
    path: item.path,
    pm2Name: item.pm2Name,
    npmCommand: saved?.npmScript === item.npmScript ? saved?.npmCommand || item.npmCommand : item.npmCommand
  }
}

const ENTRY_CANDIDATES = ['index.js', 'server.js', 'app.js', 'main.js', 'dist/index.js', 'build/index.js']

export function projectId(projectPath: string) {
  return createHash('sha1').update(path.resolve(projectPath).toLowerCase()).digest('hex').slice(0, 12)
}

export function chooseNpmScript(scripts: Record<string, string> = {}) {
  return ['start', 'serve', 'dev'].find((name) => Boolean(scripts[name]))
}

async function inspectService(projectPath: string, groupPath: string, groupName: string, serviceType: 'frontend' | 'backend' | 'root'): Promise<DiscoveredProject> {
  let pkg: { name?: string; version?: string; scripts?: Record<string, string>; main?: string } = {}
  try {
    pkg = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'))
  } catch { /* A configuração manual continua disponível. */ }

  const scripts = Object.keys(pkg.scripts ?? {})
  const npmScript = chooseNpmScript(pkg.scripts)
  const npmCommand = npmScript ? pkg.scripts?.[npmScript] : undefined
  let entry = pkg.main
  if (!npmScript && !entry) {
    for (const candidate of ENTRY_CANDIDATES) {
      try {
        await fs.access(path.join(projectPath, candidate))
        entry = candidate
        break
      } catch { /* tenta o próximo */ }
    }
  }

  const id = projectId(projectPath)
  const groupId = projectId(groupPath)
  const label = serviceType === 'root'
    ? (pkg.name || groupName)
    : serviceType === 'frontend' ? 'Frontend' : 'Backend'
  return {
    id,
    groupId,
    groupName,
    groupPath,
    serviceType,
    name: label,
    packageName: pkg.name,
    path: projectPath,
    pm2Name: `controle-run-${groupName}-${serviceType}-${id.slice(0, 6)}`.replace(/[^a-z0-9-_]/gi, '-').toLowerCase(),
    mode: npmScript ? 'npm' : 'script',
    npmScript,
    npmCommand,
    entry,
    autoStart: Boolean(npmScript || entry),
    detected: Boolean(npmScript || entry),
    availableScripts: scripts
  }
}

export async function discoverProjectFolder(groupPath: string): Promise<DiscoveredProject[]> {
    const groupName = path.basename(groupPath)
    const children = await fs.readdir(groupPath, { withFileTypes: true })
    const serviceFolders = children.filter((child) => child.isDirectory() && ['frontend', 'backend'].includes(child.name.toLowerCase()))

    // Mantém compatibilidade com projetos simples que não tenham a divisão em serviços.
    if (!serviceFolders.length) return [await inspectService(groupPath, groupPath, groupName, 'root')]

    return Promise.all(serviceFolders
      .sort((a, b) => a.name.toLowerCase() === 'frontend' ? -1 : b.name.toLowerCase() === 'frontend' ? 1 : 0)
      .map((service) => inspectService(
        path.join(groupPath, service.name),
        groupPath,
        groupName,
        service.name.toLowerCase() as 'frontend' | 'backend'
      )))
}

export async function discoverProjects(projectPaths: string[]): Promise<DiscoveredProject[]> {
  const groups = await Promise.all(projectPaths.map(async (projectPath) => {
    try { return await discoverProjectFolder(projectPath) }
    catch { return [] }
  }))
  return groups.flat()
}
