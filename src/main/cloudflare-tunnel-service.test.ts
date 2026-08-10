import { describe, expect, it } from 'vitest'
import { quickUrlFromLog, sanitizeTunnelName, selectCloudflaredPackage } from './cloudflare-tunnel-service'

describe('Cloudflare Tunnel configuration', () => {
  it('normaliza nomes seguros para processos locais', () => {
    expect(sanitizeTunnelName(' Meu projeto / produção ')).toBe('Meu-projeto-produ-o')
    expect(sanitizeTunnelName('api_backend-01')).toBe('api_backend-01')
  })

  it('seleciona o executável Windows x64 e exige verificação SHA-256', () => {
    const digest = 'a'.repeat(64)
    expect(selectCloudflaredPackage({
      tag_name: '2026.7.0',
      assets: [{ name: 'cloudflared-windows-amd64.exe', browser_download_url: 'https://example.invalid/cloudflared.exe', digest: `sha256:${digest}` }]
    })).toMatchObject({ version: '2026.7.0', sha256: digest })

    expect(selectCloudflaredPackage({
      tag_name: '2026.7.0',
      body: `SHA256 Checksums:\ncloudflared-windows-amd64.exe: ${digest}`,
      assets: [{ name: 'cloudflared-windows-amd64.exe', browser_download_url: 'https://example.invalid/cloudflared.exe' }]
    })).toMatchObject({ sha256: digest })

    expect(selectCloudflaredPackage({
      tag_name: '2026.7.0',
      assets: [
        { name: 'cloudflared-windows-amd64.exe', browser_download_url: 'https://example.invalid/cloudflared.exe' },
        { name: 'cloudflared-windows-amd64.exe.sha256', browser_download_url: 'https://example.invalid/cloudflared.exe.sha256' }
      ]
    })).toMatchObject({ checksumUrl: 'https://example.invalid/cloudflared.exe.sha256' })

    expect(() => selectCloudflaredPackage({
      tag_name: '2026.7.0',
      assets: [{ name: 'cloudflared-windows-amd64.exe', browser_download_url: 'https://example.invalid/cloudflared.exe' }]
    })).toThrow('SHA-256')
  })

  it('usa o endereço temporário mais recente encontrado nos logs', () => {
    const log = [
      'Your quick Tunnel has been created! Visit it at https://old-name.trycloudflare.com',
      'Your quick Tunnel has been created! Visit it at https://new-name.trycloudflare.com'
    ].join('\n')
    expect(quickUrlFromLog(log)).toBe('https://new-name.trycloudflare.com')
  })
})
