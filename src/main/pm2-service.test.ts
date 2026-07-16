import { describe, expect, it } from 'vitest'
import type { ProjectConfig } from '../shared/types'
import { buildStartOptions } from './pm2-service'

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
  args: '--port 4100',
  autoStart: true,
  detected: true
}

describe('PM2 start options', () => {
  it('usa um executável compatível para scripts NPM no Windows', () => {
    const options = buildStartOptions(project, 'C:\\Users\\teste\\AppData\\Roaming\\controle-run\\pm2-hidden-runner.cjs')
    if (process.platform === 'win32') {
      expect(String(options.script).toLowerCase()).toMatch(/pm2-hidden-runner\.cjs$/)
      expect(options.args).toEqual(['node server.js --port 4100'])
      expect(options.interpreter).toBe(process.execPath)
    } else {
      expect(options.script).toBe('npm')
    }
  })
})
