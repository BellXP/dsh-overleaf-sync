/**
 * Live smoke test of `SshTree` against a real host — opt-in, never part of
 * `npm test`:
 *
 *   node test/live/tree-ssh.live.mjs [alias]
 *
 * It connects through the real `SshRuntime` of dsh-cloud-workspaces (same
 * host store, key and proxy settings dsh uses), creates one uniquely named
 * directory under `/tmp` (or under `DSH_OLS_LIVE_PARENT`, to exercise the
 * storage the paper really lives on), runs every tree operation there, and
 * removes it. A handful of tiny files and short commands: nothing else on
 * the host is touched.
 *
 * What this proves that the in-memory fake cannot: SFTP rename really
 * replaces an existing file on this server, GNU `find -printf` and
 * `sha256sum` behave as expected, `base64 | tr` keeps non-ASCII names intact,
 * and a change made by a shell on the host is seen by the watcher.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..', '..')
const cloudRoot = process.env.DSH_CLOUD_WORKSPACES ?? path.resolve(pluginRoot, '..', 'dsh-cloud-workspaces')
const alias = process.argv[2] ?? process.env.DSH_OLS_LIVE_SSH
if (alias === undefined) {
  console.error('usage: node test/live/tree-ssh.live.mjs <ssh alias>')
  process.exit(2)
}

const importFile = (file) => import(pathToFileURL(file).href)
const { SshTree } = await importFile(path.join(pluginRoot, 'lib', 'core', 'tree-ssh.js'))

// The same copies of cordis and the cloud-workspaces runtime that dsh loads.
const cloudRequire = createRequire(path.join(cloudRoot, 'package.json'))
const { Context } = await importFile(cloudRequire.resolve('@deepseek-ai/cordis'))
const { SshRuntime, Config } = await importFile(path.join(cloudRoot, 'lib', 'ssh-service.js'))

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ctx = new Context()
const runtime = new SshRuntime(ctx, Config({}))
// A connection normally captures a login-environment snapshot in the
// background and records it in the host store. That store belongs to the
// running dsh: this standalone runtime must never write to it.
runtime.ensureLoginEnv = () => {}
const tree = new SshTree(runtime, alias, { pollMs: 500 })
const summary = runtime.getHost(alias)
if (summary === undefined) {
  console.error(`host "${alias}" is not configured`)
  process.exit(2)
}
const shell = async (command) => {
  const connection = await runtime.getConnectionFor(alias)
  return connection.exec(command, { timeoutMs: 20_000 })
}
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`

let root = ''
let failures = 0
async function step(label, run) {
  try {
    await run()
    console.log(`ok   ${label}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

try {
  console.log(`host ${alias} (${summary.user}@${summary.host}:${summary.port})`)
  await step('connect and resolve the remote home', async () => {
    const home = await tree.home()
    assert.ok(home !== undefined && home.startsWith('/'), `unexpected home: ${home}`)
    console.log(`     home=${home}`)
  })
  if (failures > 0) throw new Error('not connected')

  // `/tmp` by default; a parent on the shared storage (DSH_OLS_LIVE_PARENT=/xupeng)
  // checks the filesystem the paper will really live on.
  const parent = process.env.DSH_OLS_LIVE_PARENT ?? '/tmp'
  const name = parent === '/tmp' ? `dsh-overleaf-sync-live-${randomBytes(6).toString('hex')}` : `.dsh-overleaf-sync-live-${randomBytes(6).toString('hex')}`
  root = `${parent}/${name}`
  const sub = `${root}/sub dir 中文`
  const textFile = `${sub}/a.tex`
  const binFile = `${root}/fig.bin`
  const bin = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x80, 0xfe])
  const text = 'héllo 中文 — over SSH\n\\documentclass{article}\n'
  const second = `${text}% second version\n`

  await step('ensureDir creates nested directories (space + non-ASCII in the name)', async () => {
    await tree.ensureDir(sub)
    assert.equal((await tree.stat(sub))?.isDirectory, true)
  })
  await step('writeText / writeBytes land on the host with exact bytes', async () => {
    await tree.writeText(textFile, text)
    await tree.writeBytes(binFile, bin)
    const viaShell = await shell(`wc -c < ${quote(binFile)}`)
    assert.equal(viaShell.stdout.trim(), String(bin.length))
  })
  await step('readText / readBytes round-trip exactly', async () => {
    assert.equal(await tree.readText(textFile), text)
    assert.deepEqual(await tree.readBytes(binFile), bin)
    assert.equal(await tree.readText(`${root}/missing.tex`), undefined)
  })
  await step('a second write replaces the file atomically and leaves no temp file', async () => {
    await tree.writeText(textFile, second)
    assert.equal(await tree.readText(textFile), second)
    assert.deepEqual(await tree.listDir(sub), ['a.tex'])
  })
  await step('listTree is one find call, sorted, without .git entries, with sizes', async () => {
    await tree.writeText(`${root}/.git/config`, 'git')
    const entries = await tree.listTree(root)
    assert.deepEqual(
      entries.map((entry) => entry.rel),
      ['fig.bin', 'sub dir 中文/a.tex'],
    )
    assert.equal(entries.find((entry) => entry.rel === 'fig.bin').size, bin.length)
    assert.equal(entries.find((entry) => entry.rel === 'sub dir 中文/a.tex').size, Buffer.byteLength(second))
  })
  await step('hashFiles matches local sha256 and skips a missing name', async () => {
    const hashes = await tree.hashFiles(root, ['sub dir 中文/a.tex', 'fig.bin', 'missing'])
    assert.equal(hashes.size, 2)
    assert.equal(hashes.get('sub dir 中文/a.tex'), sha256(Buffer.from(second)))
    assert.equal(hashes.get('fig.bin'), sha256(bin))
  })
  await step('canonical resolves . and .. on the host', async () => {
    assert.equal(await tree.canonical(`${root}/./x/..`), root)
  })
  await step('run executes git on the host', async () => {
    const result = await tree.run(root, 'git', ['--version'])
    assert.equal(result.code, 0, result.stderr)
    console.log(`     ${result.stdout.trim()}`)
  })
  await step('watch sees a change made by a shell on the host', async () => {
    const events = []
    const stop = tree.watch(root, ['fig.bin'], (rel) => events.push(rel), (err) => events.push(`error: ${err}`))
    await sleep(1300)
    assert.deepEqual(events, [], 'quiet tree, quiet watcher')
    await shell(`printf 'x' >> ${quote(binFile)}`)
    const started = Date.now()
    while (events.length === 0 && Date.now() - started < 6000) await sleep(100)
    stop()
    assert.deepEqual(events, ['fig.bin'])
  })
  await step('remove deletes, and tolerates a second call', async () => {
    await tree.remove(binFile)
    assert.equal(await tree.exists(binFile), false)
    await tree.remove(binFile)
  })
} finally {
  if (/\/\.?dsh-overleaf-sync-live-[0-9a-f]{12}$/.test(root)) {
    await step('clean up the temporary directory', async () => {
      const result = await shell(`rm -rf -- ${quote(root)} && test ! -e ${quote(root)} && echo gone`)
      assert.equal(result.stdout.trim(), 'gone')
    })
  }
  runtime.engine.dispose()
}

console.log(failures === 0 ? 'all live checks passed' : `${failures} live check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
