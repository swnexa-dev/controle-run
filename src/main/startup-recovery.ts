import { promises as fs } from 'node:fs'
import path from 'node:path'

export const BACKGROUND_RECOVERY_ARGUMENT = '--background-recovery'

export function isBackgroundRecovery(args: string[]) {
  return args.includes(BACKGROUND_RECOVERY_ARGUMENT)
}

export function recoveryLoginItem(executablePath: string) {
  return {
    openAtLogin: true,
    enabled: true,
    name: 'Controle Run Recovery',
    path: executablePath,
    args: [BACKGROUND_RECOVERY_ARGUMENT]
  }
}

export async function appendRecoveryLog(userDataPath: string, status: 'success' | 'failed', message: string) {
  const logPath = path.join(userDataPath, 'startup-recovery.log')
  const safeMessage = message.replace(/[\r\n]+/g, ' ').slice(0, 4000)
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.appendFile(logPath, `${new Date().toISOString()} [${status.toUpperCase()}] ${safeMessage}\n`, 'utf8')
  return logPath
}
