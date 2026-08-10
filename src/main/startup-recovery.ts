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
    path: string
    args: string[]
    enabled: boolean
  }>
}

interface ExpectedLoginItem {
  path: string
  args: string[]
}

function sameWindowsPath(first: string, second: string) {
  return path.win32.resolve(first).toLowerCase() === path.win32.resolve(second).toLowerCase()
}

export function startupRecoveryIsEnabled(actual: WindowsLoginItemState, expected: ExpectedLoginItem) {
  // openAtLogin já considera o mesmo path e os mesmos argumentos informados
  // ao getLoginItemSettings. launchItems funciona como alternativa em versões
  // do Windows nas quais esse indicador demora a refletir a entrada recém-criada.
  if (actual.openAtLogin) return true
  return Boolean(actual.launchItems?.some((item) =>
    item.enabled &&
    sameWindowsPath(item.path, expected.path) &&
    item.args.length === expected.args.length &&
    item.args.every((argument, index) => argument === expected.args[index])
  ))
}

export async function appendRecoveryLog(userDataPath: string, status: 'success' | 'failed', message: string) {
  const logPath = path.join(userDataPath, 'startup-recovery.log')
  const safeMessage = message.replace(/[\r\n]+/g, ' ').slice(0, 4000)
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.appendFile(logPath, `${new Date().toISOString()} [${status.toUpperCase()}] ${safeMessage}\n`, 'utf8')
  return logPath
}
