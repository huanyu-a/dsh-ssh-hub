/**
 * Serve the harness page and proxy the panel's API to the running plugin.
 *
 * Two jobs, both needed:
 *
 *  1. A file:// page cannot fetch http://127.0.0.1:51697 — different origin, and
 *     the plugin answers without CORS headers. Serving the harness over HTTP from
 *     the same origin as a /api/dsh-ssh proxy means the components run their real
 *     request paths unmodified.
 *  2. The harness renders the ACTUAL components, so it must answer their calls
 *     with the ACTUAL data: everything under /api/dsh-ssh is forwarded verbatim
 *     to the live plugin, including POST bodies.
 *
 * The terminal tab opens a WebSocket; that is proxied too, so the tab can connect
 * rather than render a permanent error.
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const TARGET = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:51697'
const PORT = Number(process.env.HARNESS_PORT ?? 5179)
const ROOT = process.argv[2]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
}

/** Forward one HTTP request to the plugin, body and headers included. */
function proxyHttp(req, res) {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const url = `${TARGET}${req.url}`
    const headers = { ...req.headers }
    delete headers.host
    delete headers.origin
    delete headers.referer
    fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
      .then(async response => {
        const buffer = Buffer.from(await response.arrayBuffer())
        // The harness is same-origin, but send permissive CORS anyway so the
        // page also works when opened directly from file://.
        res.writeHead(response.status, {
          'content-type': response.headers.get('content-type') ?? 'application/json',
          'access-control-allow-origin': '*',
        })
        res.end(buffer)
      })
      .catch(error => {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `proxy failed: ${error.message}` }))
      })
  })
}

const server = createServer((req, res) => {
  // Compare the PATHNAME, not req.url: the runner drives the harness with query
  // strings (`/?tab=hosts&skin=light`), and matching the raw url sent those to
  // the static branch, which then tried to read the directory and crashed.
  const pathname = req.url.split('?')[0]
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(readFileSync(join(ROOT, 'index.html')))
    return
  }
  if (pathname.startsWith('/api/')) {
    proxyHttp(req, res)
    return
  }
  const name = pathname.slice(1)
  const path = join(ROOT, name)
  if (name !== '' && existsSync(path) && statSync(path).isFile()) {
    const ext = name.slice(name.lastIndexOf('.'))
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' })
    res.end(readFileSync(path))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

/** Proxy the terminal WebSocket upgrade so the terminal tab can attach. */
server.on('upgrade', (req, socket, head) => {
  const targetUrl = new URL(TARGET)
  import('node:net').then(({ connect }) => {
    const upstream = connect(Number(targetUrl.port), targetUrl.hostname, () => {
      // Replay the handshake verbatim; the plugin does its own authentication.
      const headers = Object.entries(req.headers)
        .filter(([key]) => key !== 'host')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n')
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\nhost: ${targetUrl.host}\r\n${headers}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`harness on http://127.0.0.1:${PORT}  (proxy -> ${TARGET})`)
})