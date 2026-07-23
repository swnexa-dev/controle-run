import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ADMIN_HELPER, adminExchangePaths, isRunnerVersionProbeLog, normalizeGitHubTarget, protectAdminRequest, sanitizeRunnerName, selectWindowsRunnerPackage, suggestedRunnerPath } from './github-runner-service'

const execute = promisify(execFile)

describe('GitHub runner configuration', () => {
  it('normalizes organization and repository targets', () => {
    expect(normalizeGitHubTarget('https://github.com/swnexa-dev/', 'organization')).toBe('https://github.com/swnexa-dev')
    expect(normalizeGitHubTarget('https://github.com/swnexa-dev/teste1.git', 'repository')).toBe('https://github.com/swnexa-dev/teste1')
    expect(() => normalizeGitHubTarget('https://example.com/swnexa-dev', 'organization')).toThrow()
    expect(() => normalizeGitHubTarget('https://github.com/swnexa-dev/teste1', 'organization')).toThrow()
  })

  it('builds safe runner names and installation paths', () => {
    expect(sanitizeRunnerName('Servidor Produção / 01')).toBe('Servidor-Produ-o-01')
    expect(suggestedRunnerPath('runner-01')).toBe('C:\\actions-runners\\runner-01')
  })

  it('selects the Windows x64 asset and its official digest', () => {
    expect(selectWindowsRunnerPackage({
      tag_name: 'v2.335.1',
      assets: [{
        name: 'actions-runner-win-x64-2.335.1.zip',
        browser_download_url: 'https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-win-x64-2.335.1.zip',
        digest: 'sha256:eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d'
      }]
    })).toMatchObject({ version: '2.335.1', sha256: 'eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d' })
  })

  it('distinguishes service logs from version-probe logs', () => {
    expect(isRunnerVersionProbeLog("[CommandLineParser] arg: version\n[CommandSettings] Flag 'version': 'True'")).toBe(true)
    expect(isRunnerVersionProbeLog('[MessageListener] Listening for Jobs')).toBe(false)
  })

  it('uses a stable application exchange directory instead of the Windows temp folder', () => {
    const basePath = path.join('stable-profile', 'controle-run')
    expect(adminExchangePaths(basePath, 'operation-1')).toEqual({
      exchangeDir: path.join(basePath, 'runner-admin-exchange'),
      requestPath: path.join(basePath, 'runner-admin-exchange', 'operation-1.request.bin'),
      resultPath: path.join(basePath, 'runner-admin-exchange', 'operation-1.result.json')
    })
  })

  it.runIf(process.platform === 'win32')('writes the administrative request atomically and encrypted', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-admin-test-'))
    const requestPath = path.join(directory, 'request.bin')
    try {
      await protectAdminRequest(requestPath, { registrationToken: 'temporary-test-token' })
      const protectedContent = await fs.readFile(requestPath)
      expect(protectedContent.length).toBeGreaterThan(0)
      expect(protectedContent.toString('utf8')).not.toContain('temporary-test-token')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('keeps the elevated helper valid PowerShell after deployment changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-helper-test-'))
    const helperPath = path.join(directory, 'helper.ps1')
    try {
      await fs.writeFile(helperPath, ADMIN_HELPER, 'utf8')
      const parser = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:HELPER_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
      await expect(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { env: { ...process.env, HELPER_SCRIPT: helperPath } })).resolves.toBeTruthy()
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
