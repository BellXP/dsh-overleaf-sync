/**
 * An in-memory "SSH host" shaped like the slice of the dsh-cloud-workspaces
 * `ssh` service that `SshTree` consumes: an SFTP filesystem, plus the few
 * stock shell commands the tree issues over exec (`sha256sum`, GNU `find`,
 * `readlink`, `git`).
 *
 * Nothing here speaks SSH. What the tests exercise is the plugin's own logic
 * on top of those primitives — which files it writes where, how it recovers
 * from a host without GNU find, what a user sees when the host is down.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

function missing(path) {
  return Object.assign(new Error(`No such file: ${path}`), { code: 2 })
}

/** Every single-quoted argument of a command, with `'\''` unescaped. */
export function quotedArgs(text) {
  const out = []
  const pattern = /'((?:[^']|'\\'')*)'/g
  for (const match of text.matchAll(pattern)) out.push(match[1].replaceAll("'\\''", "'"))
  return out
}

const HASH_RE =/^cd '(.+?)' && sha256sum -- (.*?) 2>\/dev\/null \| base64 \| tr -d '\\n'$/
const FINGERPRINT_RE = /^cd '(.+?)' && find -- (.*?) -printf '%p\\t%s\\t%T@\\n' \| base64 \| tr -d '\\n'$/
const LISTING_RE =
  /^cd '(.+?)' && find \. \\\( -name \.git -o -name node_modules \\\) -prune -o -type f -printf '%P\\t%s\\t%T@\\n' \| base64 \| tr -d '\\n'$/
const REALPATH_RE = /^readlink -f -- '(.+)'$/
const GIT_RE = /^cd '(.+?)' && 'git' (.+)$/

export function fakeSshRuntime(options = {}) {
  const home = options.home ?? '/home/me'
  const files = new Map()
  const dirs = new Set(['/', home])
  const mtimes = new Map()
  const calls = []
  const stats = { exec: 0, sftp: 0, connections: 0 }
  let clock = 1_700_000_000
  const hosts = options.hosts ?? [{ alias: 'lab', host: '10.0.0.1', user: 'root', description: 'lab server' }]

  function mkdirp(dir) {
    if (dir === '' || dir === '/' || dirs.has(dir)) return
    mkdirp(posix.dirname(dir))
    dirs.add(dir)
  }

  function put(path, content) {
    mkdirp(posix.dirname(path))
    files.set(path, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, 'utf8'))
    clock += 1
    mtimes.set(path, `${clock}.1234567890`)
  }

  for (const [path, content] of Object.entries(options.files ?? {})) put(path, content)

  const fileEntry = (path) => {
    const bytes = files.get(path)
    return {
      filename: posix.basename(path),
      attrs: {
        size: bytes.length,
        mtime: Number(mtimes.get(path)?.split('.')[0] ?? clock),
        isFile: () => true,
        isDirectory: () => false,
      },
    }
  }
  const dirEntry = (path) => ({
    filename: posix.basename(path),
    attrs: { size: 0, mtime: clock, isFile: () => false, isDirectory: () => true },
  })
  const statsOf = (path) => (dirs.has(path) ? dirEntry(path).attrs : files.has(path) ? fileEntry(path).attrs : undefined)

  const sftp = {
    stat(path, cb) {
      stats.sftp += 1
      const value = statsOf(path)
      if (value === undefined) cb(missing(path))
      else cb(undefined, value)
    },
    readFile(path, cb) {
      stats.sftp += 1
      if (options.denied?.(path)) {
        cb(new Error('Permission denied'))
        return
      }
      const bytes = files.get(path)
      if (bytes === undefined) cb(missing(path))
      else cb(undefined, Buffer.from(bytes))
    },
    writeFile(path, data, cb) {
      stats.sftp += 1
      if (!dirs.has(posix.dirname(path))) {
        cb(missing(path))
        return
      }
      put(path, Buffer.from(data))
      cb(undefined)
    },
    rename(from, to, cb) {
      stats.sftp += 1
      if (!files.has(from)) {
        cb(missing(from))
        return
      }
      if (!dirs.has(posix.dirname(to))) {
        cb(missing(to))
        return
      }
      if (files.has(to) && options.renameRefusesReplace) {
        cb(Object.assign(new Error('Failure'), { code: 4 }))
        return
      }
      files.set(to, files.get(from))
      mtimes.set(to, mtimes.get(from))
      files.delete(from)
      mtimes.delete(from)
      cb(undefined)
    },
    mkdir(path, cb) {
      stats.sftp += 1
      if (dirs.has(path) || files.has(path)) {
        cb(new Error('Failure'))
        return
      }
      if (!dirs.has(posix.dirname(path))) {
        cb(missing(path))
        return
      }
      dirs.add(path)
      cb(undefined)
    },
    unlink(path, cb) {
      stats.sftp += 1
      if (files.delete(path)) {
        mtimes.delete(path)
        cb(undefined)
      } else cb(missing(path))
    },
    readdir(path, cb) {
      stats.sftp += 1
      if (!dirs.has(path)) {
        cb(missing(path))
        return
      }
      const names = new Set()
      for (const dir of dirs) if (dir !== path && posix.dirname(dir) === path) names.add(dirEntry(dir))
      for (const file of files.keys()) if (posix.dirname(file) === path) names.add(fileEntry(file))
      cb(undefined, [...names].sort((a, b) => a.filename.localeCompare(b.filename)))
    },
  }

  const wrap = (text) => Buffer.from(text, 'utf8').toString('base64')

  function exec(command) {
    stats.exec += 1
    calls.push(command)

    const hash = HASH_RE.exec(command)
    if (hash) {
      if (options.noSha256sum) return { exitCode: 127, stdout: '', stderr: 'bash: sha256sum: command not found' }
      const lines = []
      for (const rel of quotedArgs(hash[2])) {
        const bytes = files.get(posix.join(hash[1], rel))
        if (bytes === undefined) continue
        lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${rel}`)
      }
      return { exitCode: 0, stdout: wrap(lines.join('\n') + (lines.length > 0 ? '\n' : '')), stderr: '' }
    }

    const listing = LISTING_RE.exec(command)
    if (listing) {
      if (options.noPrintf) return { exitCode: 1, stdout: '', stderr: "find: unrecognized: -printf" }
      const root = listing[1]
      const lines = []
      for (const [path, bytes] of [...files].sort()) {
        if (!path.startsWith(`${root}/`)) continue
        const rel = path.slice(root.length + 1)
        if (rel === '.git' || rel.startsWith('.git/') || rel.split('/').includes('node_modules')) continue
        lines.push(`${rel}\t${bytes.length}\t${mtimes.get(path) ?? `${clock}.0000000000`}`)
      }
      return { exitCode: 0, stdout: wrap(lines.length > 0 ? `${lines.join('\n')}\n` : ''), stderr: '' }
    }

    const fingerprint = FINGERPRINT_RE.exec(command)
    if (fingerprint) {
      if (options.noPrintf) return { exitCode: 1, stdout: '', stderr: "find: unrecognized: -printf" }
      const lines = []
      let stderr = ''
      for (const rel of quotedArgs(fingerprint[2])) {
        const path = posix.join(fingerprint[1], rel)
        if (!files.has(path)) {
          stderr += `find: '${rel}': No such file or directory\n`
          continue
        }
        lines.push(`${rel}\t${files.get(path).length}\t${mtimes.get(path) ?? `${clock}.0000000000`}`)
      }
      return { exitCode: 0, stdout: wrap(lines.length > 0 ? `${lines.join('\n')}\n` : ''), stderr }
    }

    const realpath = REALPATH_RE.exec(command)
    if (realpath) return { exitCode: 0, stdout: `${posix.normalize(realpath[1])}\n`, stderr: '' }

    const git = GIT_RE.exec(command)
    if (git) {
      const args = quotedArgs(git[2])
      if (options.git) {
        const answer = options.git(args, git[1])
        return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
      }
      return { exitCode: 127, stdout: '', stderr: `bash: line 1: git: command not found` }
    }

    return { exitCode: 127, stdout: '', stderr: `fake host: unsupported command: ${command}` }
  }

  const connection = {
    home,
    async exec(command) {
      return exec(command)
    },
    async getSftp() {
      return sftp
    },
  }

  return {
    home,
    hosts,
    files,
    dirs,
    mtimes,
    calls,
    stats,
    async getConnectionFor(alias) {
      stats.connections += 1
      if (options.offline) throw new Error('connect ECONNREFUSED 10.0.0.1:22')
      if (!hosts.some((entry) => entry.alias === alias)) throw new Error(`unknown host: ${alias}`)
      return connection
    },
    getHost(alias) {
      return hosts.find((entry) => entry.alias === alias)
    },
    listHosts(query) {
      return hosts.filter((entry) => query === undefined || entry.alias.includes(query))
    },
    /** What the agent on the server would see. */
    read(path) {
      return files.get(path)?.toString('utf8')
    },
    bytes(path) {
      return files.get(path)
    },
    /** The agent on the server writes a file. */
    write(path, content) {
      put(path, content)
    },
    /** Same content, new timestamp (an editor that saved without changes). */
    touch(path) {
      clock += 1
      mtimes.set(path, `${clock}.1234567890`)
    },
  }
}
