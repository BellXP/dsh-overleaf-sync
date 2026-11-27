/**
 * First contact between a folder and an Overleaf project, on this machine's
 * disk: nothing was ever compared, so the sync must not pick a winner.
 *
 * Equal files only need a baseline. A file that differs was possibly edited
 * here and never pushed — a pull keeps it and records a conflict; a push sends
 * it (that is what push means); `force` may overwrite, but archives what it
 * replaces. And a dry run writes nothing at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-first-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { OverleafSyncService } = await import('../../lib/service.js')
const { resolveConfig } = await import('../../lib/config.js')
const { saveCredential } = await import('../../lib/transport/credentials.js')
const { conflictsDir, linkPath, statePath } = await import('../../lib/core/paths.js')

const BASE_URL = 'https://www.overleaf.com/'
const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}'
const INTRO_TEX = 'This is the introduction.'

const SNAPSHOT = {
  id: 'p1',
  name: 'First Sync',
  folders: [{ id: 'f1', name: 'chapters', parentFolderId: null }],
  docs: [
    { id: 'd1', name: 'main.tex', parentFolderId: null },
    { id: 'd2', name: 'intro.tex', parentFolderId: 'f1' },
  ],
  files: [],
}

function fakeTransport(initial = { d1: MAIN_TEX, d2: INTRO_TEX }) {
  const texts = { ...initial }
  const versions = { d1: 3, d2: 7 }
  const updates = []
  return {
    texts,
    versions,
    updates,
    async joinProject() {
      return structuredClone(SNAPSHOT)
    },
    async joinDoc(docId) {
      return { docId, version: versions[docId], text: texts[docId] }
    },
    async leaveDoc() {},
    async applyOtUpdate(docId, version, ops) {
      assert.equal(version, versions[docId], 'push must be based on the current server version')
      let next = texts[docId]
      for (const op of ops) {
        if (op.d != null) next = next.slice(0, op.p) + next.slice(op.p + op.d.length)
        if (op.i != null) next = next.slice(0, op.p) + op.i + next.slice(op.p)
      }
      texts[docId] = next
      versions[docId] = version + 1
      updates.push({ docId, version: versions[docId], ops })
      return { version: versions[docId] }
    },
    onRemoteUpdate() {
      return () => {}
    },
    onConnectionState() {
      return () => {}
    },
    async close() {},
  }
}

async function setup(t, files = {}) {
  await saveCredential({ baseUrl: BASE_URL, cookie: 'overleaf_session2=test-session', csrfToken: 'test-csrf' })
  await fs.rm(path.dirname(linkPath('p1')), { recursive: true, force: true }).catch(() => {})
  const localRoot = path.join(home, `first-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(localRoot, rel)), { recursive: true })
    await fs.writeFile(path.join(localRoot, rel), text, 'utf8')
  }
  await fs.mkdir(path.dirname(linkPath('p1')), { recursive: true })
  await fs.writeFile(
    linkPath('p1'),
    JSON.stringify(
      {
        schemaVersion: 1,
        projectId: 'p1',
        projectName: 'First Sync',
        localRoot,
        include: ['**/*.tex'],
        exclude: ['*.pdf'],
        strategy: 'keep-both',
        autoPush: true,
        throttleMs: 400,
        binary: 'download-only',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  const transport = fakeTransport()
  const service = new OverleafSyncService(resolveConfig({ git: { autoInit: false } }), {
    createTransport: async () => transport,
  })
  t.after(async () => {
    await fs.rm(localRoot, { recursive: true, force: true }).catch(() => {})
  })
  return { service, transport, localRoot }
}

const ctx = () => ({ cwd: home, sessionId: 'test-session' })

const readState = async () => JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))

test('a first pull into a folder that already matches Overleaf only records the baseline', async (t) => {
  const { service, localRoot } = await setup(t, { 'main.tex': MAIN_TEX, 'chapters/intro.tex': INTRO_TEX })
  const before = (await fs.stat(path.join(localRoot, 'main.tex'))).mtimeMs

  const summary = await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(summary.pulled, [])
  assert.deepEqual(summary.unchanged.sort(), ['chapters/intro.tex', 'main.tex'])
  assert.equal((await fs.stat(path.join(localRoot, 'main.tex'))).mtimeMs, before, 'an untouched file is not rewritten')
  const state = await readState()
  assert.equal(state.files['main.tex'].docId, 'd1')
  assert.equal(state.files['chapters/intro.tex'].remoteVersion, 7)
})

test('a file that differs and was never synced is kept: the pull records a conflict instead of overwriting', async (t) => {
  const { service, localRoot } = await setup(t, { 'main.tex': 'local draft', 'chapters/intro.tex': INTRO_TEX })

  const dry = await service.pull({ projectId: 'p1', dryRun: true }, ctx())
  assert.deepEqual(dry.conflicts, ['main.tex'])
  assert.deepEqual(dry.pulled, [])
  assert.equal(
    await fs.stat(conflictsDir('p1')).then(() => true, () => false),
    false,
    'a dry run writes nothing, not even conflict artifacts',
  )

  const summary = await service.pull({ projectId: 'p1' }, ctx())
  assert.deepEqual(summary.conflicts, ['main.tex'])
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), 'local draft')
  const names = await fs.readdir(localRoot)
  const copy = names.find((name) => /^main\.remote-.+\.tex$/.test(name))
  assert.ok(copy, `expected the Overleaf copy next to the file, got ${names.join(', ')}`)
  assert.equal(await fs.readFile(path.join(localRoot, copy), 'utf8'), MAIN_TEX)
  assert.match(summary.skipped[0].reason, /^no-baseline \(kept; Overleaf copy: main\.remote-.+\.tex\)$/)

  const { conflicts } = await service.conflicts({ projectId: 'p1' })
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].reason, 'no-baseline')
  assert.equal(conflicts[0].docId, 'd1')
})

test('keep_local pushes the never-synced file and gives it a proper baseline', async (t) => {
  const { service, transport, localRoot } = await setup(t, { 'main.tex': 'local draft' })
  await service.pull({ projectId: 'p1' }, ctx())

  const settled = await service.resolve({ projectId: 'p1', path: 'main.tex', choice: 'keep_local' }, ctx())

  assert.equal(settled.resolved.length, 1)
  assert.equal(transport.texts.d1, 'local draft', 'keep_local sends the local text to Overleaf')
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), 'local draft')
  const state = await readState()
  assert.equal(state.files['main.tex'].docId, 'd1', 'the baseline names the document, not its path')
  assert.equal(state.files['main.tex'].remoteVersion, 4)
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [])
})

test('keep_remote takes the Overleaf text for a never-synced file', async (t) => {
  const { service, transport, localRoot } = await setup(t, { 'main.tex': 'local draft' })
  await service.pull({ projectId: 'p1' }, ctx())

  await service.resolve({ projectId: 'p1', path: 'main.tex', choice: 'keep_remote' }, ctx())

  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), MAIN_TEX)
  assert.equal(transport.updates.length, 0, 'nothing is pushed')
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [])
})

test('force overwrites the differing file but archives what it replaced', async (t) => {
  const { service, localRoot } = await setup(t, { 'main.tex': 'local draft' })

  const summary = await service.pull({ projectId: 'p1', force: true }, ctx())

  assert.deepEqual(summary.pulled.sort(), ['chapters/intro.tex', 'main.tex'])
  assert.deepEqual(summary.conflicts, [])
  assert.equal(await fs.readFile(path.join(localRoot, 'main.tex'), 'utf8'), MAIN_TEX)
  assert.equal(summary.warnings.length, 1)
  assert.match(summary.warnings[0], /^main\.tex: a local file that differed from Overleaf was overwritten \(kept in /)

  const archive = path.join(conflictsDir('p1'), 'resolved')
  const stamps = await fs.readdir(archive)
  assert.equal(stamps.length, 1)
  const kept = path.join(archive, stamps[0], 'main.tex.local')
  assert.equal(await fs.readFile(kept, 'utf8'), 'local draft')
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [], 'an archive is history, not an open conflict')
})

test('a first push only baselines files that already agree and sends the ones that differ', async (t) => {
  const { service, transport } = await setup(t, { 'main.tex': MAIN_TEX, 'chapters/intro.tex': 'local intro' })

  const dry = await service.push({ projectId: 'p1', dryRun: true }, ctx())
  assert.deepEqual(dry.unchanged, ['main.tex'])
  assert.deepEqual(dry.pushed, ['chapters/intro.tex'])
  assert.equal(transport.updates.length, 0)
  assert.equal((await readState().catch(() => undefined))?.files['main.tex'], undefined, 'a dry run records no baseline')

  const real = await service.push({ projectId: 'p1', dryRun: false }, ctx())
  assert.deepEqual(real.pushed, ['chapters/intro.tex'])
  assert.equal(transport.texts.d2, 'local intro')
  const state = await readState()
  assert.equal(state.files['main.tex'].docId, 'd1')
  assert.equal(state.files['chapters/intro.tex'].remoteVersion, 8)
})

test('a dry run over a real divergence reports the conflict without writing a copy', async (t) => {
  const { service, transport, localRoot } = await setup(t)
  await service.pull({ projectId: 'p1' }, ctx())
  await fs.writeFile(path.join(localRoot, 'main.tex'), 'local edit')
  transport.texts.d1 = `${MAIN_TEX}\n% remote edit`
  transport.versions.d1 = 4

  const dry = await service.pull({ projectId: 'p1', dryRun: true }, ctx())
  const dryPush = await service.push({ projectId: 'p1', dryRun: true }, ctx())

  assert.deepEqual(dry.conflicts, ['main.tex'])
  assert.deepEqual(dryPush.conflicts, ['main.tex'])
  assert.deepEqual(
    (await fs.readdir(localRoot)).filter((name) => name.startsWith('main.remote-')),
    [],
    'no conflict copy from a dry run',
  )
  assert.equal(await fs.stat(conflictsDir('p1')).then(() => true, () => false), false)
})
