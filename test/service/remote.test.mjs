/**
 * A link whose folder lives on an SSH host, end to end through the service:
 * real state store and conflict artifacts on this machine, real sync policy,
 * fake socket to Overleaf, in-memory host for the files.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ols-remote-home-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { OverleafSyncService } = await import('../../lib/service.js')
const { resolveConfig } = await import('../../lib/config.js')
const { saveCredential } = await import('../../lib/transport/credentials.js')
const { conflictsDir, linkPath, statePath } = await import('../../lib/core/paths.js')
const { SshTree } = await import('../../lib/core/tree-ssh.js')
const { countPendingLocalChanges } = await import('../../lib/server/pending.js')
const { fakeSshRuntime } = await import('../helpers/fake-ssh.mjs')

const BASE_URL = 'https://www.overleaf.com/'
const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}'
const INTRO_TEX = 'This is the introduction.'
const ROOT = '/home/me/paper'

const SNAPSHOT = {
  id: 'p1',
  name: 'Remote Paper',
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

async function setup(t, options = {}) {
  await saveCredential({
    baseUrl: BASE_URL,
    cookie: 'overleaf_session2=test-session',
    csrfToken: 'test-csrf',
    userHint: 'tester',
  })
  // Every test starts from "never linked": link.json, state.json and conflicts.
  await fs.rm(path.dirname(linkPath('p1')), { recursive: true, force: true }).catch(() => {})

  const ssh = fakeSshRuntime({ home: '/home/me', ...options.host })
  const transport = fakeTransport(options.texts)
  const config = resolveConfig({ git: { autoInit: options.gitInit ?? false } })
  const service = new OverleafSyncService(config, { createTransport: async () => transport })
  if (options.noSsh !== true) service.attachSsh(ssh)
  service.listProjects = async () => [{ id: 'p1', name: 'Remote Paper' }]
  return { service, ssh, transport, config }
}

const ctx = () => ({ cwd: home, sessionId: 'test-session' })

async function linkRemote(service, localRoot = '~/paper') {
  return service.link({ projectId: 'p1', host: 'lab', localRoot }, ctx())
}

test('a link with a host names a folder on that host and nothing is created here', async (t) => {
  const { service } = await setup(t)

  const record = await linkRemote(service)

  assert.equal(record.host, 'lab')
  assert.equal(record.localRoot, ROOT)
  assert.equal(await fs.stat(path.join(home, 'paper')).then(() => true, () => false), false)

  const status = await service.status(ctx())
  assert.equal(status.projects[0].location, `lab:${ROOT}`)
  assert.equal(status.projects[0].host, 'lab')
  assert.match(status.text, new RegExp(`→ lab:${ROOT}`))
  assert.deepEqual(
    [record.include, record.exclude, record.strategy],
    [['**/*.tex', '**/*.bib', '**/*.cls', '**/*.sty', '**/*.md', '**/*.txt'], ['.git/**', 'node_modules/**'], 'keep-both'],
  )
})

test('the default folder follows the pattern under the host home and never collides', async (t) => {
  const { service, ssh } = await setup(t)
  ssh.dirs.add('/home/me/Overleaf/Remote Paper')

  const record = await service.link({ projectId: 'p1', host: 'lab' }, ctx())

  assert.equal(record.localRoot, '/home/me/Overleaf/Remote Paper (1)')
})

test('re-linking keeps the host and the folder; host "" moves the link back to this machine', async (t) => {
  const { service } = await setup(t)
  await linkRemote(service)

  const again = await service.link({ projectId: 'p1' }, ctx())
  assert.equal(again.host, 'lab')
  assert.equal(again.localRoot, ROOT)

  const back = await service.link({ projectId: 'p1', host: '', localRoot: path.join(home, 'local-paper') }, ctx())
  assert.equal(back.host, undefined)
  assert.ok(path.isAbsolute(back.localRoot) && back.localRoot.endsWith('local-paper'))
})

test('a path that is a file on the host is refused when linking', async (t) => {
  const { service } = await setup(t, { host: { files: { '/home/me/paper': 'not a folder' } } })
  await assert.rejects(() => linkRemote(service), (err) => err.code === 'E_CONFIG' && /is a file, not a folder/.test(err.message))
})

test('an unknown host, a missing SSH service and a host that is down each fail with a next step', async (t) => {
  const { service } = await setup(t)
  await assert.rejects(() => service.link({ projectId: 'p1', host: 'nope', localRoot: ROOT }, ctx()), (err) => {
    assert.equal(err.code, 'E_HOST_UNAVAILABLE')
    assert.match(err.hint, /ssh_list/)
    return true
  })

  const bare = await setup(t, { noSsh: true })
  await assert.rejects(() => bare.service.link({ projectId: 'p1', host: 'lab', localRoot: ROOT }, ctx()), (err) => {
    assert.equal(err.code, 'E_HOST_UNAVAILABLE')
    assert.match(err.hint, /dsh-cloud-workspaces/)
    return true
  })
  assert.equal(bare.service.listHosts(), undefined)

  const down = await setup(t, { host: { offline: true } })
  await assert.rejects(() => linkRemote(down.service), (err) => {
    assert.equal(err.code, 'E_HOST_UNREACHABLE')
    return true
  })
})

test('pull writes through the host and keeps state, credentials and conflicts on this machine', async (t) => {
  const { service, ssh } = await setup(t)
  await linkRemote(service)

  const summary = await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(summary.pulled.sort(), ['chapters/intro.tex', 'main.tex'])
  assert.equal(summary.location, `lab:${ROOT}`)
  assert.equal(summary.host, 'lab')
  assert.equal(ssh.read(`${ROOT}/main.tex`), MAIN_TEX)
  assert.equal(ssh.read(`${ROOT}/chapters/intro.tex`), INTRO_TEX)
  assert.equal(await fs.stat(path.join(home, 'paper')).then(() => true, () => false), false)

  const state = JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))
  assert.equal(state.host, 'lab')
  assert.equal(state.files['main.tex'].docId, 'd1')

  const again = await service.pull({ projectId: 'p1' }, ctx())
  assert.deepEqual(again.pulled, [])
  assert.deepEqual(again.unchanged.sort(), ['chapters/intro.tex', 'main.tex'])
})

test('edits made on the host are pushed; a divergence becomes a conflict copy on the host', async (t) => {
  const { service, ssh, transport } = await setup(t)
  await linkRemote(service)
  await service.pull({ projectId: 'p1' }, ctx())

  // The agent on the server edits the paper.
  ssh.write(`${ROOT}/main.tex`, `${MAIN_TEX}\n% edited on the server`)
  const pushed = await service.push({ projectId: 'p1', dryRun: false }, ctx())
  assert.deepEqual(pushed.pushed, ['main.tex'])
  assert.equal(transport.texts.d1, `${MAIN_TEX}\n% edited on the server`)

  // Meanwhile the advisor edited Overleaf: both sides moved.
  ssh.write(`${ROOT}/main.tex`, 'server draft')
  transport.texts.d1 = `${MAIN_TEX}\n% advisor edit`
  transport.versions.d1 = 6
  const pulled = await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(pulled.conflicts, ['main.tex'])
  assert.equal(ssh.read(`${ROOT}/main.tex`), 'server draft', 'the local edit stays in place')
  const copy = [...ssh.files.keys()].find((file) => /main\.remote-.+\.tex$/.test(file))
  assert.ok(copy, `expected a conflict copy on the host, got ${[...ssh.files.keys()].join(', ')}`)
  assert.equal(ssh.read(copy), `${MAIN_TEX}\n% advisor edit`)

  const listed = await service.conflicts({ projectId: 'p1' })
  assert.equal(listed.location, `lab:${ROOT}`)
  assert.equal(listed.conflicts[0].path, 'main.tex')
  assert.equal(listed.conflicts[0].reason, 'both-changed')
  assert.ok(await fs.stat(conflictsDir('p1')).then(() => true, () => false), 'artifacts live here')

  const settled = await service.resolve({ projectId: 'p1', path: 'main.tex', choice: 'keep_remote' }, ctx())
  assert.equal(settled.resolved.length, 1)
  assert.equal(ssh.read(`${ROOT}/main.tex`), `${MAIN_TEX}\n% advisor edit`)
  assert.deepEqual((await service.conflicts({ projectId: 'p1' })).conflicts, [])
})

test('pending changes are counted with one host checksum call, and by reading when the host has no sha256sum', async (t) => {
  const { service, ssh } = await setup(t)
  await linkRemote(service)
  await service.pull({ projectId: 'p1' }, ctx())
  const state = JSON.parse(await fs.readFile(statePath('p1'), 'utf8'))
  const tree = new SshTree(ssh, 'lab')

  assert.equal(await countPendingLocalChanges(state, ROOT, undefined, tree), 0)

  ssh.write(`${ROOT}/main.tex`, 'changed on the host')
  const execBefore = ssh.stats.exec
  assert.equal(await countPendingLocalChanges(state, ROOT, undefined, tree), 1)
  assert.equal(ssh.stats.exec - execBefore, 1, 'one sha256sum for the whole baseline')

  const slow = fakeSshRuntime({ home: '/home/me', noSha256sum: true, files: Object.fromEntries(ssh.files) })
  assert.equal(await countPendingLocalChanges(state, ROOT, undefined, new SshTree(slow, 'lab')), 1)
  assert.equal(
    await countPendingLocalChanges({ files: { 'main.tex': state.files['main.tex'] } }, '/home/me/nowhere', undefined, new SshTree(slow, 'lab')),
    1,
    'a file that is gone counts as changed',
  )
})

test('the folder check for the GUI asks the host', async (t) => {
  const { service } = await setup(t)
  await linkRemote(service)
  await service.pull({ projectId: 'p1' }, ctx())

  assert.deepEqual(await service.validateRemotePath('lab', '~/paper', 'p1'), { resolved: ROOT, problems: [] })
  const file = await service.validateRemotePath('lab', `${ROOT}/main.tex`)
  assert.deepEqual(file.problems, ['该路径是一个文件，不是目录'])
  const elsewhere = await service.validateRemotePath('lab', '/home/me/elsewhere', 'p1')
  assert.equal(elsewhere.resolved, '/home/me/elsewhere')
  assert.deepEqual(elsewhere.problems, [`该项目已绑定到 lab:${ROOT}`])
  const fresh = await service.validateRemotePath('lab', '../shared/new paper')
  assert.equal(fresh.resolved, '/home/shared/new paper')
})

test('git is looked for on the host: missing git is a warning, an existing repository is reused', async (t) => {
  const { service, ssh } = await setup(t, { gitInit: true })
  await linkRemote(service)

  const summary = await service.pull({ projectId: 'p1' }, ctx())

  assert.equal(summary.git.mode, 'none')
  assert.match(summary.git.warning, /E_GIT_UNAVAILABLE/)

  const scripted = fakeSshRuntime({
    home: '/home/me',
    files: { [`${ROOT}/main.tex`]: MAIN_TEX },
    git: (args) =>
      args[0] === 'rev-parse' && args[1] === '--show-toplevel'
        ? { exitCode: 0, stdout: `${ROOT}\n` }
        : { exitCode: 1, stderr: `unexpected: ${args.join(' ')}` },
  })
  const reused = new OverleafSyncService(resolveConfig({ git: { autoInit: true } }), { createTransport: async () => fakeTransport() })
  reused.attachSsh(scripted)
  await fs.writeFile(linkPath('p1'), JSON.stringify({ ...(await service.readLink('p1')), localRoot: ROOT, host: 'lab' }, null, 2))
  const result = await reused.pull({ projectId: 'p1' }, ctx())

  assert.equal(result.git.mode, 'own')
  assert.equal(result.git.created, false)
  assert.equal(scripted.read(`${ROOT}/.gitattributes`), '* text=auto eol=lf\n')
  assert.match(scripted.read(`${ROOT}/.gitignore`), /# dsh-overleaf-sync/)
  assert.ok(ssh.calls.some((command) => command.startsWith(`cd '${ROOT}' && 'git' `)), 'the first host was asked for git')
})
