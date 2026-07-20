import { describe, expect, it } from 'vitest'
import { normalizeGitHubTarget, sanitizeRunnerName, selectWindowsRunnerPackage, suggestedRunnerPath } from './github-runner-service'

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
})
