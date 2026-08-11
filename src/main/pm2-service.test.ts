import { describe, expect, it } from 'vitest'
import type { ProjectConfig } from '../shared/types'
import { buildStartOptions, launchMatches, MAX_START_ATTEMPTS, waitForManagedProcessRemoval } from './pm2-service'

const project: ProjectConfig = {
  id: 'service-id',
  groupId: 'group-id',
  groupName: 'projeto teste',
  groupPath: 'C:\\apps teste\\projeto',
  serviceType: 'backend',
  name: 'Backend',
  path: 'C:\\apps teste\\projeto\\backend',
  pm2Name: 'controle-run-projeto-backend',
  mode: 'npm',
  npmScript: 'start',
  npmCommand: 'node server.js',
  buildScript: 'build',
  buildOnDeploy: true,
  installDependenciesOnDeploy: true,
  args: '--port 4100',
  autoStart: true,
  detected: true
}

describe('PM2 start options', () => {
  it('usa um executável compatível para scripts NPM no Windows', () => {
    const options = buildStartOptions(project, 'C:\\Users\\teste\\AppData\\Roaming\\controle-run\\pm2-hidden-runner.cjs')
    if (process.platform === 'win32') {
      expect(String(options.script).toLowerCase()).toMatch(/pm2-hidden-runner\.cjs$/)
      expect(options.args).toEqual(['npm run start -- --port 4100'])
      expect(options.interpreter).toBe(process.execPath)
    } else {
      expect(options.script).toBe('npm')
    }
    expect(options.max_restarts).toBe(MAX_START_ATTEMPTS)
    expect(options.min_uptime).toBe(10_000)
    expect(options.restart_delay).toBe(1_000)
  })

  it('mantém o processo existente quando caminho, script e argumentos não mudaram', () => {
    const options = buildStartOptions(project, 'C:\\Users\\teste\\AppData\\Roaming\\controle-run\\pm2-hidden-runner.cjs')
    const current = {
      pm2_env: {
        pm_exec_path: options.script,
        pm_cwd: options.cwd,
        args: options.args
      }
    }
    expect(launchMatches(current as never, options)).toBe(true)
    expect(launchMatches({ pm2_env: { ...current.pm2_env, args: ['outro comando'] } } as never, options)).toBe(false)
  })

  it('só confirma a remoção depois que o processo desaparece do PM2', async () => {
    let reads = 0
    await expect(waitForManagedProcessRemoval('processo-teste', async () => {
      reads += 1
      return reads < 3 ? [{ name: 'processo-teste' }] : []
    }, { attempts: 3, intervalMs: 0 })).resolves.toBeUndefined()
    expect(reads).toBe(3)
  })

  it('falha e preserva o cadastro quando o processo continua no PM2', async () => {
    await expect(waitForManagedProcessRemoval(
      'processo-persistente',
      async () => [{ name: 'processo-persistente' }],
      { attempts: 2, intervalMs: 0 }
    )).rejects.toThrow('cadastro foi preservado')
  })
})
