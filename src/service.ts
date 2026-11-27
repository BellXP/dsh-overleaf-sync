import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'

import type { Config } from './config.js'
import { OverleafSyncError, describeError } from './core/errors.js'
import {
  conflictsDir,
  describeLocation,
  linkPath,
  projectStateDir,
  resolveLocalRoot,
  resolveRemoteLocalRoot,
  resolveRemotePath,
  stateRoot,
  uniquePath,
  uniquePathAsync,
} from './core/paths.js'
import { atomicWrite, ensureDir, normalizeEol, sha256 } from './core/fsUtil.js'
import { sha256Bytes } from './core/files.js'
import { ensureGitRepository } from './core/gitInit.js'
import {
  archiveOverwrite,
  discoverConflicts,
  resolveConflict,
  writeBinaryConflict,
  writeTextConflict,
} from './core/conflicts.js'
import type { ConflictChoice, ConflictEntry } from './core/conflicts.js'
import { loadIgnoreMatcher } from './core/ignore.js'
import { appendJournal } from './core/journal.js'
import { diffToOps } from './core/otDiff.js'
import { StateStore, readProjectState } from './core/stateStore.js'
import { localTree, type TreeIo } from './core/tree.js'
import { SshTree, type SshRuntimeLike } from './core/tree-ssh.js'
import { clearCredential, loadCredential, saveCredential } from './transport/credentials.js'
import { OverleafHttp } from './transport/http.js'
import { createTransport } from './transport/index.js'
import { WatchSession } from './watch/session.js'
import type { WatchEvent } from './watch/session.js'
import type {
  Credential,
  FileState,
  GitInitResult,
  LinkRecord,
  OverleafTransport,
  ProjectListEntry,
  ProjectSnapshot,
  RemoteUpdate,
} from './types.js'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  debug?(message: string): void
}

export interface ServiceContext {
  /** session working directory, used to resolve relative paths */
  cwd: string
  signal?: AbortSignal
  logger?: Logger
}

export interface LoginInput {
  cookie: string
  csrfToken?: string
  baseUrl?: string
  userHint?: string
}

export interface LoginResult {
  ok: boolean
  baseUrl: string
  hint?: string
  text: string
}

export interface LinkInput {
  projectId: string
  localRoot?: string
  /**
   * SSH host alias (dsh-cloud-workspaces) whose folder `localRoot` names.
   * Omitted: the link keeps the location it has. `''`: move it back to this machine.
   */
  host?: string
  include?: string[]
  exclude?: string[]
  strategy?: LinkRecord['strategy']
}

export interface PullInput {
  projectId?: string
  docs?: string[]
  force?: boolean
  dryRun?: boolean
  gitInit?: boolean
}

/** `location` is how a message names the folder; `host` is set when it is not on this machine. */
interface LocationView {
  localRoot: string
  location: string
  host?: string
}

export interface PullSummary extends LocationView {
  projectId: string
  projectName: string
  dryRun: boolean
  pulled: string[]
  unchanged: string[]
  skipped: Array<{ path: string; reason: string }>
  conflicts: string[]
  git?: GitInitResult
  warnings: string[]
}

export interface PushInput {
  projectId?: string
  paths?: string[]
  dryRun?: boolean
}

export interface PushSummary extends LocationView {
  projectId: string
  projectName: string
  dryRun: boolean
  pushed: string[]
  unchanged: string[]
  skipped: Array<{ path: string; reason: string }>
  conflicts: string[]
  warnings: string[]
}

export interface DiffInput {
  projectId?: string
  path: string
  format?: 'summary' | 'unified'
}

export type DiffStatus =
  | 'in-sync'
  | 'local-changed'
  | 'remote-changed'
  | 'both-changed'
  | 'missing-local'
  | 'missing-remote'

export interface DiffSummary extends LocationView {
  projectId: string
  path: string
  status: DiffStatus
  remoteVersion?: number
  localHash?: string
  baselineHash?: string
  remoteHash?: string
  unified?: string
  text: string
}

export interface StatusSummary {
  baseUrl: string
  authenticated: boolean
  credentialHint?: string
  credentialSavedAt?: string
  projects: Array<{
    projectId: string
    projectName: string
    localRoot: string
    location: string
    host?: string
    files: number
    git?: string
    linkedAt: string
  }>
  text: string
}

export interface ConflictsSummary extends LocationView {
  projectId: string
  projectName: string
  conflicts: ConflictEntry[]
}

export interface ResolveInput {
  projectId?: string
  path?: string
  all?: boolean
  choice?: ConflictChoice
  dryRun?: boolean
}

export interface ResolveSummary extends LocationView {
  projectId: string
  projectName: string
  dryRun: boolean
  choice: ConflictChoice
  resolved: Array<{
    path: string
    choice: ConflictChoice
    kind: 'doc' | 'file'
    remoteVersion: number
    archivedTo?: string
  }>
}

export type WatchAction = 'start' | 'stop' | 'status'

export interface WatchInput {
  action: WatchAction
  projectId?: string
}

/** One running session as the status reports it. */
interface WatchSessionInfo extends LocationView {
  projectId: string
  projectName: string
  startedAt?: string
  lastEventAt?: string
  lastError?: string
}

interface WatchSessionView extends WatchSessionInfo {
  openDocs: number
}

export interface WatchStatus {
  /** true when at least one project is being watched right now */
  running: boolean
  projectId?: string
  projectName?: string
  localRoot?: string
  location?: string
  host?: string
  openDocs: number
  startedAt?: string
  lastEventAt?: string
  lastError?: string
  events: WatchEvent[]
  sessions: WatchSessionView[]
}

/** A document on the remote side, with its project-relative path. */
interface RemoteDoc {
  docId: string
  relPath: string
}

/** A binary file on the remote side, with its project-relative path. */
interface RemoteFile {
  fileId: string
  relPath: string
}

/** What a link may point at besides this machine. */
export interface HostOption {
  alias: string
  host?: string
  user?: string
  description?: string
}

export interface ServiceDeps {
  createTransport?: (
    credential: Credential,
    projectId: string,
    options: { signal?: AbortSignal },
  ) => Promise<OverleafTransport>
  /**
   * Tree IO for a link; returning `undefined` keeps the default (this machine's
   * disk, or the `ssh` service for a link with a host). Tests substitute an
   * in-memory "host" here.
   */
  treeFor?: (link: LinkRecord) => TreeIo | undefined
}

function locationOf(link: LinkRecord): LocationView {
  return {
    localRoot: link.localRoot,
    location: describeLocation(link.host, link.localRoot),
    ...(link.host !== undefined ? { host: link.host } : {}),
  }
}

export class OverleafSyncService {
  /** Long-lived watch sessions, keyed by project id (design §5.2). */
  private readonly watchSessions = new Map<
    string,
    { session: WatchSession; transport: OverleafTransport }
  >()
  /** Project ids with a pull/push in flight — a second call gets `E_BUSY`. */
  private readonly busy = new Set<string>()
  /** The dsh-cloud-workspaces `ssh` service, once it is loaded. */
  private ssh?: SshRuntimeLike

  constructor(
    readonly config: Config,
    readonly deps: ServiceDeps = {},
  ) {}

  /** The `ssh` service appeared: links with a host can be used now. */
  attachSsh(runtime: SshRuntimeLike): void {
    this.ssh = runtime
  }

  /** The `ssh` service went away (plugin disabled or reloaded). */
  detachSsh(runtime: SshRuntimeLike): void {
    if (this.ssh === runtime) this.ssh = undefined
  }

  /** Where the files of a link are reached from. */
  tree(link: Pick<LinkRecord, 'host'>): TreeIo {
    const injected = this.deps.treeFor?.(link as LinkRecord)
    if (injected !== undefined) return injected
    return link.host !== undefined ? this.remoteTree(link.host) : localTree
  }

  /** Hosts a link can point at; `undefined` when no `ssh` service is loaded. */
  listHosts(): HostOption[] | undefined {
    const ssh = this.ssh
    if (ssh === undefined) return undefined
    return ssh.listHosts().map((entry) => ({
      alias: entry.alias,
      ...(entry.host !== undefined ? { host: entry.host } : {}),
      ...(entry.user !== undefined ? { user: entry.user } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    }))
  }

  /** Serialize the two operations that touch both sides of the sync. */
  private async exclusive<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(projectId)) {
      throw new OverleafSyncError(
        'E_BUSY',
        `another pull/push is already running for project "${projectId}"`,
        'wait for it to finish, then retry',
      )
    }
    this.busy.add(projectId)
    try {
      return await run()
    } finally {
      this.busy.delete(projectId)
    }
  }

  /** A tree on an SSH host; fails with a next step when that is not possible. */
  private remoteTree(host: string): SshTree {
    const ssh = this.ssh
    if (ssh === undefined) {
      throw new OverleafSyncError(
        'E_HOST_UNAVAILABLE',
        `cannot use SSH host "${host}": no SSH service is loaded`,
        'SSH hosts come from the dsh-cloud-workspaces plugin — install it, configure a host under 设置 → SSH 连接, then restart dsh',
      )
    }
    if (ssh.getHost(host) === undefined) {
      throw new OverleafSyncError(
        'E_HOST_UNAVAILABLE',
        `SSH host "${host}" is not configured`,
        'list the configured hosts with ssh_list, or add one under 设置 → SSH 连接',
      )
    }
    return new SshTree(ssh, host, { pollMs: this.config.watch.pollMs })
  }

  // ---------------------------------------------------------------- credentials

  async credential(): Promise<Credential | undefined> {
    return loadCredential()
  }

  async requireCredential(): Promise<Credential> {
    const credential = await loadCredential()
    if (!credential) {
      throw new OverleafSyncError(
        'E_AUTH_REQUIRED',
        'no Overleaf session stored',
        'run overleaf_login with the Cookie and CSRF token copied from a logged-in browser tab',
      )
    }
    return credential
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? this.config.baseUrl)
    const cookie = input.cookie?.trim()
    if (!cookie) {
      throw new OverleafSyncError('E_AUTH_REQUIRED', 'cookie is empty', 'copy the full `Cookie` request header from a logged-in Overleaf tab')
    }
    const csrfToken = input.csrfToken?.trim() || (await this.fetchCsrfToken(baseUrl, cookie))
    const saved = await saveCredential({
      baseUrl,
      cookie,
      csrfToken,
      ...(input.userHint ? { userHint: input.userHint } : {}),
    })
    const check = await new OverleafHttp(saved).whoami()
    if (!check.ok) {
      throw new OverleafSyncError(
        'E_AUTH_EXPIRED',
        'the pasted session was rejected by Overleaf',
        'make sure you copied the cookie from an account that can open the project, then retry overleaf_login',
      )
    }
    const hint = check.hint ?? saved.userHint
    return {
      ok: true,
      baseUrl,
      ...(hint ? { hint } : {}),
      text: `Logged in to ${baseUrl}${hint ? ` as ${hint}` : ''}. Session saved to ${stateRoot()}\\credentials.json (no password stored).`,
    }
  }

  async logout(): Promise<string> {
    await clearCredential()
    return 'Overleaf session cleared.'
  }

  private async fetchCsrfToken(baseUrl: string, cookie: string): Promise<string> {
    const res = await fetch(baseUrl, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.text()
    const meta = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/i)
    if (meta?.[1]) return meta[1]
    const form = body.match(/<input[^>]*name="_csrf"[^>]*value="([^"]*)"/i)
    if (form?.[1]) return form[1]
    throw new OverleafSyncError(
      'E_CONFIG',
      'could not find a CSRF token on the Overleaf page',
      'pass csrfToken explicitly (DevTools → Network → any request → X-Csrf-Token), or copy it from the page <meta name="ol-csrfToken">',
    )
  }

  // ------------------------------------------------------------------- projects

  async listProjects(ctx: ServiceContext): Promise<ProjectListEntry[]> {
    const credential = await this.requireCredential()
    const http = new OverleafHttp(credential)
    return http.listProjects(ctx.signal)
  }

  async link(input: LinkInput, ctx: ServiceContext): Promise<LinkRecord> {
    const projectId = input.projectId?.trim()
    if (!projectId) throw new OverleafSyncError('E_PROJECT_NOT_FOUND', 'projectId is required', 'run overleaf_projects to list ids')

    const projects = await this.listProjects(ctx)
    const project = projects.find((entry) => entry.id === projectId)
    if (!project) {
      throw new OverleafSyncError(
        'E_PROJECT_NOT_FOUND',
        `project ${projectId} is not visible to this account`,
        'run overleaf_projects to refresh the list',
      )
    }

    const existing = await this.readLink(projectId).catch(() => undefined)
    // An omitted `host` keeps the folder where it is; `''` moves it back to this machine.
    const host = input.host !== undefined ? input.host.trim() : (existing?.host ?? '')
    const localRoot = await this.resolveRoot({ input, existing, project: project.name, host, cwd: ctx.cwd })
    // The git record describes one folder; it means nothing for a different one.
    const sameFolder = existing !== undefined && existing.localRoot === localRoot && (existing.host ?? '') === host

    const now = new Date().toISOString()
    const record: LinkRecord = {
      schemaVersion: 1,
      projectId,
      projectName: project.name,
      localRoot,
      ...(host !== '' ? { host } : {}),
      include: input.include ?? existing?.include ?? ['**/*.tex', '**/*.bib', '**/*.cls', '**/*.sty', '**/*.md', '**/*.txt'],
      exclude: input.exclude ?? existing?.exclude ?? ['.git/**', 'node_modules/**'],
      strategy: input.strategy ?? existing?.strategy ?? this.config.defaultStrategy,
      autoPush: existing?.autoPush ?? true,
      throttleMs: existing?.throttleMs ?? 500,
      binary: existing?.binary ?? 'download-only',
      ...(sameFolder && existing.git ? { git: existing.git } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await ensureDir(projectStateDir(projectId))
    await writeJson(linkPath(projectId), record)
    return record
  }

  /** The folder a link names: an explicit one, the one it already had, or the configured pattern. */
  private async resolveRoot(options: {
    input: LinkInput
    existing?: LinkRecord
    project: string
    host: string
    cwd: string
  }): Promise<string> {
    const { input, existing, host } = options
    if (host !== '') {
      const tree = this.remoteTree(host)
      // Connecting here is deliberate: a link to a host nobody can reach
      // should fail now, with the reason, rather than at the first pull.
      const home = await tree.home()
      let localRoot: string
      if (input.localRoot) localRoot = resolveRemotePath(input.localRoot, home)
      else if (existing?.host === host) localRoot = resolveRemotePath(existing.localRoot, home)
      else {
        const candidate = resolveRemoteLocalRoot(this.config.localRootPattern, { project: options.project, home })
        localRoot = await uniquePathAsync(candidate, (dir) => tree.exists(dir))
      }
      const stats = await tree.stat(localRoot)
      if (stats !== undefined && !stats.isDirectory) {
        throw new OverleafSyncError(
          'E_CONFIG',
          `"${localRoot}" on ${host} is a file, not a folder`,
          'pass localRoot with the folder that should hold the project',
        )
      }
      return localRoot
    }

    if (input.localRoot) return path.resolve(options.cwd, input.localRoot)
    if (existing !== undefined && existing.host === undefined) return existing.localRoot
    const candidate = resolveLocalRoot(this.config.localRootPattern, { project: options.project, cwd: options.cwd })
    return uniquePath(candidate, (dir) => existsSync(dir))
  }

  /**
   * Folder check for a link on an SSH host — the sibling of the GUI's
   * `validate-path`, which can only look at this machine.
   */
  async validateRemotePath(
    host: string,
    raw: string,
    projectId?: string,
  ): Promise<{ resolved: string; problems: string[] }> {
    const tree = this.remoteTree(host)
    const resolved = resolveRemotePath(raw, await tree.home())
    const problems: string[] = []
    const stats = await tree.stat(resolved)
    if (stats !== undefined && !stats.isDirectory) problems.push('该路径是一个文件，不是目录')
    if (projectId !== undefined && problems.length === 0) {
      const existing = await readProjectState(projectId)
      if (
        existing !== undefined &&
        existing.localRoot !== '' &&
        (existing.localRoot !== resolved || existing.host !== host)
      ) {
        problems.push(`该项目已绑定到 ${describeLocation(existing.host, existing.localRoot)}`)
      }
    }
    return { resolved, problems }
  }

  /** Read one link record; without an id, resolve the only linked project. */
  async readLink(projectId?: string): Promise<LinkRecord> {
    if (projectId) {
      const file = linkPath(projectId)
      if (!existsSync(file)) {
        throw new OverleafSyncError(
          'E_NOT_LINKED',
          `project ${projectId} is not linked to a folder yet`,
          'run overleaf_link first (projectId, optional host and localRoot)',
        )
      }
      return JSON.parse(await fs.readFile(file, 'utf8')) as LinkRecord
    }
    const dir = path.join(stateRoot(), 'projects')
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    const records: LinkRecord[] = []
    for (const entry of entries) {
      const file = path.join(dir, entry, 'link.json')
      if (!existsSync(file)) continue
      try {
        records.push(JSON.parse(await fs.readFile(file, 'utf8')) as LinkRecord)
      } catch {
        // ignore corrupt link files; they surface through overleaf_status
      }
    }
    if (records.length === 0) {
      throw new OverleafSyncError('E_NOT_LINKED', 'no project is linked yet', 'run overleaf_projects, then overleaf_link')
    }
    if (records.length > 1) {
      throw new OverleafSyncError(
        'E_NOT_LINKED',
        `several projects are linked (${records.map((r) => r.projectName).join(', ')})`,
        'pass projectId explicitly',
      )
    }
    return records[0]!
  }

  // ----------------------------------------------------------------------- pull

  async pull(input: PullInput, ctx: ServiceContext): Promise<PullSummary> {
    const projectId = input.projectId ?? (await this.readLink()).projectId
    return this.exclusive(projectId, () => this.pullUnlocked(input, ctx))
  }

  private async pullUnlocked(input: PullInput, ctx: ServiceContext): Promise<PullSummary> {
    const link = await this.readLink(input.projectId)
    const tree = this.tree(link)
    const credential = await this.requireCredential()
    const warnings: string[] = []
    const summary: PullSummary = {
      projectId: link.projectId,
      projectName: link.projectName,
      ...locationOf(link),
      dryRun: input.dryRun === true,
      pulled: [],
      unchanged: [],
      skipped: [],
      conflicts: [],
      warnings,
    }

    const openTransport = this.deps.createTransport ?? createTransport
    const transport = await openTransport(credential, link.projectId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    try {
      const snapshot = await transport.joinProject()
      const ignore = await loadIgnoreMatcher(link.localRoot, link.exclude, tree)
      const wanted = new Set(input.docs?.map((doc) => doc.replaceAll('\\', '/')) ?? [])

      const store = await StateStore.load(link.projectId, link.localRoot, link.host)
      if (!input.dryRun) await tree.ensureDir(link.localRoot)

      for (const doc of this.collectDocs(snapshot)) {
        const relPath = doc.relPath
        if (wanted.size > 0 && !wanted.has(relPath) && !wanted.has(doc.docId)) continue
        if (ignore(relPath)) {
          summary.skipped.push({ path: relPath, reason: 'ignored' })
          continue
        }
        const target = tree.join(link.localRoot, ...relPath.split('/'))
        const previous = store.get(relPath)
        const content = await transport.joinDoc(doc.docId)
        const remoteHash = sha256(normalizeEol(content.text))
        const localText = await tree.readText(target)
        const localHash = localText === undefined ? undefined : sha256(normalizeEol(localText))

        if (previous && localHash === previous.localHash && previous.remoteHash === remoteHash) {
          summary.unchanged.push(relPath)
          continue
        }

        // Never synced from this folder, and both sides already agree: only the baseline is missing.
        if (previous === undefined && localHash === remoteHash) {
          if (!input.dryRun) store.set(relPath, baselineOf(doc.docId, content.version, remoteHash, remoteHash))
          summary.unchanged.push(relPath)
          continue
        }

        // A local edit that was never pushed is never overwritten. That holds
        // for a file this link has not compared with Overleaf yet, too: its text
        // may be the newer one, so it is the user's call, not the pull's.
        const localEdited = previous !== undefined && localHash !== undefined && localHash !== previous.localHash
        const uncompared = previous === undefined && localText !== undefined
        if ((localEdited || uncompared) && !input.force) {
          const reason = previous === undefined ? 'no-baseline' : previous.remoteHash !== remoteHash ? 'both-changed' : 'local-changed'
          summary.conflicts.push(relPath)
          if (input.dryRun) {
            summary.skipped.push({ path: relPath, reason: `${reason} (kept; a real pull saves the Overleaf copy)` })
            continue
          }
          const conflictFile = await writeTextConflict({
            link,
            relPath,
            localText: localText ?? '',
            remoteText: content.text,
            tree,
            meta: { reason, localVersion: previous?.remoteVersion, remoteVersion: content.version, docId: doc.docId },
          })
          summary.skipped.push({ path: relPath, reason: `${reason} (kept; Overleaf copy: ${conflictFile})` })
          continue
        }

        if (input.dryRun) {
          summary.pulled.push(relPath)
          continue
        }

        // Only `force` gets here with a local file that was edited or never compared: keep what it replaces.
        if (localText !== undefined && localHash !== remoteHash && (localEdited || uncompared)) {
          const archive = await archiveOverwrite({
            link,
            relPath,
            localText,
            remoteText: content.text,
            meta: { remoteVersion: content.version, docId: doc.docId },
          })
          warnings.push(`${relPath}: a local file that differed from Overleaf was overwritten (kept in ${archive})`)
        }
        await tree.writeText(target, content.text)
        store.set(relPath, {
          ...baselineOf(doc.docId, content.version, remoteHash, remoteHash),
          origin: 'remote',
        })
        summary.pulled.push(relPath)
        await this.journal(link.projectId, { event: 'pull', path: relPath, v: content.version, ok: true })
      }

      // Binary files (images, PDFs, …) travel over plain HTTP instead of
      // document OT, so they are fetched after the documents (§5.4).
      if (!input.dryRun && snapshot.files.length > 0) {
        const http = new OverleafHttp(credential)
        for (const file of this.collectFiles(snapshot)) {
          const relPath = file.relPath
          if (wanted.size > 0 && !wanted.has(relPath) && !wanted.has(file.fileId)) continue
          if (ignore(relPath)) {
            summary.skipped.push({ path: relPath, reason: 'ignored' })
            continue
          }
          const target = tree.join(link.localRoot, ...relPath.split('/'))
          const previous = store.get(relPath)
          let bytes: Uint8Array
          try {
            bytes = await http.downloadFile(link.projectId, file.fileId, ctx.signal)
          } catch (error) {
            warnings.push(`${relPath}: ${describeError(error)}`)
            continue
          }
          const remoteHash = sha256Bytes(bytes)
          const localBytes = await tree.readBytes(target)
          const localHash = localBytes === undefined ? undefined : sha256Bytes(localBytes)
          if (previous && localHash === previous.localHash && previous.remoteHash === remoteHash) {
            summary.unchanged.push(relPath)
            continue
          }
          if (previous === undefined && localHash === remoteHash) {
            store.set(relPath, baselineOf(file.fileId, 0, remoteHash, remoteHash, 'file'))
            summary.unchanged.push(relPath)
            continue
          }
          const localEdited = previous !== undefined && localHash !== undefined && localHash !== previous.localHash
          const uncompared = previous === undefined && localBytes !== undefined
          if ((localEdited || uncompared) && !input.force) {
            const reason = previous === undefined ? 'no-baseline' : 'local-changed'
            const conflictFile = await writeBinaryConflict({
              link,
              relPath,
              localBytes: localBytes ?? new Uint8Array(0),
              remoteBytes: bytes,
              tree,
              meta: { reason, remoteVersion: 0, docId: file.fileId },
            })
            summary.conflicts.push(relPath)
            summary.skipped.push({ path: relPath, reason: `${reason} (kept; Overleaf copy: ${conflictFile})` })
            continue
          }
          if (localBytes !== undefined && localHash !== remoteHash && (localEdited || uncompared)) {
            const archive = await archiveOverwrite({
              link,
              relPath,
              localBytes,
              remoteBytes: bytes,
              meta: { docId: file.fileId },
            })
            warnings.push(`${relPath}: a local file that differed from Overleaf was overwritten (kept in ${archive})`)
          }
          await tree.writeBytes(target, bytes)
          store.set(relPath, {
            ...baselineOf(file.fileId, 0, remoteHash, remoteHash, 'file'),
            origin: 'remote',
          })
          summary.pulled.push(relPath)
          await this.journal(link.projectId, { event: 'pull', path: relPath, v: 0, ok: true })
        }
      }

      if (!input.dryRun) {
        await store.save()
        const gitEnabled = input.gitInit ?? this.config.git.autoInit
        const git = await ensureGitRepository({
          enabled: gitEnabled,
          localRoot: link.localRoot,
          projectName: link.projectName,
          projectId: link.projectId,
          initialCommitMessage: this.config.git.initialCommitMessage,
          includeBinary: this.config.git.includeBinaryInFirstCommit,
          tree,
        })
        summary.git = git
        if (git.warning) warnings.push(git.warning)
        if (git.created || git.mode !== 'none') {
          await this.updateGitRecord(link, git)
        }
      }
      return summary
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  // --------------------------------------------------------------------- status

  /**
   * Local → remote. Only documents the baseline knows about are pushed; a document
   * whose remote text moved since the baseline is never overwritten silently.
   */
  async push(input: PushInput, ctx: ServiceContext): Promise<PushSummary> {
    const projectId = input.projectId ?? (await this.readLink()).projectId
    return this.exclusive(projectId, () => this.pushUnlocked(input, ctx))
  }

  private async pushUnlocked(input: PushInput, ctx: ServiceContext): Promise<PushSummary> {
    const link = await this.readLink(input.projectId)
    const tree = this.tree(link)
    const credential = await this.requireCredential()
    const warnings: string[] = []
    const summary: PushSummary = {
      projectId: link.projectId,
      projectName: link.projectName,
      ...locationOf(link),
      dryRun: input.dryRun === true,
      pushed: [],
      unchanged: [],
      skipped: [],
      conflicts: [],
      warnings,
    }

    const openTransport = this.deps.createTransport ?? createTransport
    const transport = await openTransport(credential, link.projectId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    try {
      const snapshot = await transport.joinProject()
      const ignore = await loadIgnoreMatcher(link.localRoot, link.exclude, tree)
      const wanted = new Set(input.paths?.map((item) => item.replaceAll('\\', '/')) ?? [])
      const store = await StateStore.load(link.projectId, link.localRoot, link.host)

      for (const doc of this.collectDocs(snapshot)) {
        const relPath = doc.relPath
        if (wanted.size > 0 && !wanted.has(relPath) && !wanted.has(doc.docId) && !wanted.has(path.posix.basename(relPath))) {
          continue
        }
        if (ignore(relPath)) {
          summary.skipped.push({ path: relPath, reason: 'ignored' })
          continue
        }
        const target = tree.join(link.localRoot, ...relPath.split('/'))
        const localText = await tree.readText(target)
        if (localText === undefined) {
          summary.skipped.push({ path: relPath, reason: 'missing locally' })
          continue
        }
        const localHash = sha256(normalizeEol(localText))
        const previous = store.get(relPath)
        if (previous && previous.localHash === localHash) {
          summary.unchanged.push(relPath)
          continue
        }

        const remote = await transport.joinDoc(doc.docId)
        const remoteHash = sha256(normalizeEol(remote.text))
        if (previous === undefined && remoteHash === localHash) {
          // Same text on both sides; only the baseline is missing.
          if (!input.dryRun) store.set(relPath, baselineOf(doc.docId, remote.version, localHash, localHash))
          summary.unchanged.push(relPath)
          continue
        }

        const remoteMoved = previous !== undefined && previous.remoteHash !== remoteHash
        if (remoteMoved) {
          summary.conflicts.push(relPath)
          let conflictFile = 'not written (dry run)'
          if (!input.dryRun) {
            conflictFile = await writeTextConflict({
              link,
              relPath,
              localText,
              remoteText: remote.text,
              tree,
              meta: { reason: 'remote-changed', localVersion: previous?.remoteVersion, remoteVersion: remote.version, docId: doc.docId },
            })
          }
          summary.skipped.push({ path: relPath, reason: `remote-changed (kept; Overleaf copy: ${conflictFile})` })
          continue
        }

        const ops = diffToOps(remote.text, localText)
        if (input.dryRun) {
          summary.pushed.push(relPath)
          continue
        }
        const applied = await transport.applyOtUpdate(doc.docId, remote.version, ops)
        store.set(relPath, {
          ...baselineOf(doc.docId, applied.version, localHash, localHash),
          origin: 'local',
        })
        summary.pushed.push(relPath)
        await this.journal(link.projectId, { event: 'push', path: relPath, v: applied.version, ok: true })
      }

      if (!input.dryRun) await store.save()
      return summary
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  /** Three-way comparison of one document: local file vs baseline vs current Overleaf text. */
  async diff(input: DiffInput, ctx: ServiceContext): Promise<DiffSummary> {
    const link = await this.readLink(input.projectId)
    const tree = this.tree(link)
    const credential = await this.requireCredential()
    const wanted = input.path.replaceAll('\\', '/')
    const openTransport = this.deps.createTransport ?? createTransport
    const transport = await openTransport(credential, link.projectId, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })
    try {
      const snapshot = await transport.joinProject()
      const remoteDocs = this.collectDocs(snapshot)
      const doc =
        remoteDocs.find((item) => item.relPath === wanted) ??
        remoteDocs.find((item) => item.docId === wanted) ??
        remoteDocs.find((item) => path.posix.basename(item.relPath) === wanted)
      if (!doc) {
        throw new OverleafSyncError(
          'E_NOT_LINKED',
          `No document "${input.path}" in project "${link.projectName}".`,
          'Run overleaf_pull first to see the remote tree, or pass the exact project-relative path.',
        )
      }
      const remote = await transport.joinDoc(doc.docId)
      const localText = await tree.readText(tree.join(link.localRoot, ...doc.relPath.split('/')))
      const store = await StateStore.load(link.projectId, link.localRoot, link.host)
      const previous = store.get(doc.relPath)

      const remoteHash = sha256(normalizeEol(remote.text))
      const localHash = localText === undefined ? undefined : sha256(normalizeEol(localText))
      const baselineHash = previous?.localHash

      let status: DiffStatus
      if (localText === undefined) status = 'missing-local'
      else if (!previous) status = localHash === remoteHash ? 'in-sync' : 'both-changed'
      else if (localHash === baselineHash && remoteHash === previous.remoteHash) status = 'in-sync'
      else if (localHash === baselineHash) status = 'remote-changed'
      else if (remoteHash === previous.remoteHash) status = 'local-changed'
      else status = 'both-changed'

      const summary: DiffSummary = {
        projectId: link.projectId,
        ...locationOf(link),
        path: doc.relPath,
        status,
        remoteVersion: remote.version,
        ...(localHash ? { localHash } : {}),
        ...(baselineHash ? { baselineHash } : {}),
        remoteHash,
        text: '',
      }
      if (input.format === 'unified' && localText !== undefined) {
        summary.unified = unifiedDiff(previous ? 'baseline' : 'remote', 'local', remote.text, localText)
      }
      summary.text = describeDiff(summary)
      return summary
    } finally {
      await transport.close().catch(() => undefined)
    }
  }

  async status(_ctx: ServiceContext): Promise<StatusSummary> {
    const credential = await this.credential()
    const projects: StatusSummary['projects'] = []
    const dir = path.join(stateRoot(), 'projects')
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const file = path.join(dir, entry, 'link.json')
      if (!existsSync(file)) continue
      try {
        const link = JSON.parse(await fs.readFile(file, 'utf8')) as LinkRecord
        const state = await StateStore.load(link.projectId, link.localRoot, link.host)
        projects.push({
          projectId: link.projectId,
          projectName: link.projectName,
          ...locationOf(link),
          files: Object.keys(state.state.files).length,
          ...(link.git ? { git: describeGit(link.git) } : {}),
          linkedAt: link.createdAt,
        })
      } catch {
        // skip unreadable records
      }
    }
    const authenticated = Boolean(credential)
    // The credential knows which server it was issued for; config.baseUrl is
    // only the default for a *new* login.
    const activeBaseUrl = credential?.baseUrl ?? this.config.baseUrl
    const lines: string[] = []
    lines.push(`Overleaf: ${authenticated ? 'authenticated' : 'not logged in'} (${activeBaseUrl})`)
    if (credential?.userHint) lines.push(`account hint: ${credential.userHint}`)
    const watch = this.watchStatus()
    if (watch.running) {
      const detail = watch.sessions
        .map((session) => `${session.projectName} (open docs ${session.openDocs})`)
        .join(', ')
      lines.push(`watcher: on — ${detail}`)
    } else {
      lines.push(`watcher: off (watch.autoStart=${this.config.watch.autoStart})`)
    }
    if (projects.length === 0) {
      lines.push('linked projects: none')
    } else {
      lines.push('linked projects:')
      for (const project of projects) {
        lines.push(`- ${project.projectName} (${project.projectId}) → ${project.location} · ${project.files} files${project.git ? ` · git ${project.git}` : ''}`)
      }
    }
    return {
      baseUrl: activeBaseUrl,
      authenticated,
      ...(credential?.userHint ? { credentialHint: credential.userHint } : {}),
      ...(credential?.savedAt ? { credentialSavedAt: credential.savedAt } : {}),
      projects,
      text: lines.join('\n'),
    }
  }

  // -------------------------------------------------------------------- helpers

  /** Flatten the remote tree into project-relative document paths. */
  collectDocs(snapshot: ProjectSnapshot): RemoteDoc[] {
    const resolveFolder = folderResolver(snapshot)
    const docs: RemoteDoc[] = []
    for (const doc of snapshot.docs) {
      const folder = resolveFolder(doc.parentFolderId)
      const relPath = sanitizeRelative(folder ? `${folder}/${doc.name}` : doc.name)
      if (!relPath) continue
      docs.push({ docId: doc.id, relPath })
    }
    return docs
  }

  /** Flatten the remote tree into project-relative binary file paths. */
  collectFiles(snapshot: ProjectSnapshot): RemoteFile[] {
    const resolveFolder = folderResolver(snapshot)
    const files: RemoteFile[] = []
    for (const file of snapshot.files) {
      const folder = resolveFolder(file.parentFolderId)
      const relPath = sanitizeRelative(folder ? `${folder}/${file.name}` : file.name)
      if (!relPath) continue
      files.push({ fileId: file.id, relPath })
    }
    return files
  }

  /** List unresolved conflicts of the linked project (design §10). */
  async conflicts(input: { projectId?: string } = {}, _ctx?: ServiceContext): Promise<ConflictsSummary> {
    const link = await this.readLink(input.projectId)
    const conflicts = await discoverConflicts(link.projectId)
    return {
      projectId: link.projectId,
      projectName: link.projectName,
      ...locationOf(link),
      conflicts,
    }
  }

  /**
   * Settle one conflict, or all of them.
   *
   * Local files are rewritten; Overleaf is not touched — choosing `keep_local`
   * only means "the next push should send this", which still goes through the
   * normal three-way check. Both sides stay recoverable: the artifact directory
   * is archived under `conflicts/resolved/<stamp>/`.
   */
  async resolve(input: ResolveInput, _ctx?: ServiceContext): Promise<ResolveSummary> {
    const link = await this.readLink(input.projectId)
    const tree = this.tree(link)
    const dryRun = input.dryRun === true
    const choice = input.choice ?? 'keep_local'
    const entries = await discoverConflicts(link.projectId)
    const wanted = (input.path ?? '').replaceAll('\\', '/')

    let targets = entries
    if (input.all !== true) {
      if (!wanted) {
        throw new OverleafSyncError(
          'E_CONFLICT',
          'No conflict selected',
          'pass `path` (or `all: true` to settle every open conflict) — run overleaf_conflicts to list them',
        )
      }
      const matched = entries.filter(
        (entry) => entry.path === wanted || path.posix.basename(entry.path) === wanted,
      )
      if (matched.length === 0) {
        throw new OverleafSyncError(
          'E_CONFLICT',
          `No unresolved conflict for "${wanted}"`,
          entries.length === 0
            ? 'there are no conflicts right now — run overleaf_status or overleaf_pull'
            : `open conflicts: ${entries.map((entry) => entry.path).slice(0, 5).join(', ')}`,
        )
      }
      targets = matched
    }

    const store = await StateStore.load(link.projectId, link.localRoot, link.host)
    const resolved: ResolveSummary['resolved'] = []
    let transport: OverleafTransport | undefined
    try {
      for (const entry of targets) {
        const previous = store.get(entry.path)
        const result = await resolveConflict({ link, entry, choice, dryRun, tree })
        let remoteVersion = result.remoteVersion
        let remoteHash = result.remoteHash
        // A conflict raised before any baseline existed names its document itself.
        const docId = previous?.docId ?? entry.docId

        // `keep_local` means "the local text is the truth" — send it now, or the
        // next pull would call the very same divergence a conflict again.
        if (!dryRun && choice === 'keep_local' && entry.kind === 'doc' && docId !== undefined) {
          transport ??= await (this.deps.createTransport ?? createTransport)(
            await this.requireCredential(),
            link.projectId,
            {},
          )
          const remote = await transport.joinDoc(docId)
          const localText = (await tree.readText(tree.join(link.localRoot, ...entry.path.split('/')))) ?? ''
          const ops = diffToOps(remote.text, localText)
          const applied = ops.length > 0 ? await transport.applyOtUpdate(docId, remote.version, ops) : remote
          remoteVersion = applied.version
          remoteHash = sha256(normalizeEol(localText))
        }

        if (!dryRun) {
          store.set(entry.path, {
            docId: docId ?? entry.path,
            remoteVersion,
            remoteHash,
            localHash: result.localHash,
            syncedAt: new Date().toISOString(),
            origin: 'both',
            kind: entry.kind,
          })
          await this.journal(link.projectId, { event: 'resolve', path: entry.path, ok: true, choice })
        }
        resolved.push({
          path: entry.path,
          choice,
          kind: entry.kind,
          remoteVersion,
          ...(result.archivedTo !== undefined ? { archivedTo: result.archivedTo } : {}),
        })
      }
      if (!dryRun) await store.save()
    } finally {
      await transport?.close().catch(() => undefined)
    }

    return {
      projectId: link.projectId,
      projectName: link.projectName,
      ...locationOf(link),
      dryRun,
      choice,
      resolved,
    }
  }

  // ------------------------------------------------------------------- watch

  /**
   * `overleaf_watch`: start / stop / inspect the background two-way sync.
   *
   * A session owns its socket for its whole lifetime (unlike pull/push, which
   * connect per call), so starting twice returns the running session instead of
   * opening a second one — Overleaf's 0.9 relays allow only one live session per
   * user and project.
   */
  async watch(input: WatchInput, ctx: ServiceContext): Promise<WatchStatus> {
    if (input.action === 'start') {
      const link = await this.readLink(input.projectId)
      if (!this.watchSessions.has(link.projectId)) {
        // Resolving the tree first turns "host not configured" into a clear
        // error before any socket to Overleaf is opened.
        const tree = this.tree(link)
        const credential = await this.requireCredential()
        const openTransport = this.deps.createTransport ?? createTransport
        const transport = await openTransport(credential, link.projectId, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
        try {
          const snapshot = await transport.joinProject()
          const docs = this.collectDocs(snapshot).map((doc) => ({
            docId: doc.docId,
            relPath: doc.relPath,
          }))
          const session = new WatchSession({
            link,
            transport,
            config: this.config,
            docs,
            tree,
            ...(ctx.logger ? { logger: ctx.logger } : {}),
          })
          await session.start()
          this.watchSessions.set(link.projectId, { session, transport })
        } catch (error) {
          await transport.close().catch(() => undefined)
          throw error
        }
      }
      return this.watchStatus({ projectId: link.projectId })
    }

    if (input.action === 'stop') {
      const link = await this.readLink(input.projectId)
      const running = this.watchSessions.get(link.projectId)
      if (running) {
        this.watchSessions.delete(link.projectId)
        await running.session.stop()
        await running.transport.close().catch(() => undefined)
      }
      return this.watchStatus({ projectId: link.projectId })
    }

    return this.watchStatus(input)
  }

  /** Snapshot of every running session (used by `overleaf_watch` and `overleaf_status`). */
  watchStatus(input: { projectId?: string } = {}): WatchStatus {
    const sessions: WatchSessionView[] = []
    for (const [projectId, { session }] of this.watchSessions) {
      const link = session.linkInfo
      const stats = session.stats
      sessions.push({
        projectId,
        projectName: link.projectName,
        ...locationOf(link),
        openDocs: session.openDocCount,
        ...(stats.startedAt ? { startedAt: stats.startedAt } : {}),
        ...(stats.lastEventAt ? { lastEventAt: stats.lastEventAt } : {}),
        ...(stats.lastError ? { lastError: stats.lastError } : {}),
      })
    }

    const describe = (projectId: string): Partial<WatchSessionInfo> & { events: WatchEvent[] } => {
      const session = this.watchSessions.get(projectId)?.session
      const entry = sessions.find((item) => item.projectId === projectId)
      return {
        ...(entry
          ? {
              projectName: entry.projectName,
              localRoot: entry.localRoot,
              location: entry.location,
              ...(entry.host !== undefined ? { host: entry.host } : {}),
              startedAt: entry.startedAt,
              lastEventAt: entry.lastEventAt,
              lastError: entry.lastError,
            }
          : {}),
        events: session?.recentEvents ?? [],
      }
    }

    if (input.projectId !== undefined) {
      const running = this.watchSessions.get(input.projectId)
      return {
        running: running !== undefined,
        projectId: input.projectId,
        ...describe(input.projectId),
        openDocs: running?.session.openDocCount ?? 0,
        sessions,
      }
    }

    const first = sessions[0]
    return {
      running: sessions.length > 0,
      ...(first
        ? {
            projectId: first.projectId,
            projectName: first.projectName,
            localRoot: first.localRoot,
            location: first.location,
            ...(first.host !== undefined ? { host: first.host } : {}),
            startedAt: first.startedAt,
            lastEventAt: first.lastEventAt,
            lastError: first.lastError,
          }
        : {}),
      openDocs: sessions.reduce((total, item) => total + item.openDocs, 0),
      events: first ? (this.watchSessions.get(first.projectId)?.session.recentEvents ?? []) : [],
      sessions,
    }
  }

  /** Stop every session — called on plugin unload so no socket outlives it. */
  async stopAllWatches(): Promise<void> {
    const all = [...this.watchSessions.values()]
    this.watchSessions.clear()
    for (const { session, transport } of all) {
      await session.stop('plugin unloaded').catch(() => undefined)
      await transport.close().catch(() => undefined)
    }
  }

  private async updateGitRecord(link: LinkRecord, git: GitInitResult): Promise<void> {
    const next: LinkRecord = { ...link, git, updatedAt: new Date().toISOString() }
    await writeJson(linkPath(link.projectId), next)
  }

  private async journal(projectId: string, entry: Parameters<typeof appendJournal>[1]): Promise<void> {
    try {
      await appendJournal(projectId, entry, {
        enabled: this.config.journal.enabled,
        keepDays: this.config.journal.keepDays,
      })
    } catch {
      // journaling must never break a sync
    }
  }
}

/** Folder ids → project-relative folder paths, memoized per snapshot. */
function folderResolver(snapshot: ProjectSnapshot): (folderId: string | null) => string {
  const folders = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  const memo = new Map<string, string>()
  const resolveFolder = (folderId: string | null, depth = 0): string => {
    if (!folderId) return ''
    if (depth > 64) return ''
    const cached = memo.get(folderId)
    if (cached !== undefined) return cached
    const folder = folders.get(folderId)
    if (!folder) return ''
    const parent = resolveFolder(folder.parentFolderId, depth + 1)
    const full = parent ? `${parent}/${folder.name}` : folder.name
    memo.set(folderId, full)
    return full
  }
  return resolveFolder
}

/** One file's baseline right after a sync: both sides hold the same content. */
function baselineOf(
  docId: string,
  remoteVersion: number,
  remoteHash: string,
  localHash: string,
  kind: 'doc' | 'file' = 'doc',
): FileState {
  return {
    docId,
    remoteVersion,
    remoteHash,
    localHash,
    syncedAt: new Date().toISOString(),
    origin: 'both',
    kind,
  }
}

/** Human wording for {@link DiffSummary.status}. */
export function describeDiff(summary: DiffSummary): string {
  const head = `${summary.path} (v${summary.remoteVersion ?? '?'}): ${summary.status}`
  const lines = [head]
  switch (summary.status) {
    case 'in-sync':
      lines.push('local file, baseline and remote all agree — safe to skip.')
      break
    case 'local-changed':
      lines.push('only the local file moved — `overleaf_push` would send it.')
      break
    case 'remote-changed':
      lines.push('only Overleaf moved — `overleaf_pull` would update the local file.')
      break
    case 'both-changed':
      lines.push(summary.baselineHash === undefined
        ? 'local file and Overleaf differ and nothing was ever synced between them — `overleaf_pull` keeps the local file and records a conflict; settle it with `overleaf_resolve`.'
        : 'both sides moved since the last sync — a pull or push will produce a conflict copy.')
      break
    case 'missing-local':
      lines.push('the document exists remotely but not locally — `overleaf_pull` recreates it.')
      break
    case 'missing-remote':
      lines.push('the document is gone from Overleaf.')
      break
  }
  if (summary.unified) lines.push('', summary.unified)
  return lines.join('\n')
}

/** Line-level unified diff with a small context window; good enough for `.tex` review. */
export function unifiedDiff(fromLabel: string, toLabel: string, fromText: string, toText: string): string {
  const from = fromText.split('\n')
  const to = toText.split('\n')
  let prefix = 0
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const context = 2
  const start = Math.max(0, prefix - context)
  const out: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`, `@@ -${start + 1} +${start + 1} @@`]
  for (let i = start; i < prefix; i += 1) out.push(` ${from[i]}`)
  for (let i = prefix; i < from.length - suffix; i += 1) out.push(`-${from[i]}`)
  for (let i = prefix; i < to.length - suffix; i += 1) out.push(`+${to[i]}`)
  const tail = Math.min(from.length, from.length - suffix + context)
  for (let i = from.length - suffix; i < tail; i += 1) out.push(` ${from[i]}`)
  return out.join('\n')
}

// ------------------------------------------------------------------ utilities

export function normalizeBaseUrl(input: string): string {
  const url = new URL(input.trim())
  url.pathname = url.pathname.replace(/\/?$/, '/')
  return url.href
}

export function describeGit(git: NonNullable<LinkRecord['git']>): string {
  if (git.mode === 'parent') return `parent repo (${git.root ?? 'unknown root'})`
  if (git.mode === 'own') return `own repo @${git.initialCommit ?? 'unknown'}`
  return `no repo${git.reason ? ` (${git.reason})` : ''}`
}

/** Reject absolute paths, `..` segments and Windows device names coming from the remote tree. */
export function sanitizeRelative(relPath: string): string | undefined {
  const parts = relPath.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return undefined
  for (const part of parts) {
    if (part === '.' || part === '..') return undefined
    if (/^[A-Za-z]:$/.test(part)) return undefined
    if (/[<>:"|?*\u0000-\u001f]/.test(part)) return undefined
  }
  return parts.join('/')
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await atomicWrite(file, JSON.stringify(value, null, 2))
}
