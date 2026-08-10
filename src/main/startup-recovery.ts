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

interface WindowsLoginItemState {
  openAtLogin: boolean
  launchItems?: Array<{
    name?: string
    path: string
    args: string[]
    enabled: boolean
  }>
}

interface ExpectedLoginItem {
  name: string
  path: string
  args: string[]
}

function sameWindowsPath(first: string, second: string) {
  return path.win32.resolve(first).toLowerCase() === path.win32.resolve(second).toLowerCase()
}

export type StartupRecoveryRegistration = 'enabled' | 'disabled' | 'missing'

export function startupRecoveryRegistration(actual: WindowsLoginItemState, expected: ExpectedLoginItem): StartupRecoveryRegistration {
  const matchingItems = actual.launchItems?.filter((item) =>
    item.name?.toLowerCase() === expected.name.toLowerCase() &&
    sameWindowsPath(item.path, expected.path)
  ) || []
  if (matchingItems.some((item) => item.enabled)) return 'enabled'
  if (matchingItems.length) return 'disabled'
  // openAtLogin considera o path e os argumentos usados na consulta.
  if (actual.openAtLogin) return 'enabled'
  return 'missing'
}

export async function appendRecoveryLog(userDataPath: string, status: 'success' | 'failed', message: string) {
  const logPath = path.join(userDataPath, 'startup-recovery.log')
  const safeMessage = message.replace(/[\r\n]+/g, ' ').slice(0, 4000)
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.appendFile(logPath, `${new Date().toISOString()} [${status.toUpperCase()}] ${safeMessage}\n`, 'utf8')
  return logPath
}
