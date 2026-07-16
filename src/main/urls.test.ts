import { describe, expect, it } from 'vitest'
import type { ProjectConfig } from '../shared/types'
import { detectConfiguredLocalUrl, detectLocalUrl } from './urls'

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
  autoStart: true,
  detected: true
}

describe('local service url detection', () => {
  it('detecta porta informada por argumento', () => {
    expect(detectConfiguredLocalUrl({ ...project, args: '--port 4100' })).toBe('http://localhost:4100')
  })

  it('detecta URL explicita no comando', () => {
    expect(detectConfiguredLocalUrl({ ...project, npmCommand: 'vite --host 0.0.0.0 --origin http://localhost:5174' })).toBe('http://localhost:5174')
  })

  it('usa a porta padrao do Vite para frontend quando nao ha porta explicita', () => {
    expect(detectConfiguredLocalUrl({ ...project, serviceType: 'frontend', npmCommand: 'vite', name: 'Frontend' })).toBe('http://localhost:5173')
  })

  it('usa fallback por comando quando nao ha PID em execucao', async () => {
    await expect(detectLocalUrl({ ...project, args: '--port 4100' })).resolves.toBe('http://localhost:4100')
  })
})
