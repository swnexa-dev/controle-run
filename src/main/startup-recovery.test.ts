import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendRecoveryLog,
  BACKGROUND_RECOVERY_ARGUMENT,
  isBackgroundRecovery,
  recoveryLoginItem,
  startupRecoveryIsEnabled
} from './startup-recovery'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('recuperação no logon do Windows', () => {
  it('gera uma entrada de inicialização dedicada e detecta o modo sem interface', () => {
    const executable = 'C:\\Program Files\\Controle Run\\Controle Run.exe'
    expect(recoveryLoginItem(executable)).toEqual({
      openAtLogin: true,
      enabled: true,
      name: 'Controle Run Recovery',
      path: executable,
      args: [BACKGROUND_RECOVERY_ARGUMENT]
    })
    expect(isBackgroundRecovery(['Controle Run.exe', BACKGROUND_RECOVERY_ARGUMENT])).toBe(true)
    expect(isBackgroundRecovery(['Controle Run.exe'])).toBe(false)
  })

  it('mantém um registro local do resultado sem permitir injeção de linhas', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-recovery-test-'))
    directories.push(directory)
    const logPath = await appendRecoveryLog(directory, 'failed', 'falha\r\nforjada')
    const content = await fs.readFile(logPath, 'utf8')
    expect(content).toContain('[FAILED] falha forjada')
    expect(content.trim().split(/\r?\n/)).toHaveLength(1)
  })

  it('aceita a confirmação exata do Electron mesmo quando o indicador genérico do executável diverge', () => {
    const expected = recoveryLoginItem('C:\\Program Files\\Controle Run\\Controle Run.exe')
    expect(startupRecoveryIsEnabled({ openAtLogin: true }, expected)).toBe(true)
  })

  it('reconhece a entrada habilitada na lista do Windows como alternativa', () => {
    const expected = recoveryLoginItem('C:\\Program Files\\Controle Run\\Controle Run.exe')
    expect(startupRecoveryIsEnabled({
      openAtLogin: false,
      launchItems: [{
        path: 'c:\\program files\\controle run\\Controle Run.exe',
        args: [BACKGROUND_RECOVERY_ARGUMENT],
        enabled: true
      }]
    }, expected)).toBe(true)
  })

  it('rejeita uma entrada ausente ou desabilitada', () => {
    const expected = recoveryLoginItem('C:\\Program Files\\Controle Run\\Controle Run.exe')
    expect(startupRecoveryIsEnabled({ openAtLogin: false }, expected)).toBe(false)
    expect(startupRecoveryIsEnabled({
      openAtLogin: false,
      launchItems: [{ path: expected.path, args: expected.args, enabled: false }]
    }, expected)).toBe(false)
  })
})
