// The bench member's Charts board is shared by every flip proof on this PC. Each proof run applies its test board
// and restores it, so two runs at once overwrite each other's apply/restore. The heavy lock (never forced) orders
// the runs that honour it; this marker file covers users that run beside the lock (2026-11-20: --force-concurrent
// A/B runs). A marker is { label, runId, pid, startedUtc, what }, created O_EXCL. A marker of OUR label whose pid
// is dead is stale and cleared; any other marker (another tool's, free text included) is waited on, never removed.
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export const markerText = (f) => { try { return readFileSync(f, 'utf8').trim() } catch { return null } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const parse = (f) => { try { const m = JSON.parse(markerText(f) || ''); return m && typeof m === 'object' ? m : null } catch { return null } }

/** Is the board held? Clears a stale marker of `label` (its pid dead) first. */
export function boardIsBusy(f, label, log = () => {}) {
  if (!f || !existsSync(f)) return false
  const m = parse(f)
  if (m && m.label === label && Number.isInteger(m.pid) && !pidAlive(m.pid)) {
    try { rmSync(f) } catch { /* raced */ }
    log(`cleared a stale ${label} board marker (${m.runId}, pid ${m.pid} dead)`)
    return existsSync(f)
  }
  return true
}

/** Take the board (O_EXCL). false = someone holds it. The marker goes when this process exits, whatever happens. */
export function takeBoard(f, label, runId, what) {
  boardIsBusy(f, label)
  try {
    const fd = openSync(f, 'wx')
    writeFileSync(fd, JSON.stringify({ label, runId, pid: process.pid, startedUtc: new Date().toISOString(), what }) + '\n')
    closeSync(fd)
  } catch (e) {
    if (e.code === 'EEXIST') return false
    throw e
  }
  process.on('exit', () => releaseBoard(f, label, runId))
  return true
}

/** The board version a finished flip-proof result still has to have put back, or null. The proof records
 * boardVersionBefore just before it applies its test board and saves its result right after, so a result with no
 * version never changed the board; one whose restore is not confirmed (killed, refused) needs `--restore=<v>`. */
export function boardToRestore(j) {
  if (!j || j.boardRestore === 200 || j.boardRestore === 'unchanged' || j.restoreOnly != null) return null
  return typeof j.boardVersionBefore === 'number' ? j.boardVersionBefore : null
}

/** Remove the marker only if it is still ours (label and runId). */
export function releaseBoard(f, label, runId) {
  const m = f && parse(f)
  if (m && m.label === label && m.runId === runId) { try { rmSync(f) } catch { /* gone */ } }
}
