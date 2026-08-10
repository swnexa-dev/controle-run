import { execFile } from 'node:child_process'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ADMIN_HELPER, adminExchangePaths, isRunnerVersionProbeLog, normalizeGitHubTarget, protectAdminRequest, sanitizeRunnerName, selectWindowsRunnerPackage, suggestedRunnerPath } from './github-runner-service'
import { ADMIN_HELPER_PUBLIC_KEY, ADMIN_HELPER_SHA256, ADMIN_HELPER_SIGNATURE } from './admin-helper-integrity.generated'

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
      const request = {
        registrationToken: 'temporary-test-token',
        deployScript: 'Falha com código, configuração e ação.'
      }
      await protectAdminRequest(requestPath, request)
      const protectedContent = await fs.readFile(requestPath)
      expect(protectedContent.length).toBeGreaterThan(0)
      expect(protectedContent.toString('utf8')).not.toContain('temporary-test-token')

      const unprotect = String.raw`
Add-Type -AssemblyName System.Security
$encrypted = [System.IO.File]::ReadAllBytes($env:REQUEST_PATH)
$clear = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::LocalMachine
)
[Console]::Write([System.Convert]::ToBase64String($clear))
`.trim()
      const { stdout } = await execute('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', unprotect
      ], { env: { ...process.env, REQUEST_PATH: requestPath } })
      expect(JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'))).toEqual(request)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it.runIf(process.platform === 'win32')('keeps the elevated helper valid PowerShell after deployment changes', async () => {
    const helperPath = path.resolve('build-resources', 'admin', 'runner-admin-helper.ps1')
    const helperBytes = await fs.readFile(helperPath)
    const helperText = helperBytes.toString('utf8').replace(/^\uFEFF/, '')
    expect(helperText).toBe(ADMIN_HELPER)
    expect(helperText).toContain('Resolve-SafeRunnerPath')
    expect(helperText).toContain('Get-RunnerIdentity')
    expect(helperText).toContain('Get-FileHash -LiteralPath $zipPath -Algorithm SHA256')
    expect(helperText).toContain('WaitForStatus($ExpectedStatus, [TimeSpan]::FromSeconds(30))')
    expect(createHash('sha256').update(helperBytes).digest('hex')).toBe(ADMIN_HELPER_SHA256)
    expect(verify('sha256', helperBytes, createPublicKey(ADMIN_HELPER_PUBLIC_KEY), Buffer.from(ADMIN_HELPER_SIGNATURE, 'base64'))).toBe(true)
    const parser = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:HELPER_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
    await expect(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { env: { ...process.env, HELPER_SCRIPT: helperPath } })).resolves.toBeTruthy()
  })

  it.runIf(process.platform === 'win32')('rejects an arbitrary protected folder before a runner removal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'controle-run-remove-guard-'))
    const requestPath = path.join(directory, 'request.bin')
    const resultPath = path.join(directory, 'result.json')
    const helperPath = path.resolve('build-resources', 'admin', 'runner-admin-helper.ps1')
    try {
      await protectAdminRequest(requestPath, {
        operation: 'remove',
        installPath: process.env.SystemRoot || 'C:\\Windows',
        expectedName: 'runner-test',
        expectedTargetUrl: 'https://github.com/example/project',
        removalToken: 'temporary-token'
      })
      await execute('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', helperPath,
        '-RequestPath', requestPath,
        '-ResultPath', resultPath
      ]).catch(() => undefined)
      const result = JSON.parse(await fs.readFile(resultPath, 'utf8')) as { ok: boolean; message: string }
      expect(result.ok).toBe(false)
      expect(result.message).toContain('pasta protegida do Windows')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
