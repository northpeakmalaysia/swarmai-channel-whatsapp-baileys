import {
  mkdirSync,
  existsSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { logger } from '@swarmai/shared';
import { resolveWorkspaceRoot } from '@swarmai/memory';

/**
 * Session-store helpers — manage the on-disk multi-file auth state
 * directory.
 *
 * Baileys' `useMultiFileAuthState(dir)` writes:
 *   creds.json                 — credentials (Noise + Signal + sender keys)
 *   pre-key-*.json             — Signal protocol pre-keys
 *   session-*.json             — active session keys
 *   app-state-sync-key-*.json  — app-state sync keys
 *
 * We delegate the actual read/write to Baileys (lazy-loaded) — this
 * module only ensures the directory exists with the right mode.
 *
 * Phase 10A — added single-instance lockfile (`.swarmai-lock`). Two
 * SwarmAI processes pairing to the same session dir would race on the
 * Signal store and corrupt creds. The lockfile records `{ pid,
 * hostname, startedAt, heartbeatAt }`; a fresh start refuses to take
 * over a lock with a heartbeat younger than `lockStaleMs` (default
 * 90s — three 30s heartbeats). Stale locks are taken over with a
 * warn log so a SIGKILL'd process doesn't strand the operator.
 *
 * Security note: the directory contains credential material that
 * could be used to impersonate the operator's WhatsApp account. We
 * `chmod 0700` on creation so only the file owner can read it. On
 * Windows the chmod call is a no-op (Node maps it through but ACL
 * inheritance from the parent applies); document `~/.swarmai/`
 * should not be world-readable in any case.
 *
 * Encryption-at-rest is intentionally *not* applied here for v1 —
 * Baileys writes to these files continuously during runtime and
 * wrapping every write through AES-GCM would require either a
 * fork or a filesystem proxy. Mode 0700 + the existing
 * `~/.swarmai/` directory hygiene is acceptable for v1; v2 can
 * revisit if a hardened-deployment use case shows up.
 */

export interface SessionStoreOptions {
  /** Override the base directory (default `~/.swarmai/whatsapp-personal/`). */
  baseDir?: string;
  /** Session identifier — used as the folder name. */
  sessionId: string;
}

export interface SessionStorePaths {
  /** The session directory (`<base>/<sessionId>`). */
  sessionDir: string;
  /** The base directory (`<base>`). */
  baseDir: string;
}

/**
 * Resolve session paths *without* creating any directories. Pure —
 * safe to call in tests / arg validation paths.
 *
 * The base directory defaults to `<workspaceRoot>/whatsapp-personal/`
 * where `<workspaceRoot>` is the SwarmAI workspace as resolved by
 * `resolveWorkspaceRoot()` (honours `SWARMAI_WORKSPACE`). Hard-coding
 * `~/.swarmai/` here previously meant a workspace-isolated CLI run
 * was still writing Baileys credentials into the operator's REAL
 * `~/.swarmai/whatsapp-personal/` — the bug responsible for the QA
 * data loss.
 */
export function resolveSessionPaths(opts: SessionStoreOptions): SessionStorePaths {
  const baseDir = opts.baseDir ?? join(resolveWorkspaceRoot(), 'whatsapp-personal');
  const sessionDir = join(baseDir, sanitiseSessionId(opts.sessionId));
  return { baseDir, sessionDir };
}

/**
 * Ensure the session directory exists and is mode 0700. Creates
 * intermediate directories as needed.
 *
 * Returns the resolved paths so callers can pass `sessionDir` straight
 * to Baileys' `useMultiFileAuthState`.
 */
export function ensureSessionDir(opts: SessionStoreOptions): SessionStorePaths {
  const paths = resolveSessionPaths(opts);

  if (!existsSync(paths.baseDir)) {
    mkdirSync(paths.baseDir, { recursive: true });
    safeChmod(paths.baseDir, 0o700);
  }
  if (!existsSync(paths.sessionDir)) {
    mkdirSync(paths.sessionDir, { recursive: true });
    safeChmod(paths.sessionDir, 0o700);
  } else {
    // Re-apply mode in case a prior install left looser perms.
    safeChmod(paths.sessionDir, 0o700);
  }
  return paths;
}

/**
 * Phase 11 — peek at the session dir to decide whether the slot is
 * already paired. Baileys writes `creds.json` once the QR scan
 * completes and the noise handshake produces a stable noise key. We
 * use its presence as the boot-time gate for "should we mount the
 * channel and call client.start()?".
 *
 * Pure / side-effect-free — never creates the dir. Returns false when
 * the dir doesn't exist OR exists but has no creds.json. Filesystem
 * errors degrade gracefully to false (treat unknowable as unpaired).
 */
export function isSessionPaired(sessionDir: string): boolean {
  try {
    return existsSync(join(sessionDir, 'creds.json'));
  } catch {
    return false;
  }
}

/**
 * Sanitise a session id for filesystem use. WhatsApp ids include `+`
 * and digits; we keep both. Strips anything that could escape the
 * directory or interact with shell tooling.
 *
 * Empty / unsafe input falls back to `default` so the operator never
 * lands with an empty path.
 */
export function sanitiseSessionId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'default';
  // Allow + (E.164 plus), digits, letters, dot, dash, underscore.
  const cleaned = trimmed.replace(/[^A-Za-z0-9+._-]/g, '_');
  // Block path traversal explicitly — replace each `.` in any `..`
  // run with `_`, preserving length so the resulting filename has
  // the same character count as the input (helpful for human review).
  if (cleaned.includes('..')) return cleaned.replace(/\./g, '_');
  return cleaned || 'default';
}

/**
 * Phase 12 — auto-cleanup of empty session folders.
 *
 * Background: when `BaileysClient.start()` had a leaky DI seam it
 * silently mkdir'd `<workspaceRoot>/whatsapp-personal/<sessionId>/`
 * on every test run, even when the test passed an explicit
 * `config.sessionDir` override. Operators ended up with 40+ empty
 * folders (`happy`, `cancel`, `test-1778382587166`, …) blocking the
 * `swarmai whatsapp pair` guard. The leak is fixed in
 * `baileys-client.ts` but the residue needs cleaning, and the same
 * shape of pollution could re-appear (e.g. a crash between mkdir and
 * the first creds write).
 *
 * Safety contract (matches the NEVER-DELETE invariant): only folders
 * that are *strictly* empty are removed. If a folder contains ANY
 * entry — including a `.swarmai-lock` heartbeat from a live process,
 * a partial `pre-key-*.json`, or anything else — it is preserved and
 * surfaced to the caller as `kept`. A real paired session always has
 * at least `creds.json`, so it can never match.
 *
 * Returns the lists so callers can log what happened. Filesystem
 * errors degrade gracefully — unreadable entries land in `kept` with
 * the original name so nothing is silently lost.
 */
export interface PruneResult {
  /** Names of folders that were removed (empty + safe to delete). */
  pruned: string[];
  /** Names of folders that were preserved (had ≥1 entry, or stat failed). */
  kept: string[];
}

export function pruneStaleSessions(baseDir: string): PruneResult {
  const result: PruneResult = { pruned: [], kept: [] };
  if (!existsSync(baseDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(baseDir);
  } catch (err) {
    logger.debug(
      { baseDir, err: err instanceof Error ? err.message : String(err) },
      'whatsapp-personal: pruneStaleSessions readdir failed',
    );
    return result;
  }

  for (const name of entries) {
    // Skip dotfiles at the root (e.g. `.DS_Store`). Real session
    // folders are normal directories named after the sessionId.
    if (name.startsWith('.')) continue;
    const full = join(baseDir, name);
    if (!isStrictlyEmptyDir(full)) {
      result.kept.push(name);
      continue;
    }
    try {
      rmdirSync(full);
      result.pruned.push(name);
    } catch (err) {
      logger.debug(
        { full, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: pruneStaleSessions rmdir failed (keeping)',
      );
      result.kept.push(name);
    }
  }

  return result;
}

/**
 * True only when `dir` exists, IS a directory, and has zero entries.
 * Any error or non-dir path returns false (treat unknowable as
 * non-empty — keep, don't delete).
 */
function isStrictlyEmptyDir(dir: string): boolean {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return false;
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (err) {
    // Windows / network shares can refuse chmod. Log + continue —
    // the directory is still inside the operator's home tree.
    logger.debug(
      { path, err: err instanceof Error ? err.message : String(err) },
      'whatsapp-personal: chmod skipped (filesystem unsupported)',
    );
  }
}

// ---- Phase 10A — single-instance lockfile ---------------------------------

/** Lockfile path inside a session directory. */
export const LOCK_FILENAME = '.swarmai-lock';

/**
 * Error thrown when a fresh start finds an existing, fresh (non-stale)
 * lockfile. The CLI / channel start-up surfaces this with a friendly
 * message pointing to `swarmai whatsapp repair`.
 */
export class SessionLockedError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holder: SessionLockInfo,
  ) {
    super(
      `whatsapp-personal: session is locked by another process ` +
        `(pid=${holder.pid}, host=${holder.hostname}, ` +
        `last heartbeat ${new Date(holder.heartbeatAt).toISOString()}). ` +
        `If that process is gone, delete ${lockPath} or run \`swarmai whatsapp repair\`.`,
    );
    this.name = 'SessionLockedError';
  }
}

export interface SessionLockInfo {
  /** Process id of the lock holder. */
  pid: number;
  /** OS hostname of the lock holder. */
  hostname: string;
  /** Lock acquisition time (UNIX ms). */
  startedAt: number;
  /** Last heartbeat (UNIX ms). Stale when > `lockStaleMs` ago. */
  heartbeatAt: number;
}

export interface AcquireLockOptions {
  /** Session directory where the lockfile lives. */
  sessionDir: string;
  /** Heartbeat interval in ms (default 30s). */
  heartbeatMs?: number;
  /** Stale threshold in ms (default 90s). */
  staleMs?: number;
  /** Override pid (tests). */
  pid?: number;
  /** Override hostname (tests). */
  hostname?: string;
  /** Override clock (tests). */
  now?: () => number;
}

export interface SessionLockHandle {
  /** Resolved path of the lockfile. */
  path: string;
  /** Snapshot of the lock state at acquisition. */
  info: SessionLockInfo;
  /** Stop the heartbeat timer and remove the lockfile. Idempotent. */
  release(): void;
}

/**
 * Acquire the session-dir lock. Throws `SessionLockedError` when
 * another fresh (non-stale) holder is detected. Stale holders are
 * taken over with a warn log.
 *
 * The returned handle starts a heartbeat timer (`heartbeatMs`, default
 * 30s) — call `release()` on graceful shutdown to clear the lock and
 * stop the timer. SIGINT/SIGTERM handlers are NOT installed here
 * (callers wire them where they own the lifecycle).
 */
export function acquireSessionLock(opts: AcquireLockOptions): SessionLockHandle {
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const staleMs = opts.staleMs ?? 90_000;
  const now = opts.now ?? (() => Date.now());
  const pid = opts.pid ?? process.pid;
  const hostname = opts.hostname ?? safeHostname();
  const lockPath = join(opts.sessionDir, LOCK_FILENAME);

  // Existing lock?  Read + parse to decide stale vs live.
  if (existsSync(lockPath)) {
    const existing = readLockSafely(lockPath);
    if (existing) {
      const age = now() - existing.heartbeatAt;
      const sameProcess = existing.pid === pid && existing.hostname === hostname;
      const sameHost = existing.hostname === hostname;
      // 2026-05-17 — crash-recovery short-circuit. When the previous
      // holder ran on THIS host but its PID is no longer alive, the
      // lock is by definition orphaned (the heartbeat timer died with
      // the process). Without this check the boot would refuse for up
      // to lockStaleMs (90 s default), forcing the operator to wait
      // — and they reported needing two stop/start cycles in a row
      // because the second start raced inside that 90 s window too.
      // Only fires for same-host (PIDs are meaningless across hosts).
      const orphanedByDeadPid =
        sameHost && !sameProcess && !isPidAlive(existing.pid);
      if (sameProcess) {
        // Same process is reclaiming after a hot-reload — overwrite.
        logger.debug(
          { lockPath, pid },
          'whatsapp-personal: re-acquiring lock from same pid',
        );
      } else if (orphanedByDeadPid) {
        // Previous holder crashed without releasing — take over now.
        logger.warn(
          {
            lockPath,
            staleAgeMs: age,
            previousPid: existing.pid,
            reason: 'previous-pid-not-running',
          },
          'whatsapp-personal: taking over orphaned lock (previous PID is dead)',
        );
      } else if (age <= staleMs) {
        // Live holder — refuse.
        throw new SessionLockedError(lockPath, existing);
      } else {
        // Stale — take over with a warn.
        logger.warn(
          {
            lockPath,
            staleAgeMs: age,
            previousPid: existing.pid,
            previousHost: existing.hostname,
          },
          'whatsapp-personal: taking over stale lock',
        );
      }
    } else {
      // Unparseable file — overwrite. Common after a SIGKILL during write.
      logger.warn(
        { lockPath },
        'whatsapp-personal: lockfile present but unreadable — overwriting',
      );
    }
  }

  const info: SessionLockInfo = {
    pid,
    hostname,
    startedAt: now(),
    heartbeatAt: now(),
  };
  writeLock(lockPath, info);

  // Heartbeat timer — best-effort. If the disk is gone we log + keep
  // running; the next acquire on this dir will find the file stale.
  const timer = setInterval(() => {
    const updated: SessionLockInfo = { ...info, heartbeatAt: now() };
    try {
      writeLock(lockPath, updated);
      info.heartbeatAt = updated.heartbeatAt;
    } catch (err) {
      logger.debug(
        { lockPath, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: heartbeat write failed (non-fatal)',
      );
    }
  }, heartbeatMs);
  // Don't keep the event loop alive purely because of this timer.
  if (typeof timer.unref === 'function') timer.unref();

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch (err) {
      logger.debug(
        { lockPath, err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: unlinkSync(lock) failed (non-fatal)',
      );
    }
  };

  return { path: lockPath, info, release };
}

/**
 * Read the existing lockfile if present, returning the parsed struct
 * or null when missing/unreadable. Pure — never throws.
 */
export function readSessionLock(sessionDir: string): SessionLockInfo | null {
  return readLockSafely(join(sessionDir, LOCK_FILENAME));
}

function readLockSafely(lockPath: string): SessionLockInfo | null {
  try {
    if (!existsSync(lockPath)) return null;
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionLockInfo>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.heartbeatAt !== 'number'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      hostname: parsed.hostname,
      startedAt: parsed.startedAt,
      heartbeatAt: parsed.heartbeatAt,
    };
  } catch {
    return null;
  }
}

function writeLock(lockPath: string, info: SessionLockInfo): void {
  writeFileSync(lockPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
}

function safeHostname(): string {
  try {
    return osHostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 2026-05-17 — POSIX-style liveness probe. `process.kill(pid, 0)` does
 * NOT send a signal; it just tests whether the kernel knows about the
 * pid + whether we have permission to signal it:
 *   - resolves → process exists (or exists but we lack signal permission;
 *     in either case we should NOT take over the lock)
 *   - throws ESRCH → no such process → safe to declare orphaned
 *   - throws EPERM → exists, owned by another user → DON'T take over
 *
 * Defensive: any other error is treated as "alive" (conservative —
 * better to wait the 90 s than to clobber a real running process).
 * Works on Windows too (Node's process.kill wraps OpenProcess + the
 * same ESRCH/EPERM semantics).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process — orphaned
    if (code === 'EPERM') return true; // exists, we just can't signal
    return true; // unknown — be conservative, assume alive
  }
}
