import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectConfig } from '../shared/types'

export interface Settings {
  projectPaths: string[]
  rootPath?: string | null
  projects: Record<string, ProjectConfig>
}

const EMPTY: Settings = { projectPaths: [], projects: {} }

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

export async function loadSettings(): Promise<Settings> {
  try {
    const content = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(content)
    return { ...EMPTY, ...parsed, projectPaths: parsed.projectPaths || [] }
  } catch {
    return structuredClone(EMPTY)
  }
}

export async function saveSettings(settings: Settings) {
  await fs.mkdir(path.dirname(filePath()), { recursive: true })
  await fs.writeFile(filePath(), JSON.stringify(settings, null, 2), 'utf8')
}
