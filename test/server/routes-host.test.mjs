/**
 * The GUI routes that know about SSH hosts: listing them, linking to a folder
 * on one, checking such a folder, and reporting a pending count the host
 * could not deliver.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-routes-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { resolveConfig } = await import('../../lib/config.js')
const { createOverleafRoutes } = await import('../../lib/server/routes.js')
const { SettingsBridge } = await import('../../lib/server/settingsBridge.js')
const { statePath } = await import('../../lib/core/paths.js')
const { OverleafSyncError } = await import('../../lib/core/errors.js')

const config = resolveConfig({ confirmRemoteWrite: true })
const REMOTE = { projectId: 'p1', projectName: 'Paper', localRoot: '/home/me/paper', host: 'lab' }

function makeRequest(body) {
  return {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body ?? {}), 'utf8')
    },
  }
}

function makeResponse() {
  const out = { status: 0, body: undefined }
  return {
    out,
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.body = JSON.parse(text)
    },
  }
}

async function callRoute(routes, name, body) {
  const route = routes.find((entry) => entry.path === `/overleaf/api/${name}`)
  assert.ok(route, `route ${name} exists`)
  const res = makeResponse()
  route.handler(makeRequest(body), res)
  for (let i = 0; i < 200 && res.out.body === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return res.out
}

/** A tree whose only job here is to answer (or fail) the pending count. */
function fakeTree(hashFiles, readBytes = async () => undefined) {
  return {
    kind: 'ssh',
    join: (...parts) => parts.join('/'),
    resolve: (root, rel) => `${root}/${rel}`,
    readText: async () => undefined,
    readBytes,
    hashFiles,
  }
}

function fakeService(overrides = {}) {
  const calls = []
  return {
    calls,
    async status() {
      return { baseUrl: 'https://www.overleaf.com', authenticated: true, projects: [REMOTE], text: 'ok' }
    },
    async credential() {
      return undefined
    },
    async readLink() {
      return REMOTE
    },
    async conflicts() {
      return { conflicts: [] }
    },
    async link(input) {
      calls.push(['link', input])
      return { projectId: input.projectId, projectName: 'Paper', localRoot: input.localRoot ?? '/home/me/paper', host: input.host, createdAt: 'now' }
    },
    async validateRemotePath(host, raw, projectId) {
      calls.push(['validateRemotePath', host, raw, projectId])
      return { resolved: `/home/me/${raw}`, problems: [] }
    },
    listHosts() {
      return [{ alias: 'lab', host: '10.0.0.1', user: 'root', description: 'lab server' }]
    },
    tree: () => fakeTree(async () => new Map()),
    ...overrides,
  }
}

function routesOf(service) {
  return createOverleafRoutes({ service, config, settings: new SettingsBridge(undefined, { config }), cwd: process.cwd() })
}

async function writeBaseline(projectId) {
  await fs.mkdir(path.dirname(statePath(projectId)), { recursive: true })
  await fs.writeFile(
    statePath(projectId),
    JSON.stringify({
      schemaVersion: 1,
      projectId,
      localRoot: REMOTE.localRoot,
      host: 'lab',
      updatedAt: 'now',
      files: { 'main.tex': { docId: 'd1', remoteVersion: 1, localHash: 'sha256:x', syncedAt: 'now' } },
    }),
  )
}

test('hosts lists what the SSH service knows, and says so when there is none', async () => {
  const listed = await callRoute(routesOf(fakeService()), 'hosts', {})
  assert.deepEqual(listed.body.value, {
    available: true,
    hosts: [{ alias: 'lab', host: '10.0.0.1', user: 'root', description: 'lab server' }],
  })

  const bare = fakeService()
  delete bare.listHosts
  assert.deepEqual((await callRoute(routesOf(bare), 'hosts', {})).body.value, { available: false, hosts: [] })
  const none = fakeService({ listHosts: () => undefined })
  assert.deepEqual((await callRoute(routesOf(none), 'hosts', {})).body.value, { available: false, hosts: [] })
})

test('link forwards the host and applies the non-empty-folder guard to this machine only', async (t) => {
  const service = fakeService()
  const routes = routesOf(service)
  // `/home/me/paper` does not exist here, which is the point: a remote folder
  // must never be probed on the local disk.
  const out = await callRoute(routes, 'link', { projectId: 'p1', host: 'lab', localRoot: '~/paper' })
  assert.equal(out.status, 200)
  assert.deepEqual(service.calls[0], ['link', { projectId: 'p1', localRoot: '~/paper', host: 'lab' }])

  // Without a host the guard is unchanged: a non-empty local folder needs force.
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-nonempty-'))
  t.after(() => fs.rm(localDir, { recursive: true, force: true }))
  await fs.writeFile(path.join(localDir, 'notes.txt'), 'x')
  const guarded = await callRoute(routes, 'link', { projectId: 'p1', localRoot: localDir })
  assert.equal(guarded.status, 400)
  assert.equal(guarded.body.code, 'E_LOCAL_DIR_CONFIRM_REQUIRED')
  assert.equal(service.calls.length, 1, 'a refused link never reaches the service')
})

test('validate-path delegates to the host when one is named', async () => {
  const service = fakeService()
  const out = await callRoute(routesOf(service), 'validate-path', { path: 'paper', host: 'lab', projectId: 'p1' })
  assert.equal(out.status, 200)
  assert.deepEqual(out.body.value, { ok: true, resolved: '/home/me/paper', problems: [] })
  assert.deepEqual(service.calls[0], ['validateRemotePath', 'lab', 'paper', 'p1'])

  const refused = fakeService({
    validateRemotePath: async () => {
      throw new OverleafSyncError('E_HOST_UNAVAILABLE', 'SSH host "ghost" is not configured', 'list hosts')
    },
  })
  const failed = await callRoute(routesOf(refused), 'validate-path', { path: 'paper', host: 'ghost' })
  assert.equal(failed.status, 400)
  assert.equal(failed.body.code, 'E_HOST_UNAVAILABLE')
})

test('status names the host of the current link and reports a pending count the host could not deliver', async (t) => {
  await writeBaseline('p1')
  t.after(() => fs.rm(path.dirname(statePath('p1')), { recursive: true, force: true }))

  const broken = fakeService({
    tree: () =>
      fakeTree(async () => {
        throw new OverleafSyncError('E_HOST_UNREACHABLE', 'cannot reach SSH host "lab"', 'retry')
      }),
  })
  const out = await callRoute(routesOf(broken), 'status', {})
  assert.equal(out.status, 200)
  assert.equal(out.body.value.current.host, 'lab')
  assert.equal(out.body.value.projects[0].host, 'lab')
  assert.deepEqual(out.body.value.pending, {
    localChanges: 0,
    conflicts: 0,
    error: 'E_HOST_UNREACHABLE: cannot reach SSH host "lab" — retry',
  })
})

test('status counts pending changes for a remote link through the tree', async (t) => {
  // The remote count is memoised for a few seconds per project; a second
  // project keeps this test independent of the previous one.
  await writeBaseline('p2')
  t.after(() => fs.rm(path.dirname(statePath('p2')), { recursive: true, force: true }))

  const counted = fakeService({
    readLink: async () => ({ ...REMOTE, projectId: 'p2' }),
    // The checksum differs from the baseline, and so does the file: one change.
    tree: () => fakeTree(async () => new Map([['main.tex', 'y'.repeat(64)]]), async () => Buffer.from('changed')),
  })
  const out = await callRoute(routesOf(counted), 'status', {})
  assert.equal(out.status, 200)
  assert.deepEqual(out.body.value.pending, { localChanges: 1, conflicts: 0 })
})

test('watch view carries the host of a running session', async () => {
  const service = fakeService({
    watch: async () => ({
      running: true,
      projectId: 'p1',
      projectName: 'Paper',
      localRoot: REMOTE.localRoot,
      location: `lab:${REMOTE.localRoot}`,
      host: 'lab',
      openDocs: 1,
      events: [],
      sessions: [],
    }),
  })
  const out = await callRoute(routesOf(service), 'watch', { action: 'status' })
  assert.equal(out.body.value.host, 'lab')
  assert.equal(out.body.value.localRoot, REMOTE.localRoot)
})
