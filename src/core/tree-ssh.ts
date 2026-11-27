/**
 * The linked folder on an SSH host.
 *
 * The machine that runs dsh keeps talking to Overleaf itself; the project
 * files it syncs simply live elsewhere. Nothing on the host needs to reach
 * Overleaf or to know about this plugin: every operation is a plain SFTP call
 * or a stock shell command (`sha256sum`, GNU `find`, `readlink`, `git`).
 *
 * How each kind of access travels, and why:
 *
 * - **SFTP** carries file contents and names (read, atomic write, rename,
 *   stat, readdir). Names and bytes arrive intact — the exec channel decodes
 *   its stdout chunk by chunk, which can split a multi-byte character.
 * - **exec** carries only bulk metadata the server can compute cheaper than we
 *   can download: hashes for the "pending changes" badge, size/mtime
 *   fingerprints for the watcher, the file listing git sizes up. Anything
 *   that may contain file names is base64-wrapped on the host and decoded
 *   here, so a non-ASCII name survives the channel byte for byte.
 *
 * The SSH runtime is the `ssh` service of dsh-cloud-workspaces, described
 * structurally below so this plugin neither imports nor depends on it.
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'

import { OverleafSyncError, describeError } from './errors.js'
import { chunkArgs, type RunResult, type TreeEntry, type TreeIo, type TreeStat } from './tree.js'

// ------------------------------------------------------------------ contracts

/** What we need to know about a configured host. */
export interface SshHostSummaryLike {
  alias: string
  host?: string
  user?: string
  description?: string
}

/** One `exec` on the host, as the cloud-workspaces engine reports it. */
export interface SshExecOutcome {
  exitCode: number | null
  timedOut?: boolean
  stdout: string
  stderr: string
  error?: string
}

export interface SftpStatsLike {
  size: number
  /** whole seconds — the SFTP v3 attribute has no finer resolution */
  mtime: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface SftpEntryLike {
  filename: string
  attrs: SftpStatsLike
}

type SftpCallback<T> = (err: Error | undefined | null, value: T) => void
type SftpDone = (err: Error | undefined | null) => void

/** The slice of ssh2's `SFTPWrapper` this tree uses (callback style, as ssh2 has it). */
export interface SftpLike {
  stat(p: string, cb: SftpCallback<SftpStatsLike>): void
  readFile(p: string, cb: SftpCallback<Buffer>): void
  writeFile(p: string, data: Buffer, cb: SftpDone): void
  rename(from: string, to: string, cb: SftpDone): void
  mkdir(p: string, cb: SftpDone): void
  unlink(p: string, cb: SftpDone): void
  readdir(p: string, cb: SftpCallback<SftpEntryLike[]>): void
}

/** `posix-rename@openssh.com`: rename that always replaces the target, atomically. */
interface PosixRenameExtension {
  ext_openssh_rename?: (from: string, to: string, cb: SftpDone) => void
}

export interface SshConnectionLike {
  /** Remote `$HOME`, when the runtime resolved it. */
  readonly home: string | undefined
  exec(command: string, options?: { timeoutMs?: number; cwd?: string }): Promise<SshExecOutcome>
  getSftp(): Promise<SftpLike>
  /** `direct-tcpip` channel to `host:port` from the host's network position (optional on stubs). */
  forwardOut?(host: string, port: number): Promise<import('node:stream').Duplex>
}

/** The slice of the dsh-cloud-workspaces `ssh` service this tree consumes. */
export interface SshRuntimeLike {
  /** Connection to `alias` without switching the session's active target. */
  getConnectionFor(alias: string): Promise<SshConnectionLike>
  getHost(alias: string): SshHostSummaryLike | undefined
  listHosts(query?: string): SshHostSummaryLike[]
}

export interface SshTreeOptions {
  /** Watcher polling interval in milliseconds (default 3000). */
  pollMs?: number
  /** Per-exec timeout for bulk commands (default 30 s). */
  execTimeoutMs?: number
}

/** Runtime check so a differently shaped `ssh` service degrades into "no hosts" instead of a crash. */
export function isSshRuntime(value: unknown): value is SshRuntimeLike {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<SshRuntimeLike>
  return (
    typeof candidate.getConnectionFor === 'function' &&
    typeof candidate.getHost === 'function' &&
    typeof candidate.listHosts === 'function'
  )
}

// -------------------------------------------------------------------- shell

/** POSIX single-quote escaping for remote shell interpolation. */
export function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Run `command` inside `root`. */
export function inDir(root: string, command: string): string {
  return `cd ${quoteSh(root)} && ${command}`
}

/** `sha256sum` over the given files, base64-wrapped: `<hex>  <name>` per line. Unreadable names are skipped. */
export function hashCommand(rels: readonly string[]): string {
  return `sha256sum -- ${rels.map(quoteSh).join(' ')} 2>/dev/null | base64 | tr -d '\\n'`
}

/** GNU `find` size/mtime fingerprint of the given starting points, base64-wrapped. */
export function fingerprintCommand(rels: readonly string[]): string {
  return `find -- ${rels.map(quoteSh).join(' ')} -printf '%p\\t%s\\t%T@\\n' | base64 | tr -d '\\n'`
}

/** GNU `find` listing of every regular file below `.`, base64-wrapped. */
export function treeListingCommand(): string {
  return `find . \\( -name .git -o -name node_modules \\) -prune -o -type f -printf '%P\\t%s\\t%T@\\n' | base64 | tr -d '\\n'`
}

/** `sha256sum` escapes a name that contains a newline or backslash; undo that. */
export function unescapeChecksumName(name: string): string {
  return name.replace(/\\(.)/g, (_match, escaped: string) =>
    escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped,
  )
}

/** Parse the decoded output of {@link hashCommand}: relative path → raw sha256 hex. */
export function parseChecksumLines(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^(\\?)([0-9a-f]{64}) [ *](.*)$/.exec(line)
    if (match === null) continue
    const name = match[1] === '\\' ? unescapeChecksumName(match[3] ?? '') : (match[3] ?? '')
    if (name !== '') out.set(name, match[2]!)
  }
  return out
}

/** Parse the decoded output of a `find -printf '%p\t%s\t%T@'` command into `size@mtime` signatures. */
export function parseFingerprintLines(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const [name, size, mtime] = line.split('\t')
    if (name === undefined || name === '' || size === undefined || mtime === undefined) continue
    out.set(name.replace(/^\.\//, ''), `${size}@${mtime}`)
  }
  return out
}

function decodeWrapped(stdout: string): string {
  const trimmed = stdout.trim()
  return trimmed === '' ? '' : Buffer.from(trimmed, 'base64').toString('utf8')
}

function isMissingPath(err: unknown): boolean {
  return /no such file|ENOENT|not found/i.test(err instanceof Error ? err.message : String(err))
}

function sftpCall<T>(invoke: (cb: SftpCallback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((err, value) => {
      if (err !== undefined && err !== null) reject(err)
      else resolve(value)
    })
  })
}

function byPath(a: TreeEntry, b: TreeEntry): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
}

// -------------------------------------------------------------------- tree

export class SshTree implements TreeIo {
  readonly kind = 'ssh' as const

  constructor(
    private readonly runtime: SshRuntimeLike,
    readonly host: string,
    private readonly options: SshTreeOptions = {},
  ) {}

  // -------------------------------------------------------------- path math

  join(...parts: string[]): string {
    return posix.join(...parts)
  }

  dirname(p: string): string {
    return posix.dirname(p)
  }

  basename(p: string): string {
    return posix.basename(p)
  }

  resolve(root: string, rel: string): string {
    return posix.join(root, ...rel.split('/'))
  }

  describe(root: string): string {
    return `${this.host}:${root}`
  }

  /** Remote `$HOME`, for `~` in a folder the user typed. */
  async home(): Promise<string | undefined> {
    return (await this.connection()).home
  }

  // ----------------------------------------------------------------- content

  async readBytes(abs: string): Promise<Buffer | undefined> {
    return this.io('read', abs, async () => {
      const sftp = await this.sftp()
      try {
        return await sftpCall<Buffer>((cb) => sftp.readFile(abs, cb))
      } catch (err) {
        if (isMissingPath(err)) return undefined
        throw err
      }
    })
  }

  async readText(abs: string): Promise<string | undefined> {
    const bytes = await this.readBytes(abs)
    return bytes === undefined ? undefined : bytes.toString('utf8')
  }

  async writeBytes(abs: string, data: Uint8Array): Promise<void> {
    await this.io('write', abs, async () => {
      const sftp = await this.sftp()
      const bytes = Buffer.from(data)
      const dir = posix.dirname(abs)
      const temp = posix.join(dir, `.${posix.basename(abs)}.${process.pid}.${randomUUID()}.tmp`)
      try {
        try {
          await sftpCall<void>((cb) => sftp.writeFile(temp, bytes, cb))
        } catch (err) {
          if (!isMissingPath(err)) throw err
          await this.mkdirp(dir)
          await sftpCall<void>((cb) => sftp.writeFile(temp, bytes, cb))
        }
        await this.rename(temp, abs)
      } catch (err) {
        await this.remove(temp).catch(() => undefined)
        throw err
      }
    })
  }

  async writeText(abs: string, text: string): Promise<void> {
    await this.writeBytes(abs, Buffer.from(text, 'utf8'))
  }

  async ensureDir(abs: string): Promise<void> {
    await this.io('mkdir', abs, () => this.mkdirp(abs))
  }

  async exists(abs: string): Promise<boolean> {
    return (await this.stat(abs)) !== undefined
  }

  async stat(abs: string): Promise<TreeStat | undefined> {
    return this.io('stat', abs, async () => {
      const sftp = await this.sftp()
      try {
        const stats = await sftpCall<SftpStatsLike>((cb) => sftp.stat(abs, cb))
        return { size: stats.size, mtimeMs: stats.mtime * 1000, isFile: stats.isFile(), isDirectory: stats.isDirectory() }
      } catch (err) {
        if (isMissingPath(err)) return undefined
        throw err
      }
    })
  }

  async listDir(abs: string): Promise<string[]> {
    return this.io('readdir', abs, async () => {
      const sftp = await this.sftp()
      try {
        const entries = await sftpCall<SftpEntryLike[]>((cb) => sftp.readdir(abs, cb))
        return entries.map((entry) => entry.filename).sort()
      } catch (err) {
        if (isMissingPath(err)) return []
        throw err
      }
    })
  }

  /**
   * One `find` over the tree. A host whose `find` has no `-printf` (busybox
   * containers) says so on stderr and gets an SFTP walk instead, at
   * second-resolution timestamps.
   */
  async listTree(root: string): Promise<TreeEntry[]> {
    const result = await this.exec(inDir(root, treeListingCommand()), this.listingTimeoutMs())
    if (result.stderr.trim() === '') {
      const entries: TreeEntry[] = []
      for (const line of decodeWrapped(result.stdout).split('\n')) {
        const [rel, size, mtime] = line.split('\t')
        if (rel === undefined || rel === '' || size === undefined || mtime === undefined) continue
        entries.push({ rel, size: Number(size), mtimeMs: Number.parseFloat(mtime) * 1000 })
      }
      return entries.sort(byPath)
    }
    return this.listTreeViaSftp(root)
  }

  async listFiles(root: string, filter?: (rel: string) => boolean): Promise<string[]> {
    const entries = await this.listTree(root)
    return entries.map((entry) => entry.rel).filter((rel) => filter === undefined || filter(rel))
  }

  async rename(from: string, to: string): Promise<void> {
    await this.io('rename', to, async () => {
      const sftp = await this.sftp()
      try {
        await sftpCall<void>((cb) => sftp.rename(from, to, cb))
        return
      } catch (err) {
        if (isMissingPath(err)) throw err
        // SFTP v3 lets a server refuse to replace an existing target. Prefer
        // the atomic OpenSSH extension; only then drop the target and retry.
        const posixRename = (sftp as SftpLike & PosixRenameExtension).ext_openssh_rename
        if (typeof posixRename === 'function') {
          try {
            await sftpCall<void>((cb) => posixRename.call(sftp, from, to, cb))
            return
          } catch {
            // fall through to the non-atomic retry
          }
        }
        await this.remove(to).catch(() => undefined)
        await sftpCall<void>((cb) => sftp.rename(from, to, cb))
      }
    })
  }

  async remove(abs: string): Promise<void> {
    await this.io('unlink', abs, async () => {
      const sftp = await this.sftp()
      try {
        await sftpCall<void>((cb) => sftp.unlink(abs, cb))
      } catch (err) {
        if (!isMissingPath(err)) throw err
      }
    })
  }

  async canonical(abs: string): Promise<string> {
    const result = await this.exec(`readlink -f -- ${quoteSh(abs)}`)
    const resolved = result.stdout.trim()
    return result.code === 0 && resolved.startsWith('/') ? resolved : posix.normalize(abs)
  }

  /** `git` and friends: every argument quoted, run in `cwd` on the host. */
  async run(cwd: string, command: string, args: string[]): Promise<RunResult> {
    return this.exec(inDir(cwd, [command, ...args].map(quoteSh).join(' ')), 120_000)
  }

  /** One `sha256sum` per batch of files; whatever it could not read is left out. */
  async hashFiles(root: string, rels: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const batch of chunkArgs(rels, 400, 48_000)) {
      const result = await this.exec(inDir(root, hashCommand(batch)), this.execTimeoutMs())
      for (const [name, hex] of parseChecksumLines(decodeWrapped(result.stdout))) out.set(name, hex)
    }
    return out
  }

  /**
   * Poll the size/mtime fingerprint of the tracked files. One short `find`
   * per tick, so a large folder costs no more than a small one.
   */
  watch(
    root: string,
    paths: readonly string[],
    onChange: (rel: string) => void,
    onError: (error: unknown) => void,
  ): () => void {
    const pollMs = this.options.pollMs ?? 3000
    const tracked = [...new Set(paths)]
    let previous: Map<string, string> | undefined
    let stopped = false
    let inFlight = false

    const tick = async (): Promise<void> => {
      if (stopped || inFlight || tracked.length === 0) return
      inFlight = true
      try {
        const next = await this.fingerprint(root, tracked)
        // The first answer is the baseline: files that existed before the
        // watcher started are not "changes".
        if (stopped || previous === undefined) {
          previous = next
          return
        }
        for (const [rel, signature] of next) {
          if (previous.get(rel) !== signature) onChange(rel)
        }
        for (const rel of previous.keys()) {
          if (!next.has(rel)) onChange(rel)
        }
        previous = next
      } catch (err) {
        if (!stopped) onError(err)
      } finally {
        inFlight = false
      }
    }

    const timer = setInterval(() => void tick(), pollMs)
    timer.unref?.()
    void tick()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  // --------------------------------------------------------------- internals

  private execTimeoutMs(): number {
    return this.options.execTimeoutMs ?? 30_000
  }

  private listingTimeoutMs(): number {
    return Math.max(this.execTimeoutMs(), 60_000)
  }

  private async connection(): Promise<SshConnectionLike> {
    try {
      return await this.runtime.getConnectionFor(this.host)
    } catch (err) {
      if (err instanceof OverleafSyncError) throw err
      throw new OverleafSyncError(
        'E_HOST_UNREACHABLE',
        `cannot reach SSH host "${this.host}": ${describeError(err)}`,
        'check the host under 设置 → SSH 连接 (dsh-cloud-workspaces) or with ssh_list, then retry',
      )
    }
  }

  private async sftp(): Promise<SftpLike> {
    return (await this.connection()).getSftp() as unknown as SftpLike
  }

  /** Name the host and the path in every failure; a dropped line must not look like a policy error. */
  private async io<T>(operation: string, abs: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (err instanceof OverleafSyncError) throw err
      throw new OverleafSyncError(
        'E_LOCAL_IO',
        `${this.host}: ${operation} "${abs}" failed: ${describeError(err)}`,
        'check that the folder exists on the host and that the SSH user can read and write it',
      )
    }
  }

  private async exec(command: string, timeoutMs = this.execTimeoutMs()): Promise<RunResult> {
    const outcome = await (await this.connection()).exec(command, { timeoutMs })
    const stderr = [outcome.stderr, outcome.error, outcome.timedOut ? 'timed out' : '']
      .filter((part) => part !== undefined && part !== '')
      .join('\n')
    return { code: outcome.exitCode ?? -1, stdout: outcome.stdout, stderr }
  }

  private async mkdirp(dir: string): Promise<void> {
    if (dir === '' || dir === '/' || dir === '.') return
    const existing = await this.stat(dir)
    if (existing !== undefined) {
      if (existing.isDirectory) return
      throw new Error(`not a directory: ${dir}`)
    }
    await this.mkdirp(posix.dirname(dir))
    const sftp = await this.sftp()
    try {
      await sftpCall<void>((cb) => sftp.mkdir(dir, cb))
    } catch (err) {
      // Created underneath us a moment ago: fine. Anything else is real.
      if ((await this.stat(dir))?.isDirectory !== true) throw err
    }
  }

  private async fingerprint(root: string, paths: readonly string[]): Promise<Map<string, string>> {
    const result = await this.exec(inDir(root, fingerprintCommand(paths)), 15_000)
    // `find` prints nothing for a file that is gone and an error for a flag it
    // does not know. Both mean "ask SFTP instead", which is exact either way.
    if (result.stderr.trim() !== '') return this.fingerprintViaSftp(root, paths)
    return parseFingerprintLines(decodeWrapped(result.stdout))
  }

  private async fingerprintViaSftp(root: string, paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const batch of chunkArgs(paths, 32, Number.POSITIVE_INFINITY)) {
      const stats = await Promise.all(batch.map((rel) => this.stat(this.resolve(root, rel))))
      batch.forEach((rel, index) => {
        const entry = stats[index]
        if (entry !== undefined && entry.isFile) out.set(rel, `${entry.size}@${entry.mtimeMs}`)
      })
    }
    return out
  }

  private async listTreeViaSftp(root: string): Promise<TreeEntry[]> {
    const sftp = await this.sftp()
    const walk = async (dir: string, relPrefix: string): Promise<TreeEntry[]> => {
      let entries: SftpEntryLike[]
      try {
        entries = await sftpCall<SftpEntryLike[]>((cb) => sftp.readdir(dir, cb))
      } catch (err) {
        if (isMissingPath(err)) return []
        throw err
      }
      // Symlinks are neither file nor directory here, so they are skipped —
      // the same rule the local tree follows.
      const nested = await Promise.all(
        entries.map(async (entry): Promise<TreeEntry[]> => {
          const rel = relPrefix === '' ? entry.filename : `${relPrefix}/${entry.filename}`
          if (entry.attrs.isDirectory()) {
            if (entry.filename === '.git' || entry.filename === 'node_modules') return []
            return walk(posix.join(dir, entry.filename), rel)
          }
          if (!entry.attrs.isFile()) return []
          return [{ rel, size: entry.attrs.size, mtimeMs: entry.attrs.mtime * 1000 }]
        }),
      )
      return nested.flat()
    }
    return this.io('readdir', root, async () => (await walk(root, '')).sort(byPath))
  }
}
