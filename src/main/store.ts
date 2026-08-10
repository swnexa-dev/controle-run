import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GitHubRunnerConfig, ProjectConfig, StoredCloudflareTunnelConfig } from '../shared/types'

export interface Settings {
  schemaVersion?: 1
  projectPaths: string[]
  rootPath?: string | null
  projects: Record<string, ProjectConfig>
  githubRunners: Record<string, GitHubRunnerConfig>
  cloudflareTunnels: Record<string, StoredCloudflareTunnelConfig>
}

interface SettingsMetadata {
  baseline: Settings
}

interface PatchOperation {
  path: string[]
  kind: 'set' | 'delete' | 'merge-string-array'
  value?: unknown
  added?: string[]
  removed?: string[]
}

const SETTINGS_METADATA = Symbol('controle-run-settings-metadata')
const EMPTY: Settings = { schemaVersion: 1, projectPaths: [], projects: {}, githubRunners: {}, cloudflareTunnels: {} }
let storeQueue: Promise<void> = Promise.resolve()

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function backupPath() {
  return `${filePath()}.bak`
}

function cloneSettings(settings: Settings): Settings {
  return structuredClone(settings)
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} precisa ser um objeto.`)
  return value as Record<string, unknown>
}

function stringOf(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} precisa ser um texto não vazio.`)
  return value
}

function optionalStringOf(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} precisa ser um texto.`)
  return value
}

function booleanOf(value: unknown, label: string, fallback?: boolean) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label} precisa ser verdadeiro ou falso.`)
  return value
}

function enumOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} contém um valor inválido.`)
  return value as T
}

function stringArrayOf(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} precisa ser uma lista de textos.`)
  return [...new Set(value)] as string[]
}

function projectOf(value: unknown, key: string): ProjectConfig {
  const item = recordOf(value, `Projeto ${key}`)
  const id = stringOf(item.id, `ID do projeto ${key}`)
  if (id !== key) throw new Error(`O ID interno do projeto ${key} não corresponde à chave do cadastro.`)
  return {
    id,
    groupId: stringOf(item.groupId, `Grupo do projeto ${key}`),
    groupName: stringOf(item.groupName, `Nome do grupo ${key}`),
    groupPath: stringOf(item.groupPath, `Pasta do grupo ${key}`),
    serviceType: enumOf(item.serviceType, `Tipo do projeto ${key}`, ['frontend', 'backend', 'root']),
    name: stringOf(item.name, `Nome do projeto ${key}`),
    path: stringOf(item.path, `Pasta do projeto ${key}`),
    pm2Name: stringOf(item.pm2Name, `Nome PM2 do projeto ${key}`),
    mode: enumOf(item.mode, `Modo do projeto ${key}`, ['npm', 'script']),
    npmScript: optionalStringOf(item.npmScript, `Script npm do projeto ${key}`),
    npmCommand: optionalStringOf(item.npmCommand, `Comando npm do projeto ${key}`),
    buildScript: optionalStringOf(item.buildScript, `Build do projeto ${key}`),
    buildOnDeploy: booleanOf(item.buildOnDeploy, `Build automático do projeto ${key}`, false),
    installDependenciesOnDeploy: booleanOf(item.installDependenciesOnDeploy, `Dependências do projeto ${key}`, true),
    entry: optionalStringOf(item.entry, `Entrada do projeto ${key}`),
    args: optionalStringOf(item.args, `Argumentos do projeto ${key}`),
    autoStart: booleanOf(item.autoStart, `Inicialização do projeto ${key}`),
    detected: booleanOf(item.detected, `Detecção do projeto ${key}`)
  }
}

function runnerOf(value: unknown, key: string): GitHubRunnerConfig {
  const item = recordOf(value, `Runner ${key}`)
  const id = stringOf(item.id, `ID do runner ${key}`)
  if (id !== key) throw new Error(`O ID interno do runner ${key} não corresponde à chave do cadastro.`)
  return {
    id,
    name: stringOf(item.name, `Nome do runner ${key}`),
    scope: enumOf(item.scope, `Escopo do runner ${key}`, ['organization', 'repository']),
    targetUrl: stringOf(item.targetUrl, `URL do runner ${key}`),
    installPath: stringOf(item.installPath, `Pasta do runner ${key}`),
    workFolder: stringOf(item.workFolder, `Pasta de trabalho do runner ${key}`),
    labels: stringArrayOf(item.labels, `Labels do runner ${key}`),
    routingLabel: optionalStringOf(item.routingLabel, `Label exclusiva do runner ${key}`),
    serviceAccount: stringOf(item.serviceAccount, `Conta do runner ${key}`),
    serviceName: optionalStringOf(item.serviceName, `Serviço do runner ${key}`),
    managementId: optionalStringOf(item.managementId, `Identidade administrativa do runner ${key}`),
    installedVersion: stringOf(item.installedVersion, `Versão do runner ${key}`),
    projectGroupId: optionalStringOf(item.projectGroupId, `Projeto do runner ${key}`),
    createdAt: stringOf(item.createdAt, `Criação do runner ${key}`)
  }
}

function tunnelOf(value: unknown, key: string): StoredCloudflareTunnelConfig {
  const item = recordOf(value, `Túnel ${key}`)
  const id = stringOf(item.id, `ID do túnel ${key}`)
  if (id !== key) throw new Error(`O ID interno do túnel ${key} não corresponde à chave do cadastro.`)
  return {
    id,
    name: stringOf(item.name, `Nome do túnel ${key}`),
    projectId: stringOf(item.projectId, `Projeto do túnel ${key}`),
    originUrl: stringOf(item.originUrl, `Origem do túnel ${key}`),
    publicUrl: optionalStringOf(item.publicUrl, `URL pública do túnel ${key}`),
    mode: enumOf(item.mode, `Modo do túnel ${key}`, ['quick', 'token']),
    protocol: enumOf(item.protocol, `Protocolo do túnel ${key}`, ['auto', 'quic', 'http2']),
    logLevel: enumOf(item.logLevel, `Log do túnel ${key}`, ['debug', 'info', 'warn', 'error']),
    autoStart: booleanOf(item.autoStart, `Inicialização do túnel ${key}`),
    createdAt: stringOf(item.createdAt, `Criação do túnel ${key}`),
    encryptedToken: optionalStringOf(item.encryptedToken, `Token protegido do túnel ${key}`)
  }
}

function recordEntriesOf<T>(value: unknown, label: string, normalize: (item: unknown, key: string) => T): Record<string, T> {
  const source = recordOf(value, label)
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, normalize(item, key)]))
}

export function normalizeSettings(value: unknown): Settings {
  const parsed = recordOf(value, 'O settings.json')
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) throw new Error('A versão do settings.json não é compatível com este Controle Run.')
  const rootPath = parsed.rootPath === null ? null : optionalStringOf(parsed.rootPath, 'Pasta legada')
  return {
    schemaVersion: 1,
    projectPaths: stringArrayOf(parsed.projectPaths ?? [], 'Pastas de projetos'),
    rootPath,
    projects: recordEntriesOf(parsed.projects ?? {}, 'Projetos', projectOf),
    githubRunners: recordEntriesOf(parsed.githubRunners ?? {}, 'Runners', runnerOf),
    cloudflareTunnels: recordEntriesOf(parsed.cloudflareTunnels ?? {}, 'Túneis', tunnelOf)
  }
}

function attachMetadata(settings: Settings, baseline = settings) {
  Object.defineProperty(settings, SETTINGS_METADATA, {
    value: { baseline: cloneSettings(baseline) } satisfies SettingsMetadata,
    configurable: true,
    writable: true,
    enumerable: false
  })
  return settings
}

function metadataOf(settings: Settings) {
  return (settings as Settings & { [SETTINGS_METADATA]?: SettingsMetadata })[SETTINGS_METADATA]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function collectPatch(base: unknown, next: unknown, currentPath: string[] = [], result: PatchOperation[] = []): PatchOperation[] {
  if (JSON.stringify(base) === JSON.stringify(next)) return result
  if (Array.isArray(base) && Array.isArray(next) && base.every((item) => typeof item === 'string') && next.every((item) => typeof item === 'string')) {
    result.push({
      path: currentPath,
      kind: 'merge-string-array',
      added: next.filter((item) => !base.includes(item)),
      removed: base.filter((item) => !next.includes(item))
    })
    return result
  }
  if (isRecord(base) && isRecord(next)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (!(key in next)) result.push({ path: [...currentPath, key], kind: 'delete' })
      else if (!(key in base)) result.push({ path: [...currentPath, key], kind: 'set', value: structuredClone(next[key]) })
      else collectPatch(base[key], next[key], [...currentPath, key], result)
    }
    return result
  }
  result.push({ path: currentPath, kind: 'set', value: structuredClone(next) })
  return result
}

function parentFor(root: Record<string, unknown>, operationPath: string[]) {
  let parent = root
  for (const segment of operationPath.slice(0, -1)) {
    if (!isRecord(parent[segment])) parent[segment] = {}
    parent = parent[segment] as Record<string, unknown>
  }
  return parent
}

function applyPatch(current: Settings, operations: PatchOperation[]) {
  const result = cloneSettings(current) as unknown as Record<string, unknown>
  for (const operation of operations) {
    if (!operation.path.length) {
      if (operation.kind !== 'set') throw new Error('Alteração inválida no cadastro local.')
      return normalizeSettings(operation.value)
    }
    const parent = parentFor(result, operation.path)
    const key = operation.path.at(-1)!
    if (operation.kind === 'delete') delete parent[key]
    else if (operation.kind === 'set') parent[key] = structuredClone(operation.value)
    else {
      const currentArray = Array.isArray(parent[key]) ? parent[key].filter((item): item is string => typeof item === 'string') : []
      parent[key] = [...new Set(currentArray.filter((item) => !operation.removed?.includes(item)).concat(operation.added || []))]
    }
  }
  return normalizeSettings(result)
}

async function readAndValidate(candidate: string) {
  const content = await fs.readFile(candidate, 'utf8')
  return normalizeSettings(JSON.parse(content.replace(/^\uFEFF/, '')))
}

async function loadSettingsUnlocked(): Promise<Settings> {
  try {
    return await readAndValidate(filePath())
  } catch (primaryError) {
    const code = (primaryError as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      let recovered: Settings
      try {
        recovered = await readAndValidate(backupPath())
      } catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return cloneSettings(EMPTY)
        throw new Error('O backup do settings.json está corrompido. Os arquivos foram preservados para recuperação manual.', { cause: backupError })
      }
      console.warn('settings.json ausente; restaurando o cadastro pelo backup validado.')
      await writeSettingsUnlocked(recovered).catch((error) => console.error('Não foi possível reparar o settings.json pelo backup:', error))
      return recovered
    }
    let recovered: Settings
    try {
      recovered = await readAndValidate(backupPath())
    } catch (backupError) {
      throw new Error('O settings.json e seu backup estão corrompidos ou inacessíveis. Nenhum cadastro foi apagado ou substituído.', {
        cause: new AggregateError([primaryError as Error, backupError as Error])
      })
    }
    console.warn('settings.json inválido; restaurando o cadastro pelo backup validado.')
    await writeSettingsUnlocked(recovered).catch((error) => console.error('Não foi possível reparar o settings.json pelo backup:', error))
    return recovered
  }
}

async function writeAndFlush(destination: string, content: string) {
  const handle = await fs.open(destination, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeSettingsUnlocked(settings: Settings) {
  const normalized = normalizeSettings(settings)
  const directory = path.dirname(filePath())
  const suffix = `${process.pid}-${randomUUID()}.tmp`
  const primaryTemporary = path.join(directory, `settings.${suffix}`)
  const backupTemporary = path.join(directory, `settings-backup.${suffix}`)
  const content = `${JSON.stringify(normalized, null, 2)}\n`
  await fs.mkdir(directory, { recursive: true })
  try {
    await writeAndFlush(primaryTemporary, content)
    await writeAndFlush(backupTemporary, content)
    await readAndValidate(primaryTemporary)
    await readAndValidate(backupTemporary)
    await fs.rename(primaryTemporary, filePath())
    await fs.rename(backupTemporary, backupPath())
  } finally {
    await Promise.all([
      fs.rm(primaryTemporary, { force: true }).catch(() => undefined),
      fs.rm(backupTemporary, { force: true }).catch(() => undefined)
    ])
  }
  return normalized
}

function withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = storeQueue.then(operation, operation)
  storeQueue = result.then(() => undefined, () => undefined)
  return result
}

export async function loadSettings(): Promise<Settings> {
  return withStoreLock(async () => {
    const settings = await loadSettingsUnlocked()
    return attachMetadata(settings)
  })
}

export async function saveSettings(settings: Settings) {
  return withStoreLock(async () => {
    const requested = normalizeSettings(settings)
    const metadata = metadataOf(settings)
    const current = await loadSettingsUnlocked()
    const merged = metadata
      ? applyPatch(current, collectPatch(metadata.baseline, requested))
      : requested
    await writeSettingsUnlocked(merged)
    // O objeto do chamador continua representando apenas as alterações que ele conhecia.
    // Usá-lo como nova base evita que uma gravação posterior apague dados concorrentes
    // incorporados ao arquivo durante o merge acima.
    attachMetadata(settings, requested)
  })
}
