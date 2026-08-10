import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chooseNpmScript, discoverProjects, mergeProjectConfig, projectId } from './discovery'

const temporaryFolders: string[] = []
afterEach(async () => {
  await Promise.all(temporaryFolders.splice(0).map((folder) => fs.rm(folder, { recursive: true, force: true })))
})

describe('discovery', () => {
  it('prioriza scripts adequados para execução contínua', () => {
    expect(chooseNpmScript({ dev: 'vite', start: 'node index.js' })).toBe('start')
    expect(chooseNpmScript({ dev: 'vite' })).toBe('dev')
  })

  it('gera identificadores estáveis por caminho', () => {
    expect(projectId('C:/apps/api')).toBe(projectId('C:/apps/api'))
    expect(projectId('C:/apps/api')).not.toBe(projectId('C:/apps/web'))
  })

  it('carrega um serviço novo mesmo sem configuração salva', () => {
    const discovered = {
      id: 'service-1', groupId: 'group-1', groupName: 'Projeto', groupPath: 'C:\\apps\\projeto',
      serviceType: 'root' as const, name: 'Projeto', path: 'C:\\apps\\projeto', pm2Name: 'controle-run-projeto',
      mode: 'script' as const, entry: 'server.js', buildOnDeploy: false, installDependenciesOnDeploy: true, autoStart: true, detected: true, availableScripts: []
    }
    expect(() => mergeProjectConfig(discovered)).not.toThrow()
    expect(mergeProjectConfig(discovered)).toMatchObject({ pm2Name: 'controle-run-projeto', entry: 'server.js' })
  })

  it('descobre frontend e backend como serviços separados do mesmo projeto', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-'))
    temporaryFolders.push(root)
    const frontend = path.join(root, 'meu-projeto', 'frontend')
    const backend = path.join(root, 'meu-projeto', 'backend')
    await fs.mkdir(frontend, { recursive: true })
    await fs.mkdir(backend, { recursive: true })
    await fs.writeFile(path.join(frontend, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    await fs.writeFile(path.join(backend, 'package.json'), JSON.stringify({ scripts: { start: 'node server.js' } }))

    const services = await discoverProjects([path.join(root, 'meu-projeto')])

    expect(services).toHaveLength(2)
    expect(services.map((service) => service.serviceType)).toEqual(['frontend', 'backend'])
    expect(new Set(services.map((service) => service.groupId)).size).toBe(1)
    expect(new Set(services.map((service) => service.pm2Name)).size).toBe(2)
    expect(services.every((service) => service.installDependenciesOnDeploy)).toBe(true)
  })
})
