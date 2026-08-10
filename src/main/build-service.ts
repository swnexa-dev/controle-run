import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectConfig } from '../shared/types'

interface ProcessResult {
  code: number
  output: string
}

function runProcess(file: string, args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, output: output.trim() }))
  })
}

async function executeNpm(args: string[], cwd: string) {
  const candidates = process.platform === 'win32'
    ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'npm.cmd') : '',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm', 'npm.cmd') : ''
      ].filter(Boolean)
    : []
  let command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true).catch(() => false)) {
      command = candidate
      break
    }
  }
  const result = await runProcess(command, args, cwd)
  if (result.code !== 0) {
    throw new Error(`O comando npm ${args.join(' ')} falhou (código ${result.code}).${result.output ? `\n${result.output}` : ''}`)
  }
  return result.output
}

export async function buildProject(project: ProjectConfig) {
  if (!project.buildScript) throw new Error('Selecione um script de build na configuração deste serviço.')
  const packageJson = path.join(project.path, 'package.json')
  await fs.access(packageJson).catch(() => { throw new Error('O package.json deste serviço não foi encontrado.') })

  const nodeModules = path.join(project.path, 'node_modules')
  const dependenciesInstalled = await fs.access(nodeModules).then(() => true).catch(() => false)
  if (!dependenciesInstalled) {
    const hasLockfile = await fs.access(path.join(project.path, 'package-lock.json')).then(() => true).catch(() => false)
    await executeNpm(hasLockfile ? ['ci'] : ['install'], project.path)
  }

  return executeNpm(['run', project.buildScript], project.path)
}
