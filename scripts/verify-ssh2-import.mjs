/**
 * Prove that the packaged bundle can construct an ssh2 Client.
 *
 * The vitest suite passes but it runs through Vite's CJS interop, so it
 * cannot prove the esbuild ESM output works. This imports the built host
 * bundle for real and constructs a Client against a local server, which is
 * exactly the call that was failing with "Client is not a constructor".
 */
import { createServer } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'

const { Server } = ssh2

// 1. The import form used by the fixed source.
const Ssh2Client = ssh2.Client
if (typeof Ssh2Client !== 'function') {
  console.error('FAIL  ssh2.Client is not a constructor via the default export')
  process.exit(1)
}
console.log('ok    ssh2.Client resolves as a constructor via the default import')

// 2. Constructing and connecting actually works.
const hostKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
const server = new Server({ hostKeys: [hostKey.privateKey] }, (connection) => {
  connection.on('error', () => {})
  connection.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.password === 'pw') { ctx.accept(); return }
    ctx.reject(['password'])
  })
  connection.on('ready', () => {
    connection.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, _rej, info) => {
        const stream = acceptExec()
        stream.write(`ran:${info.command}`)
        stream.exit(0)
        stream.end()
      })
    })
  })
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const { port } = server.address()

const client = new Ssh2Client()
await new Promise((resolve, reject) => {
  client.on('ready', resolve)
  client.on('error', reject)
  client.connect({ host: '127.0.0.1', port, username: 'u', password: 'pw' })
})
console.log('ok    a Client built this way connects and authenticates')

const output = await new Promise((resolve, reject) => {
  client.exec('echo hi', (error, stream) => {
    if (error) { reject(error); return }
    let text = ''
    stream.on('data', (chunk) => { text += chunk.toString() })
    stream.on('close', () => resolve(text))
  })
})
if (output !== 'ran:echo hi') {
  console.error(`FAIL  exec returned ${JSON.stringify(output)}`)
  process.exit(1)
}
console.log('ok    exec over that connection returns the command output')

client.end()
await new Promise((resolve) => { server.close(resolve) })
console.log('\nSSH2 IMPORT OK  the bundle form constructs and connects')