import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readEnvFile, saveEnvFile } from './env-file'

const temporaryFolders: string[] = []
afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })))
})

async function tempProject() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-env-'))
  temporaryFolders.push(folder)
  return folder
}

describe('env file editor', () => {
  it('le variaveis existentes do .env', async () => {
    const folder = await tempProject()
    await fs.writeFile(path.join(folder, '.env'), '# comentario\nAPI_URL=http://localhost:3000\nTOKEN=\"abc 123\"\n')

    await expect(readEnvFile(folder)).resolves.toEqual([
      { key: 'API_URL', value: 'http://localhost:3000' },
      { key: 'TOKEN', value: 'abc 123' }
    ])
  })

  it('preserva comentarios, atualiza chaves e adiciona novas variaveis', async () => {
    const folder = await tempProject()
    await fs.writeFile(path.join(folder, '.env'), '# comentario\nAPI_URL=http://localhost:3000\n')

    await saveEnvFile(folder, [
      { key: 'API_URL', value: 'http://localhost:4102' },
      { key: 'FEATURE_FLAG', value: 'true' }
    ])

    await expect(fs.readFile(path.join(folder, '.env'), 'utf8')).resolves.toBe('# comentario\nAPI_URL=http://localhost:4102\nFEATURE_FLAG=true\n')
    await expect(fs.access(path.join(folder, '.env.backup'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
