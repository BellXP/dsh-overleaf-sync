/**
 * Project-tree IO.
 *
 * "The local folder" is a role, not always the local disk. The sync engine
 * addresses the linked folder as a tree of files keyed by POSIX relative paths
 * and reaches it only through {@link TreeIo}, so the same engine runs against
 * this machine (`LocalTree`) or against a directory on an SSH host
 * (`SshTree` in `tree-ssh.ts`, via the dsh-cloud-workspaces `ssh` service).
 *
 * Plugin state (`~/.dsh/overleaf-sync`) never goes through this interface: it
 * always lives on the machine that runs dsh.
 *
 * Two rules every implementation follows:
 *
 * - a missing path reads as `undefined` and never throws; real IO errors do;
 * - writes are atomic (temp file next to the target, then rename), so a crash
 *   or a dropped connection can never leave half a document behind.
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { posix } from 'node:path'

export interface TreeStat {
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
}

/** One regular file of the linked tree, with the metadata git and the watcher compare. */
export interface TreeEntry {
  /** project-relative, POSIX separators */
  rel: string
  size: number
  mtimeMs: number
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface TreeIo {
  readonly kind: 'local' | 'ssh'

  /** Path arithmetic inside this tree (host separators locally, POSIX over SSH). */
  join(...parts: string[]): string
  dirname(p: string): string
  basename(p: string): string
  /** Project-relative POSIX path → absolute path in this tree. */
  resolve(root: string, rel: string): string
  /** How a message names this folder: the path, or `host:path` for a remote one. */
  describe(root: string): string

  /** `undefined` when the path is missing; throws for anything else. */
  readBytes(abs: string): Promise<Buffer | undefined>
  readText(abs: string): Promise<string | undefined>
  /** Atomic; creates the parent directory. */
  writeBytes(abs: string, data: Uint8Array): Promise<void>
  writeText(abs: string, text: string): Promise<void>
  ensureDir(abs: string): Promise<void>
  exists(abs: string): Promise<boolean>
  stat(abs: string): Promise<TreeStat | undefined>
  /** Entry names of one directory, sorted; `[]` when it is missing. */
  listDir(abs: string): Promise<string[]>
  /** Every regular file below `root` (`.git` and `node_modules` skipped), sorted by path. */
  listTree(root: string): Promise<TreeEntry[]>
  listFiles(root: string, filter?: (rel: string) => boolean): Promise<string[]>
  /** Move a file; replaces an existing target. */
  rename(from: string, to: string): Promise<void>
  /** Delete a file; a missing path is not an error. */
  remove(abs: string): Promise<void>
  /** Symlink-resolved form of `abs` (best effort). */
  canonical(abs: string): Promise<string>

  /** Run one command in `cwd`; rejects only when the command cannot be started at all. */
  run(cwd: string, command: string, args: string[]): Promise<RunResult>

  /**
   * Raw `sha256` hex of each file, keyed by the given relative paths. Files
   * that cannot be read are simply absent from the map.
   */
  hashFiles(root: string, rels: readonly string[]): Promise<Map<string, string>>

  /**
   * Report changes to the given project-relative paths until the returned
   * disposer is called. `onChange` fires once per path that changed, appeared
   * or disappeared; its own writes are filtered by the caller, on content.
   */
  watch(
    root: string,
    paths: readonly string[],
    onChange: (rel: string) => void,
    onError: (error: unknown) => void,
  ): () => void
}

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

function isMissingError(err: unknown): boolean {
  return MISSING_CODES.has((err as NodeJS.ErrnoException | null)?.code ?? '')
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Split `items` into runs of at most `maxCount` entries whose joined length stays under `maxChars`. */
export function chunkArgs(items: readonly string[], maxCount: number, maxChars: number): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let length = 0
  for (const item of items) {
    if (current.length > 0 && (current.length >= maxCount || length + item.length + 2 > maxChars)) {
      batches.push(current)
      current = []
      length = 0
    }
    current.push(item)
    length += item.length + 2
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Run `task` over `items` with at most `limit` in flight; the first rejection wins. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      out[index] = await task(items[index]!)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * The linked folder on this machine — the behaviour the plugin always had,
 * expressed in the tree vocabulary.
 */
export class LocalTree implements TreeIo {
  readonly kind = 'local' as const

  join(...parts: string[]): string {
    return path.join(...parts)
  }

  dirname(p: string): string {
    return path.dirname(p)
  }

  basename(p: string): string {
    return path.basename(p)
  }

  resolve(root: string, rel: string): string {
    return path.join(root, ...rel.split('/'))
  }

  describe(root: string): string {
    return root
  }

  async readBytes(abs: string): Promise<Buffer | undefined> {
    try {
      return await fsp.readFile(abs)
    } catch (err) {
      if (isMissingError(err)) return undefined
      throw err
    }
  }

  async readText(abs: string): Promise<string | undefined> {
    const bytes = await this.readBytes(abs)
    return bytes === undefined ? undefined : bytes.toString('utf8')
  }

  async writeBytes(abs: string, data: Uint8Array): Promise<void> {
    const dir = path.dirname(abs)
    await fsp.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await fsp.writeFile(temp, data)
      await fsp.rename(temp, abs)
    } catch (err) {
      await fsp.rm(temp, { force: true }).catch(() => undefined)
      throw err
    }
  }

  writeText(abs: string, text: string): Promise<void> {
    return this.writeBytes(abs, Buffer.from(text, 'utf8'))
  }

  async ensureDir(abs: string): Promise<void> {
    await fsp.mkdir(abs, { recursive: true })
  }

  async exists(abs: string): Promise<boolean> {
    try {
      await fsp.access(abs)
      return true
    } catch {
      return false
    }
  }

  async stat(abs: string): Promise<TreeStat | undefined> {
    try {
      const stats = await fsp.stat(abs)
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      }
    } catch (err) {
      if (isMissingError(err)) return undefined
      throw err
    }
  }

  async listDir(abs: string): Promise<string[]> {
    try {
      return (await fsp.readdir(abs)).sort()
    } catch (err) {
      if (isMissingError(err)) return []
      throw err
    }
  }

  async listTree(root: string): Promise<TreeEntry[]> {
    const rels: string[] = []
    const walk = async (dir: string, relPrefix: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isMissingError(err)) return
        throw err
      }
      for (const entry of entries) {
        const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue
          await walk(path.join(dir, entry.name), rel)
        } else if (entry.isFile()) {
          rels.push(rel)
        }
      }
    }
    await walk(root, '')
    const stats = await mapLimit(rels, 64, async (rel) => {
      try {
        const stats = await fsp.stat(path.join(root, ...rel.split('/')))
        return stats.isFile() ? { rel, size: stats.size, mtimeMs: stats.mtimeMs } : undefined
      } catch {
        return undefined
      }
    })
    return stats.filter((entry): entry is TreeEntry => entry !== undefined)
  }

  async listFiles(root: string, filter?: (rel: string) => boolean): Promise<string[]> {
    const entries = await this.listTree(root)
    return entries.map((entry) => entry.rel).filter((rel) => filter === undefined || filter(rel))
  }

  rename(from: string, to: string): Promise<void> {
    return fsp.rename(from, to)
  }

  async remove(abs: string): Promise<void> {
    await fsp.unlink(abs).catch((err: unknown) => {
      if (!isMissingError(err)) throw err
    })
  }

  async canonical(abs: string): Promise<string> {
    // `.native` resolves 8.3 short names on Windows, which is what git prints.
    try {
      return fs.realpathSync.native(abs)
    } catch {
      try {
        return await fsp.realpath(abs)
      } catch {
        return abs
      }
    }
  }

  run(cwd: string, command: string, args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })
  }

  async hashFiles(root: string, rels: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    await mapLimit(rels, 16, async (rel) => {
      const bytes = await this.readBytes(this.resolve(root, rel)).catch(() => undefined)
      if (bytes !== undefined) out.set(rel, sha256Hex(bytes))
    })
    return out
  }

  watch(
    root: string,
    _paths: readonly string[],
    onChange: (rel: string) => void,
    onError: (error: unknown) => void,
  ): () => void {
    // The OS reports every change under the folder for free, so the path list
    // is ignored here; the caller drops paths it does not track.
    const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (typeof filename !== 'string' || filename.length === 0) return
      onChange(filename.replaceAll('\\', '/'))
    })
    watcher.on('error', onError)
    return () => {
      try {
        watcher.close()
      } catch {
        // closing an already-closed watcher is not an error
      }
    }
  }
}

/** Shared instance: it holds no state. */
export const localTree: TreeIo = new LocalTree()
