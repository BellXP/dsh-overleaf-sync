// Child half of test/transport/proxy.test.mjs: it runs with NODE_EXTRA_CA_CERTS set, which
// Node reads once at startup, so the TLS at the end of the tunnel is verified for real.
//
// Topology — everything on loopback, nothing leaves the machine:
//   plugin socket ──CONNECT──▶ fake HTTP proxy ──▶ TLS "Overleaf" (CN=target.test, our test CA)
//
// The target host is `target.test`, not loopback: a loopback target is never proxied, and the
// fake proxy ignores the name anyway and always pipes to the local TLS server.
//
// Every check is printed as one `RESULT {...}` line; the parent turns them into tests.
import { createHash } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

import { TEST_CERT, TEST_KEY } from './proxy-cert.mjs'

const LIB = new URL('../../lib/transport/', import.meta.url).href
const { proxyAgentFor, proxyFor } = await import(LIB + 'proxy.js')
const { detectSocketProtocol, LegacyOverleafSocket } = await import(LIB + 'legacy.js')

const results = []
const check = (name, ok, detail = '') => {
  const record = { name, ok: Boolean(ok), detail: String(detail) }
  results.push(record)
  console.log(`RESULT ${JSON.stringify(record)}`)
}
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// ---- frame helpers (test-side, independent of the implementation) -------------------------------
function serverFrame(text) {
  const data = Buffer.from(text, 'utf8')
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(data.length, 2)
  return Buffer.concat([header, data])
}
function parseClientFrame(buffer) {
  if (buffer.length < 2) return null
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { opcode: buffer[0] & 0x0f, payload, rest: buffer.subarray(offset + maskLength + length) }
}

// ---- the TLS "Overleaf" -------------------------------------------------------------------------
const PROJECT = {
  _id: 'proj-1',
  name: 'Tunneled',
  rootFolder: [{ _id: 'root', name: 'root', docs: [{ _id: 'doc-1', name: 'main.tex' }], fileRefs: [], folders: [] }],
}
const seen = { connect: [], authorization: [], httpRequests: [], upgrades: [] }
const tlsServer = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
  seen.httpRequests.push(req.url)
  if (req.url.startsWith('/socket.io/1/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' })
    res.end('SID-TUNNEL-1:60:60:websocket,xhr-polling')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('ok')
})
tlsServer.on('upgrade', (req, socket) => {
  seen.upgrades.push(req.url)
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.setNoDelay(true)
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const parsed = parseClientFrame(buffer)
      if (parsed === null) return
      buffer = parsed.rest
      const text = parsed.payload.toString('utf8')
      if (text === '1::') socket.write(serverFrame('1::'))
      else if (text.startsWith('5:') && text.includes('"joinProject"')) {
        socket.write(serverFrame(`5:::${JSON.stringify({ name: 'joinProjectResponse', args: [{ publicId: 'public-1', project: PROJECT }] })}`))
      }
    }
  })
  socket.on('error', () => {})
})
await new Promise((resolve, reject) => {
  tlsServer.once('error', reject)
  tlsServer.listen(0, '127.0.0.1', resolve)
})
const tlsPort = tlsServer.address().port

// ---- the fake HTTP proxy -------------------------------------------------------------------------
const proxyMode = { refuse: false }
const proxyServer = net.createServer((client) => {
  let head = Buffer.alloc(0)
  let handedUp = false
  const onHead = (chunk) => {
    if (handedUp) return
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    handedUp = true
    client.off('data', onHead)
    const [requestLine, ...headerLines] = head.subarray(0, end).toString('latin1').split('\r\n')
    const headers = Object.fromEntries(headerLines.map((line) => {
      const at = line.indexOf(':')
      return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]
    }))
    seen.connect.push(requestLine)
    seen.authorization.push(headers['proxy-authorization'] ?? '')
    if (proxyMode.refuse) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
      return
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const upstream = net.connect(tlsPort, '127.0.0.1', () => {
      const rest = head.subarray(end + 4)
      if (rest.length > 0) upstream.write(rest)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
  }
  client.on('data', onHead)
})
await new Promise((resolve, reject) => {
  proxyServer.once('error', reject)
  proxyServer.listen(0, '127.0.0.1', resolve)
})
const proxyPort = proxyServer.address().port
// The parent scrubbed every proxy name from the environment; on Windows names are one key
// regardless of case, so deleting a lowercase spelling here would delete this value too.
process.env.HTTPS_PROXY = `http://user:pass@127.0.0.1:${proxyPort}`

const target = new URL('https://target.test/hello')
const viaHttps = (agent, path, extraHeaders = {}) =>
  new Promise((resolve) => {
    const t = Date.now()
    const req = https.get({ host: target.hostname, port: 443, path, agent, headers: { ...extraHeaders } }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - t }))
    })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, upgraded: true, ms: Date.now() - t }) })
    req.on('error', (error) => resolve({ error, ms: Date.now() - t }))
  })

try {
  check('child: policy names the proxy for the target', proxyFor(target) === `http://user:pass@127.0.0.1:${proxyPort}/`, String(proxyFor(target)))

  const agent = proxyAgentFor(target)
  const page = await viaHttps(agent, '/hello')
  check('child: https GET goes through CONNECT and comes back', page.status === 200 && page.body === 'ok', JSON.stringify(page))
  check('child: the proxy saw CONNECT target.test:443', seen.connect.some((l) => l === 'CONNECT target.test:443 HTTP/1.1'), JSON.stringify(seen.connect))
  check('child: the proxy got the credentials from the proxy URL (Basic dXNlcjpwYXNz)', seen.authorization.includes('Basic dXNlcjpwYXNz'), JSON.stringify(seen.authorization))
  check('child: the TLS at the end of the tunnel was verified against the test CA', page.status === 200, String(page.error ?? 'ok'))

  const upgrade = await viaHttps(agent, '/socket.io/1/websocket/SID-TUNNEL-1', {
    Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': createHash('sha1').update('x').digest('base64').slice(0, 22) + '==',
  })
  check('child: a websocket upgrade rides the same tunnel (101)', upgrade.status === 101 && upgrade.upgraded === true, JSON.stringify({ status: upgrade.status, error: String(upgrade.error ?? '') }))

  const protocol = await detectSocketProtocol('https://target.test/', { agent, timeoutMs: 5000, cookie: 'overleaf_session2=x' })
  check('child: the 0.9 probe through the proxy reads the handshake', protocol === 'legacy', String(protocol))

  const socket = await LegacyOverleafSocket.connect({
    baseUrl: 'https://target.test', cookie: 'overleaf_session2=x', projectId: 'proj-1', agent, timeoutMs: 8000,
  })
  check('child: LegacyOverleafSocket joins the project through the proxy', socket.payload?.project?.name === 'Tunneled', JSON.stringify(socket.payload?.project?.name))
  socket.close()

  proxyMode.refuse = true
  const refusing = proxyAgentFor(target)
  const refused = await viaHttps(refusing, '/hello')
  check('child: a proxy that refuses CONNECT fails the request instead of hanging', refused.error !== undefined && refused.ms < 4000, JSON.stringify({ error: String(refused.error?.message ?? ''), ms: refused.ms }))
  check('child: the refusal names what the proxy answered (407)', /407/i.test(String(refused.error?.message ?? '')), String(refused.error?.message))
  refusing.destroy()
  agent.destroy()
} catch (error) {
  check('child: unexpected exception', false, `${error?.stack ?? error}`)
} finally {
  proxyServer.close()
  tlsServer.close()
}
process.exit(results.every((r) => r.ok) ? 0 : 1)
