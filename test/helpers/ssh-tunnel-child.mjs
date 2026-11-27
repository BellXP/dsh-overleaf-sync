// Child half of test/transport/ssh-tunnel.test.mjs: it runs with NODE_EXTRA_CA_CERTS set, which
// Node reads once at startup, so the TLS at the end of the tunnel is verified for real.
//
// Topology — everything on loopback, nothing leaves the machine:
//   plugin socket ──SshTunnelAgent──▶ "forwardOut" (a plain TCP socket here) ──▶ TLS "Overleaf" (CN=target.test, our test CA)
//
// Every check is printed as one `RESULT {...}` line; the parent turns them into tests.
import { createHash } from 'node:crypto'
import https from 'node:https'
import net from 'node:net'

import { TEST_CERT, TEST_KEY } from './proxy-cert.mjs'

const LIB = new URL('../../lib/transport/', import.meta.url).href
const { sshTunnelAgentFor, SshTunnelAgent } = await import(LIB + 'tunnel.js')
const { LegacyOverleafSocket } = await import(LIB + 'legacy.js')

const results = []
const check = (name, ok, detail = '') => {
  const record = { name, ok: Boolean(ok), detail: String(detail) }
  results.push(record)
  console.log(`RESULT ${JSON.stringify(record)}`)
}
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

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
const seen = { handshakes: 0, upgrades: 0, sni: [] }
const tlsServer = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
  if (req.url.startsWith('/socket.io/1/')) {
    seen.handshakes += 1
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8', 'Set-Cookie': 'GCLB=tunnel-1; path=/' })
    res.end('SID-SSH-1:60:60:websocket,xhr-polling')
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('ok')
})
tlsServer.on('tlsClientError', () => {})
tlsServer.on('secureConnection', (socket) => seen.sni.push(socket.servername))
tlsServer.on('upgrade', (req, socket) => {
  seen.upgrades += 1
  seen.upgradeCookie = req.headers.cookie
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

// ---- "forwardOut": every channel is a plain TCP socket to the TLS server ----------------------
let opened = 0
const forwardOut = async () => {
  opened += 1
  return net.connect(tlsPort, '127.0.0.1')
}

// 1. the whole socket path (handshake + upgrade) through the agent
const agent = sshTunnelAgentFor(forwardOut, 'https://target.test/')
check('sshTunnelAgentFor builds an agent for an https base URL', agent instanceof SshTunnelAgent)
check('sshTunnelAgentFor refuses a non-https base URL', sshTunnelAgentFor(forwardOut, 'http://target.test/') === undefined)
const socket = await LegacyOverleafSocket.connect({
  baseUrl: 'https://target.test',
  projectId: 'proj-1',
  cookie: 'overleaf_session2=abc',
  agent,
})
check('connect + joinProject succeed through the tunnel', socket.socketId === 'SID-SSH-1', socket.socketId)
check('every socket the client opened came from forwardOut', opened >= 2, `opened=${opened}`)
check('TLS was verified for the real host name (SNI target.test)', seen.sni.length > 0 && seen.sni.every((n) => n === 'target.test'), JSON.stringify(seen.sni))
check('the handshake route cookie reached the upgrade', String(seen.upgradeCookie).includes('GCLB=tunnel-1'), String(seen.upgradeCookie))
socket.close()

// 2. a refused channel fails the connect instead of hanging
const t0 = Date.now()
let refusal = ''
try {
  const refused = new SshTunnelAgent(async () => { throw new Error('open failed: administratively prohibited') }, { servername: 'target.test', timeoutMs: 5_000 })
  await LegacyOverleafSocket.connect({ baseUrl: 'https://target.test', projectId: 'proj-1', cookie: 'overleaf_session2=abc', agent: refused, timeoutMs: 5_000 })
} catch (error) {
  refusal = error?.message ?? String(error)
}
check('a refused channel fails the connect with the reason', /administratively prohibited/.test(refusal), refusal)
check('the refusal is reported quickly', Date.now() - t0 < 5_000, `${Date.now() - t0} ms`)

// 3. a channel that never opens times out
const t1 = Date.now()
let timeout = ''
try {
  const slow = new SshTunnelAgent(() => new Promise(() => {}), { servername: 'target.test', timeoutMs: 300 })
  await new Promise((resolve, reject) => {
    const req = https.request({ host: 'target.test', port: 443, agent: slow, timeout: 3_000 }, (res) => { res.resume(); resolve() })
    req.on('error', reject)
    req.end()
  })
} catch (error) {
  timeout = error?.message ?? String(error)
}
check('a channel that never opens times out with a clear message', /did not open within 300 ms/.test(timeout), timeout)
check('the timeout fires on schedule', Date.now() - t1 < 3_000, `${Date.now() - t1} ms`)

console.log(`RESULTS ${JSON.stringify(results)}`)
tlsServer.close()
