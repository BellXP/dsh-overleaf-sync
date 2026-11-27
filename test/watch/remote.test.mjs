/**
 * `WatchSession` over an SSH host: Overleaf edits land in the folder on the
 * host, and edits made on the host go back through `applyOtUpdate`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-remote-watch-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { WatchSession } = await import('../../lib/watch/session.js')
const { resolveConfig } = await import('../../lib/config.js')
const { statePath } = await import('../../lib/core/paths.js')
const { SshTree } = await import('../../lib/core/tree-ssh.js')
const { fakeSshRuntime } = await import('../helpers/fake-ssh.mjs')

const ROOT = '/home/me/paper'
let projectSeq = 0

function applyOpsToText(text, ops) {
  let next = text
  for (const op of ops) {
    if (op.d != null) next = next.slice(0, op.p) + next.slice(op.p + op.d.length)
    if (op.i != null) next = next.slice(0, op.p) + op.i + next.slice(op.p)
  }
  return next
}

function fakeTransport(text) {
  const state = { text, version: 4 }
  const callbacks = []
  return {
    state,
    updates: [],
    callbacks,
    async joinProject() {
      return { id: 'w', name: 'Watched', folders: [], docs: [{ id: 'd1', name: 'main.tex', parentFolderId: null }], files: [] }
    },
    async joinDoc() {
      return { docId: 'd1', version: state.version, text: state.text }
    },
    async leaveDoc() {},
    async applyOtUpdate(docId, version, ops) {
      assert.equal(version, state.version)
      state.text = applyOpsToText(state.text, ops)
      state.version += 1
      this.updates.push({ docId, version: state.version, ops })
      return { version: state.version }
    },
    onRemoteUpdate(cb) {
      callbacks.push({ type: 'remote', cb })
      return () => {}
    },
    onConnectionState(cb) {
      callbacks.push({ type: 'state', cb })
      return () => {}
    },
    async close() {},
  }
}

async function waitFor(predicate, label, timeoutMs = 4000) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function readState(projectId) {
  try {
    return JSON.parse(await fs.readFile(statePath(projectId), 'utf8'))
  } catch {
    return undefined
  }
}

async function setup(t, text = 'hello\n') {
  const projectId = `watch-remote-${++projectSeq}`
  const ssh = fakeSshRuntime({ home: '/home/me', files: { [`${ROOT}/main.tex`]: text } })
  const link = {
    schemaVersion: 1,
    projectId,
    projectName: 'Watched',
    localRoot: ROOT,
    host: 'lab',
    include: [],
    exclude: [],
    strategy: 'auto',
    autoPush: true,
    throttleMs: 60,
    binary: 'download-only',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const transport = fakeTransport(text)
  const session = new WatchSession({
    link,
    transport,
    config: resolveConfig({}),
    docs: [{ docId: 'd1', relPath: 'main.tex' }],
    tree: new SshTree(ssh, 'lab', { pollMs: 15 }),
  })
  return { session, transport, ssh, projectId }
}

test('an Overleaf edit is written to the folder on the host and nothing is created here', async (t) => {
  const { session, transport, ssh, projectId } = await setup(t)
  await session.start()
  t.after(() => session.stop('test finished'))

  const remote = transport.callbacks.find((entry) => entry.type === 'remote')
  assert.ok(remote, 'session must subscribe to remote updates')
  remote.cb({ docId: 'd1', version: 5, ops: [{ p: 6, i: 'world\n' }] })

  await waitFor(async () => ssh.read(`${ROOT}/main.tex`) === 'hello\nworld\n', 'remote update on the host')
  await waitFor(async () => (await readState(projectId))?.files['main.tex']?.remoteVersion === 5, 'baseline flush')
  assert.equal((await readState(projectId)).host, 'lab')
  assert.equal(await fs.stat(path.join(home, 'paper')).then(() => true, () => false), false)
  assert.ok(session.recentEvents.some((event) => event.type === 'remote'))
})

test('an edit made on the host is pushed as an OT update, and our own writes do not echo back', async (t) => {
  const { session, transport, ssh, projectId } = await setup(t)
  await session.start()
  t.after(() => session.stop('test finished'))
  await waitFor(() => ssh.calls.length >= 1, 'watcher baseline')
  // Wait longer than one poll plus the debounce window: a quiet tree must stay quiet.
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(transport.updates.length, 0)

  ssh.write(`${ROOT}/main.tex`, 'hello server\n')
  await waitFor(async () => transport.updates.length >= 1 && (await readState(projectId))?.files['main.tex'] !== undefined, 'push from the host')

  assert.equal(transport.state.text, 'hello server\n')
  assert.ok(session.recentEvents.some((event) => event.type === 'local'))

  // The write the session heard was its own echo filter's job: nothing else moved.
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(transport.updates.length, 1, 'the same content is pushed once')
})

test('a host that goes down shows up as an error event, not a silent stop', async (t) => {
  const { session, ssh } = await setup(t)
  await session.start()
  t.after(() => session.stop('test finished'))
  await waitFor(() => ssh.calls.length >= 1, 'watcher baseline')

  ssh.getConnectionFor = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  await waitFor(() => session.recentEvents.some((event) => event.type === 'error'), 'error event')
  assert.equal(session.isRunning, true)
  assert.match(session.lastErrorText, /E_HOST_UNREACHABLE/)
})
