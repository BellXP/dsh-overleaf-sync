/**
 * `SshTree` over an in-memory host: what the tree sends, where it writes, and
 * how it degrades (no GNU find, a server that refuses to replace on rename,
 * a host that is down).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { fakeSshRuntime, quotedArgs } from '../helpers/fake-ssh.mjs'
import { OverleafSyncError } from '../../lib/core/errors.js'
import {
  SshTree,
  fingerprintCommand,
  hashCommand,
  inDir,
  isSshRuntime,
  parseChecksumLines,
  parseFingerprintLines,
  quoteSh,
  treeListingCommand,
} from '../../lib/core/tree-ssh.js'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function tree(options = {}, treeOptions = {}) {
  const runtime = fakeSshRuntime(options)
  return { runtime, tree: new SshTree(runtime, 'lab', treeOptions) }
}

test('command builders quote every path and wrap names for the channel', () => {
  assert.equal(quoteSh(`a'b`), `'a'\\''b'`)
  assert.equal(inDir('/p dir', 'ls'), `cd '/p dir' && ls`)
  assert.equal(
    hashCommand(['main.tex', "fig's/a.png"]),
    `sha256sum -- 'main.tex' 'fig'\\''s/a.png' 2>/dev/null | base64 | tr -d '\\n'`,
  )
  assert.equal(fingerprintCommand(['main.tex']), `find -- 'main.tex' -printf '%p\\t%s\\t%T@\\n' | base64 | tr -d '\\n'`)
  assert.equal(
    treeListingCommand(),
    `find . \\( -name .git -o -name node_modules \\) -prune -o -type f -printf '%P\\t%s\\t%T@\\n' | base64 | tr -d '\\n'`,
  )
  // `'\n'` belongs to `tr -d`, so it is the last quoted token of the hash command.
  assert.deepEqual(quotedArgs(hashCommand(['a b.tex', 'c.tex'])), ['a b.tex', 'c.tex', '\\n'])
})

test('checksum and fingerprint lines are parsed exactly, escaped names included', () => {
  const hex = 'a'.repeat(64)
  const hashes = parseChecksumLines(`${hex}  main.tex\n${hex} *bin.dat\n\\${hex}  two\\nlines.tex\nnot a line\n`)
  assert.deepEqual(
    [...hashes],
    [
      ['main.tex', hex],
      ['bin.dat', hex],
      ['two\nlines.tex', hex],
    ],
  )
  const prints = parseFingerprintLines('./main.tex\t12\t1700000000.1234567890\nsub/a.tex\t3\t1700000001.0000000000\nbroken\n')
  assert.deepEqual(
    [...prints],
    [
      ['main.tex', '12@1700000000.1234567890'],
      ['sub/a.tex', '3@1700000001.0000000000'],
    ],
  )
})

test('isSshRuntime accepts the service shape and rejects look-alikes', () => {
  assert.equal(isSshRuntime({ getConnectionFor() {}, getHost() {}, listHosts() {} }), true)
  assert.equal(isSshRuntime({ getHost() {}, listHosts() {} }), false)
  assert.equal(isSshRuntime(undefined), false)
})

test('path math is POSIX and messages name the host', async () => {
  const { tree: t } = tree()
  assert.equal(t.kind, 'ssh')
  assert.equal(t.resolve('/home/me/paper', 'chapters/intro.tex'), '/home/me/paper/chapters/intro.tex')
  assert.equal(t.dirname('/home/me/paper/main.tex'), '/home/me/paper')
  assert.equal(t.basename('/home/me/paper/main.tex'), 'main.tex')
  assert.equal(t.describe('/home/me/paper'), 'lab:/home/me/paper')
  assert.equal(await t.home(), '/home/me')
})

test('reads: missing is undefined, present is exact bytes (UTF-8 names and content)', async () => {
  const { tree: t } = tree({ files: { '/home/me/paper/图/架构.tex': '% 中文\n' } })
  assert.equal(await t.readText('/home/me/paper/missing.tex'), undefined)
  assert.equal(await t.readBytes('/home/me/paper/missing.tex'), undefined)
  assert.equal(await t.readText('/home/me/paper/图/架构.tex'), '% 中文\n')
  assert.equal(await t.exists('/home/me/paper/图/架构.tex'), true)
  assert.equal(await t.exists('/home/me/paper'), true)
  assert.equal(await t.exists('/home/me/elsewhere'), false)
  assert.equal((await t.stat('/home/me/paper'))?.isDirectory, true)
  assert.equal((await t.stat('/home/me/paper/图/架构.tex'))?.size, Buffer.byteLength('% 中文\n'))
})

test('writes create parents, replace atomically and leave no temp file behind', async () => {
  const { runtime, tree: t } = tree({ files: { '/home/me/paper/main.tex': 'old' } })
  await t.writeText('/home/me/paper/chapters/intro.tex', 'intro\n')
  await t.writeBytes('/home/me/paper/main.tex', Buffer.from('new', 'utf8'))
  await t.ensureDir('/home/me/paper/figures')

  assert.equal(runtime.read('/home/me/paper/chapters/intro.tex'), 'intro\n')
  assert.equal(runtime.read('/home/me/paper/main.tex'), 'new')
  assert.deepEqual([...runtime.files.keys()].sort(), ['/home/me/paper/chapters/intro.tex', '/home/me/paper/main.tex'])
  assert.deepEqual(await t.listDir('/home/me/paper'), ['chapters', 'figures', 'main.tex'])
  assert.deepEqual(await t.listDir('/home/me/paper/nowhere'), [])
})

test('rename replaces an existing target, even when the server refuses to', async () => {
  const refusing = tree({ files: { '/home/me/paper/main.tex': 'old' }, renameRefusesReplace: true })
  await refusing.tree.writeText('/home/me/paper/main.tex', 'new')
  assert.equal(refusing.runtime.read('/home/me/paper/main.tex'), 'new')

  const { runtime, tree: t } = tree({ files: { '/home/me/paper/a.tex': 'a', '/home/me/paper/b.tex': 'b' } })
  await t.rename('/home/me/paper/a.tex', '/home/me/paper/b.tex')
  assert.equal(runtime.read('/home/me/paper/b.tex'), 'a')
  assert.equal(runtime.files.has('/home/me/paper/a.tex'), false)
})

test('remove tolerates a missing file', async () => {
  const { runtime, tree: t } = tree({ files: { '/home/me/paper/a.tex': 'a' } })
  await t.remove('/home/me/paper/a.tex')
  await t.remove('/home/me/paper/a.tex')
  assert.equal(runtime.files.has('/home/me/paper/a.tex'), false)
})

test('listTree is one find call and skips .git and node_modules; an SFTP walk when find lacks -printf', async () => {
  const files = {
    '/home/me/paper/main.tex': 'a',
    '/home/me/paper/sections/intro.tex': 'b',
    '/home/me/paper/.git/config': 'git',
    '/home/me/paper/node_modules/x/index.js': 'js',
    '/home/me/paper/figures/arch.pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]),
  }
  const fast = tree({ files })
  const entries = await fast.tree.listTree('/home/me/paper')
  assert.deepEqual(
    entries.map((entry) => entry.rel),
    ['figures/arch.pdf', 'main.tex', 'sections/intro.tex'],
  )
  assert.equal(entries.find((entry) => entry.rel === 'figures/arch.pdf').size, 4)
  assert.equal(fast.runtime.calls.length, 1)
  assert.ok(fast.runtime.calls[0].startsWith("cd '/home/me/paper' && find . "))

  const slow = tree({ files, noPrintf: true })
  assert.deepEqual(
    (await slow.tree.listTree('/home/me/paper')).map((entry) => entry.rel),
    ['figures/arch.pdf', 'main.tex', 'sections/intro.tex'],
  )
  assert.deepEqual(await slow.tree.listFiles('/home/me/paper', (rel) => rel.endsWith('.tex')), ['main.tex', 'sections/intro.tex'])
  assert.deepEqual(await slow.tree.listTree('/home/me/paper/missing'), [])
})

test('hashFiles asks sha256sum once per batch and skips unreadable names', async () => {
  const png = Buffer.from([0, 1, 2])
  const { runtime, tree: t } = tree({ files: { '/home/me/paper/main.tex': 'a', '/home/me/paper/fig.png': png } })
  const hashes = await t.hashFiles('/home/me/paper', ['main.tex', 'fig.png', 'gone.tex'])
  assert.equal(hashes.size, 2)
  assert.equal(hashes.get('main.tex'), sha256(Buffer.from('a')))
  assert.equal(hashes.get('fig.png'), sha256(png))
  assert.equal(runtime.calls.length, 1)

  const none = tree({ noSha256sum: true })
  assert.equal((await none.tree.hashFiles('/home/me', ['x'])).size, 0)
})

test('canonical resolves through readlink -f and falls back to the lexical path', async () => {
  const { tree: t } = tree()
  assert.equal(await t.canonical('/home/me/./paper/../paper'), '/home/me/paper')
})

test('run quotes every argument; git missing on the host is exit 127', async () => {
  const { runtime, tree: t } = tree()
  const result = await t.run('/home/me/paper', 'git', ['commit', '-m', "it's a test"])
  assert.equal(result.code, 127)
  assert.equal(runtime.calls[0], `cd '/home/me/paper' && 'git' 'commit' '-m' 'it'\\''s a test'`)
})

test('a host that is down is E_HOST_UNREACHABLE; an IO failure is E_LOCAL_IO naming host and path', async () => {
  const down = tree({ offline: true })
  await assert.rejects(() => down.tree.readText('/home/me/paper/main.tex'), (err) => {
    assert.ok(err instanceof OverleafSyncError)
    assert.equal(err.code, 'E_HOST_UNREACHABLE')
    assert.match(err.message, /"lab"/)
    return true
  })

  const denied = tree({ files: { '/home/me/paper/main.tex': 'x' }, denied: (p) => p.endsWith('.tex') })
  await assert.rejects(() => denied.tree.readText('/home/me/paper/main.tex'), (err) => {
    assert.ok(err instanceof OverleafSyncError)
    assert.equal(err.code, 'E_LOCAL_IO')
    assert.equal(err.message, 'lab: read "/home/me/paper/main.tex" failed: Permission denied')
    return true
  })
})

test('watch polls the tracked files only and reports changed, added and removed paths', async () => {
  const { runtime, tree: t } = tree(
    { files: { '/home/me/paper/main.tex': 'a', '/home/me/paper/other.tex': 'x' } },
    { pollMs: 15 },
  )
  const events = []
  const stop = t.watch('/home/me/paper', ['main.tex', 'added.tex'], (rel) => events.push(rel), (error) =>
    events.push(`error: ${error}`),
  )
  await waitFor(() => runtime.calls.length >= 1, 'first fingerprint')
  await sleep(40)
  assert.deepEqual(events, [], 'the first answer is the baseline, not a change')

  runtime.write('/home/me/paper/main.tex', 'b')
  runtime.write('/home/me/paper/other.tex', 'y')
  runtime.write('/home/me/paper/added.tex', 'new')
  await waitFor(() => events.length >= 2, 'changes')
  stop()
  await sleep(40)
  assert.deepEqual([...events].sort(), ['added.tex', 'main.tex'])
  assert.ok(runtime.calls.every((command) => !command.includes('other.tex')), 'untracked files are never polled')

  // A removed file is a change too.
  const removals = []
  const before = runtime.calls.length
  const stopAgain = t.watch('/home/me/paper', ['added.tex'], (rel) => removals.push(rel), () => {})
  await waitFor(() => runtime.calls.length > before, 'second watcher baseline')
  await sleep(40)
  assert.deepEqual(removals, [])
  await t.remove('/home/me/paper/added.tex')
  await waitFor(() => removals.length >= 1, 'removal')
  stopAgain()
  assert.deepEqual(removals, ['added.tex'])
})

test('watch falls back to SFTP stat when find cannot fingerprint', async () => {
  const { runtime, tree: t } = tree({ files: { '/home/me/paper/main.tex': 'a' }, noPrintf: true }, { pollMs: 15 })
  const events = []
  const stop = t.watch('/home/me/paper', ['main.tex'], (rel) => events.push(rel), (error) => events.push(`error: ${error}`))
  await waitFor(() => runtime.stats.sftp >= 1, 'sftp fingerprint')
  await sleep(30)
  assert.deepEqual(events, [])
  runtime.write('/home/me/paper/main.tex', 'b')
  await waitFor(() => events.length >= 1, 'change via sftp')
  stop()
  assert.deepEqual(events, ['main.tex'])
})

test('watch reports a host that goes down instead of failing silently', async () => {
  const { runtime, tree: t } = tree({ files: { '/home/me/paper/main.tex': 'a' } }, { pollMs: 15 })
  const errors = []
  const stop = t.watch('/home/me/paper', ['main.tex'], () => {}, (error) => errors.push(error))
  await waitFor(() => runtime.calls.length >= 1, 'baseline')
  runtime.getConnectionFor = async () => {
    throw new Error('connect ETIMEDOUT')
  }
  await waitFor(() => errors.length >= 1, 'error report')
  stop()
  assert.ok(errors[0] instanceof OverleafSyncError)
  assert.equal(errors[0].code, 'E_HOST_UNREACHABLE')
})

async function waitFor(predicate, label, timeoutMs = 3000) {
  const started = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(5)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
