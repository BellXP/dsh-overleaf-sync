/**
 * The SSH route: the realtime socket through a link's host (`SshTunnelAgent` over
 * `forwardOut`), verified in a child process with a test CA trusted; and the service's
 * route selection with fakes (tunnel first, fall back to this machine's route).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { TEST_CERT } from '../helpers/proxy-cert.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('the socket through an SSH forwardOut channel (TLS verified for real, in a child)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-overleaf-sync-ssh-'))
  try {
    const certPath = path.join(dir, 'ca.pem')
    fs.writeFileSync(certPath, TEST_CERT)
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) env[key] = value
    }
    env.NODE_EXTRA_CA_CERTS = certPath
    const child = spawnSync(process.execPath, [path.join(HERE, '..', 'helpers', 'ssh-tunnel-child.mjs')], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    const records = String(child.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('RESULT '))
      .map((line) => JSON.parse(line.slice('RESULT '.length)))
    assert.ok(records.length >= 10, `child produced ${records.length} results\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`)
    for (const record of records) {
      assert.equal(record.ok, true, `${record.name}\n    ${record.detail}`)
    }
    assert.equal(child.status, 0, `child exit ${child.status}\n${child.stderr}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Route selection in the service, with a fake transport factory and a fake ssh runtime.
// ---------------------------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ols-route-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { OverleafSyncService } = await import('../../lib/service.js')
const { resolveConfig } = await import('../../lib/config.js')
const { saveCredential } = await import('../../lib/transport/credentials.js')
const { linkPath } = await import('../../lib/core/paths.js')
const { fakeSshRuntime } = await import('../helpers/fake-ssh.mjs')

const SNAPSHOT = {
  id: 'p1',
  name: 'Routed',
  folders: [],
  docs: [{ id: 'd1', name: 'main.tex', parentFolderId: null }],
  files: [],
}
const TEXT = '\\documentclass{article}\nHello\n'
const ctx = () => ({ cwd: home, sessionId: 'test-session' })

async function setup(t, { failTunnelled = false, withForwardOut = true } = {}) {
  await saveCredential({ baseUrl: 'https://www.overleaf.com/', cookie: 'overleaf_session2=s', csrfToken: 'c', userHint: 't' })
  fs.rmSync(path.dirname(linkPath('p1')), { recursive: true, force: true })
  const calls = []
  const transport = {
    async joinProject() { return structuredClone(SNAPSHOT) },
    async joinDoc(docId) { return { docId, version: 1, text: TEXT } },
    async leaveDoc() {},
    async applyOtUpdate(docId) { return { version: 2 } },
    onRemoteUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async close() {},
  }
  const service = new OverleafSyncService(resolveConfig({}), {
    createTransport: async (_credential, _projectId, options) => {
      calls.push(options?.tunnel ? 'tunnel' : 'local')
      if (options?.tunnel && failTunnelled) throw new Error('open failed: administratively prohibited')
      return transport
    },
  })
  const base = fakeSshRuntime({ home: '/home/me' })
  if (withForwardOut) {
    const inner = base.getConnectionFor.bind(base)
    base.getConnectionFor = async (alias) => ({ ...(await inner(alias)), forwardOut: async () => { throw new Error('never reached: the fake transport factory does not open sockets') } })
  }
  service.attachSsh(base)
  service.listProjects = async () => [{ id: 'p1', name: 'Routed' }]
  return { service, calls }
}

test('auto: a link with a host opens the transport through the tunnel first', async (t) => {
  const { service, calls } = await setup(t)
  await service.link({ projectId: 'p1', host: 'lab', localRoot: '~/paper' }, ctx())
  const summary = await service.pull({ projectId: 'p1', dryRun: true }, ctx())
  assert.deepEqual(calls, ['tunnel'])
  assert.deepEqual(summary.warnings, [])
})

test('auto: when the tunnel fails the transport is opened again on the local route, and the summary says so', async (t) => {
  const { service, calls } = await setup(t, { failTunnelled: true })
  await service.link({ projectId: 'p1', host: 'lab', localRoot: '~/paper' }, ctx())
  const summary = await service.pull({ projectId: 'p1', dryRun: true }, ctx())
  assert.deepEqual(calls, ['tunnel', 'local'])
  assert.equal(summary.warnings.length, 1)
  assert.match(summary.warnings[0], /direct route through lab failed \(open failed: administratively prohibited\); used this machine's route/)
})

test('local: the tunnel is never tried', async (t) => {
  const { service, calls } = await setup(t)
  await service.link({ projectId: 'p1', host: 'lab', localRoot: '~/paper', route: 'local' }, ctx())
  await service.pull({ projectId: 'p1', dryRun: true }, ctx())
  assert.deepEqual(calls, ['local'])
})

test('ssh: a failing tunnel is an error, not a silent fallback', async (t) => {
  const { service, calls } = await setup(t, { failTunnelled: true })
  await service.link({ projectId: 'p1', host: 'lab', localRoot: '~/paper', route: 'ssh' }, ctx())
  await assert.rejects(service.pull({ projectId: 'p1', dryRun: true }, ctx()), /administratively prohibited/)
  assert.deepEqual(calls, ['tunnel'])
})

test('a link without a host stays on the local route whatever route it names', async (t) => {
  const { service, calls } = await setup(t)
  await service.link({ projectId: 'p1', localRoot: '~/paper', route: 'ssh' }, ctx())
  const summary = await service.pull({ projectId: 'p1', dryRun: true }, ctx())
  assert.deepEqual(calls, ['local'])
  assert.equal(summary.warnings.length, 1)
  assert.match(summary.warnings[0], /route ssh was asked for, but the link has no SSH host/)
})

test('the route is kept when the link is re-issued without one', async (t) => {
  const { service } = await setup(t)
  const first = await service.link({ projectId: 'p1', host: 'lab', localRoot: '~/paper', route: 'ssh' }, ctx())
  assert.equal(first.route, 'ssh')
  const again = await service.link({ projectId: 'p1' }, ctx())
  assert.equal(again.route, 'ssh')
  const local = await service.link({ projectId: 'p1', route: 'local' }, ctx())
  assert.equal(local.route, 'local')
})
