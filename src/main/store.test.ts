import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => testState.userData }
}))

import { clearSettings, loadSettings, saveSettings, type Settings } from './store'

const temporaryDirectories: string[] = []

beforeEach(async () => {
  testState.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-store-test-'))
  temporaryDirectories.push(testState.userData)
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function emptySettings(projectPaths: string[] = []): Settings {
  return { schemaVersion: 1, projectPaths, projects: {}, githubRunners: {}, cloudflareTunnels: {} }
}

describe('settings.json resiliente', () => {
  it('grava o arquivo principal e um backup validado com o mesmo conteúdo', async () => {
    await saveSettings(emptySettings(['C:\\apps\\portal']))
    const primary = JSON.parse(await fs.readFile(path.join(testState.userData, 'settings.json'), 'utf8'))
    const backup = JSON.parse(await fs.readFile(path.join(testState.userData, 'settings.json.bak'), 'utf8'))
    expect(primary).toEqual(backup)
    expect(primary).toMatchObject({ schemaVersion: 1, projectPaths: ['C:\\apps\\portal'] })
    expect((await fs.readdir(testState.userData)).some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it('recupera o cadastro pelo backup quando o arquivo principal é corrompido', async () => {
    await saveSettings(emptySettings(['C:\\apps\\api']))
    await fs.writeFile(path.join(testState.userData, 'settings.json'), '{arquivo-quebrado', 'utf8')
    await expect(loadSettings()).resolves.toMatchObject({ projectPaths: ['C:\\apps\\api'] })
    const repaired = JSON.parse(await fs.readFile(path.join(testState.userData, 'settings.json'), 'utf8'))
    expect(repaired.projectPaths).toEqual(['C:\\apps\\api'])
  })

  it('preserva os arquivos e informa erro quando principal e backup estão corrompidos', async () => {
    await saveSettings(emptySettings(['C:\\apps\\api']))
    await fs.writeFile(path.join(testState.userData, 'settings.json'), '{principal-quebrado', 'utf8')
    await fs.writeFile(path.join(testState.userData, 'settings.json.bak'), '{backup-quebrado', 'utf8')
    await expect(loadSettings()).rejects.toThrow('Nenhum cadastro foi apagado ou substituído')
    await expect(fs.readFile(path.join(testState.userData, 'settings.json'), 'utf8')).resolves.toBe('{principal-quebrado')
    await expect(fs.readFile(path.join(testState.userData, 'settings.json.bak'), 'utf8')).resolves.toBe('{backup-quebrado')
  })

  it('combina alterações concorrentes sem perder pastas adicionadas por outra operação', async () => {
    await saveSettings(emptySettings())
    const first = await loadSettings()
    const second = await loadSettings()
    first.projectPaths.push('C:\\apps\\frontend')
    second.projectPaths.push('C:\\apps\\backend')

    await Promise.all([saveSettings(first), saveSettings(second)])
    const persisted = await loadSettings()
    expect(persisted.projectPaths).toEqual(expect.arrayContaining(['C:\\apps\\frontend', 'C:\\apps\\backend']))
    expect(persisted.projectPaths).toHaveLength(2)
  })

  it('rejeita conteúdo com formato inválido em vez de iniciar com cadastro vazio', async () => {
    await fs.writeFile(path.join(testState.userData, 'settings.json'), JSON.stringify({ projectPaths: 'inválido' }), 'utf8')
    await expect(loadSettings()).rejects.toThrow('Nenhum cadastro foi apagado ou substituído')
  })

  it('limpa intencionalmente o cadastro principal e o backup sem apagar arquivos externos', async () => {
    await saveSettings(emptySettings(['C:\\apps\\portal']))

    await clearSettings()

    await expect(loadSettings()).resolves.toEqual(emptySettings())
    const backup = JSON.parse(await fs.readFile(path.join(testState.userData, 'settings.json.bak'), 'utf8'))
    expect(backup).toEqual(emptySettings())
  })
})
