/**
 * "How many local files differ from the sync baseline?" — the number behind the
 * GUI's 待推送 badge (design §14.5).
 *
 * Two things make this less obvious than a hash loop:
 *
 * 1. **Binary uploads are not text.** A pulled image is hashed over raw bytes
 *    (`sha256Bytes`), while a document is hashed over LF-normalized text
 *    (`fsUtil.sha256(normalizeEol(…))`). Reading an image as UTF-8 and comparing
 *    that hash reports every picture as "changed" the moment it is pulled.
 * 2. **Only baseline paths can be pushed.** Untracked local files (a `.git`
 *    artifact, an editor swap file, a build output) are not something `push`
 *    would ever send, so counting them makes the badge cry wolf.
 *
 * On an SSH host every read is a round trip and the panel asks on every
 * refresh, so the first pass asks the host for its own `sha256sum` of all the
 * files at once; only the files that answer differently from the baseline are
 * downloaded for the exact comparison.
 */
import { normalizeEol, sha256 } from '../core/fsUtil.js'
import { sha256Bytes } from '../core/files.js'
import { localTree, type TreeIo } from '../core/tree.js'
import type { FileState, ProjectState } from '../types.js'

type BaselineEntries = Array<[rel: string, baseline: FileState]>

/**
 * Count baseline entries whose local file changed or disappeared.
 *
 * `shouldIgnore` is optional: paths the link excludes (or `.overleaf-syncignore`
 * matches) are not "pending", they are deliberately out of sync.
 */
export async function countPendingLocalChanges(
  state: Pick<ProjectState, 'files'>,
  localRoot: string,
  shouldIgnore?: (relPath: string) => boolean,
  tree: TreeIo = localTree,
): Promise<number> {
  const entries: BaselineEntries = Object.entries(state.files).filter(([rel]) => shouldIgnore?.(rel) !== true)
  if (tree.kind === 'ssh') return countPendingViaHashes(entries, localRoot, tree)

  let changed = 0
  for (const [rel, baseline] of entries) {
    if (!(await isUnchangedOnDisk(tree, localRoot, rel, baseline))) changed += 1
  }
  return changed
}

/** First pass: the host's own checksums. Second pass: exact, for the files that disagree. */
async function countPendingViaHashes(entries: BaselineEntries, localRoot: string, tree: TreeIo): Promise<number> {
  const hashes = await tree.hashFiles(
    localRoot,
    entries.map(([rel]) => rel),
  )
  let changed = 0
  const uncertain: BaselineEntries = []
  for (const entry of entries) {
    const hex = hashes.get(entry[0])
    // A raw checksum equal to the baseline proves nothing changed; the reverse
    // is not a proof (CRLF, a missed file), so those are re-read.
    if (hex !== undefined && `sha256:${hex}` === entry[1].localHash) continue
    uncertain.push(entry)
  }
  for (const [rel, baseline] of uncertain) {
    if (!(await isUnchangedOnDisk(tree, localRoot, rel, baseline))) changed += 1
  }
  return changed
}

async function isUnchangedOnDisk(
  tree: TreeIo,
  localRoot: string,
  rel: string,
  baseline: FileState,
): Promise<boolean> {
  let bytes: Buffer | undefined
  try {
    bytes = await tree.readBytes(tree.resolve(localRoot, rel))
  } catch {
    return false
  }
  if (bytes === undefined) return false
  return isUnchanged(baseline, bytes)
}

/**
 * Entries written before `FileState.kind` existed cannot say how they were
 * hashed, so either hash matching counts as in sync. That keeps old state files
 * from flagging every pulled image as a local edit.
 */
export function isUnchanged(baseline: FileState, bytes: Buffer): boolean {
  if (baseline.localHash === sha256Bytes(bytes)) return true
  if (baseline.kind === 'file') return false
  return baseline.localHash === sha256(normalizeEol(bytes.toString('utf8')))
}
