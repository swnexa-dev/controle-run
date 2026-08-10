const { createHash, generateKeyPairSync, sign } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const servicePath = path.join(projectRoot, 'src', 'main', 'github-runner-service.ts')
const helperPath = path.join(projectRoot, 'build-resources', 'admin', 'runner-admin-helper.ps1')
const generatedPath = path.join(projectRoot, 'src', 'main', 'admin-helper-integrity.generated.ts')
const source = readFileSync(servicePath, 'utf8')
const match = source.match(/export const ADMIN_HELPER = String\.raw`([\s\S]*?)`\.trimStart\(\)/)

if (!match) throw new Error('ADMIN_HELPER não foi encontrado em github-runner-service.ts.')

// O conteúdo é controlado pelo projeto. A avaliação reproduz exatamente o String.raw
// usado pelo TypeScript, inclusive os escapes necessários para ${...} do PowerShell.
const helperText = Function(`"use strict"; return String.raw\`${match[1]}\`.trimStart()`)()
const helperBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(helperText, 'utf8')])
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
const signature = sign('sha256', helperBytes, privateKey)
const sha256 = createHash('sha256').update(helperBytes).digest('hex')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' })

mkdirSync(path.dirname(helperPath), { recursive: true })
writeFileSync(helperPath, helperBytes)
writeFileSync(generatedPath, [
  '// Gerado por scripts/prepare-admin-helper.cjs. Não edite manualmente.',
  `export const ADMIN_HELPER_SHA256 = '${sha256}'`,
  `export const ADMIN_HELPER_SIGNATURE = '${signature.toString('base64')}'`,
  `export const ADMIN_HELPER_PUBLIC_KEY = ${JSON.stringify(publicKeyPem)}`,
  ''
].join('\n'), 'utf8')

console.log(`Helper administrativo preparado e assinado: ${sha256}`)
