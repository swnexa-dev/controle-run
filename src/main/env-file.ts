import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EnvVarDraft } from '../shared/types'

type EnvLine =
  | { type: 'raw'; text: string }
  | { type: 'var'; key: string; value: string; text: string }

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function envPath(projectPath: string) {
  return path.join(projectPath, '.env')
}

function parseValue(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseEnv(content: string): EnvLine[] {
  return content.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    return match ? { type: 'var', key: match[1], value: parseValue(match[2]), text: line } : { type: 'raw', text: line }
  })
}

function normalizeVariables(variables: EnvVarDraft[]) {
  const seen = new Set<string>()
  return variables.map((item) => ({ key: item.key.trim(), value: item.value })).filter((item) => item.key).map((item) => {
    if (!KEY_PATTERN.test(item.key)) throw new Error(`Chave inválida no .env: ${item.key}`)
    if (seen.has(item.key)) throw new Error(`Chave duplicada no .env: ${item.key}`)
    seen.add(item.key)
    return item
  })
}

function formatValue(value: string) {
  return /[\s#"'`]/.test(value) ? JSON.stringify(value) : value
}

function formatLine(variable: EnvVarDraft) {
  return `${variable.key}=${formatValue(variable.value)}`
}

export async function readEnvFile(projectPath: string): Promise<EnvVarDraft[]> {
  const content = await fs.readFile(envPath(projectPath), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return parseEnv(content).filter((line): line is Extract<EnvLine, { type: 'var' }> => line.type === 'var').map((line) => ({ key: line.key, value: line.value }))
}

export async function saveEnvFile(projectPath: string, variables: EnvVarDraft[]) {
  const nextVariables = normalizeVariables(variables)
  const nextByKey = new Map(nextVariables.map((item) => [item.key, item]))
  const consumed = new Set<string>()
  const file = envPath(projectPath)
  const existing = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })

  const existingWithoutTrailingNewline = existing.replace(/\r?\n$/, '')
  const lines = (existingWithoutTrailingNewline ? parseEnv(existingWithoutTrailingNewline) : [])
    .map((line) => {
      if (line.type === 'raw') return line.text
      const next = nextByKey.get(line.key)
      if (!next) return null
      if (consumed.has(line.key)) return null
      consumed.add(line.key)
      return formatLine(next)
    })
    .filter((line): line is string => line !== null)

  for (const variable of nextVariables) {
    if (!consumed.has(variable.key)) lines.push(formatLine(variable))
  }

  await fs.writeFile(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
}
