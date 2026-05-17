import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSessionDir,
  resolveSessionPaths,
  sanitiseSessionId,
  acquireSessionLock,
  readSessionLock,
  pruneStaleSessions,
  isSessionPaired,
  isPidAlive,
  SessionLockedError,
  LOCK_FILENAME,
} from './session-store.js';

describe('session-store/sanitiseSessionId', () => {
  it('keeps E.164 numbers intact', () => {
    expect(sanitiseSessionId('+628123456789')).toBe('+628123456789');
    expect(sanitiseSessionId('628123')).toBe('628123');
  });

  it('replaces unsafe chars with underscore', () => {
    expect(sanitiseSessionId('hello world!')).toBe('hello_world_');
    expect(sanitiseSessionId('a/b\\c')).toBe('a_b_c');
  });

  it('blocks path traversal', () => {
    // `/` becomes `_` (char filter), then `..` becomes `__` so the
    // result is `___escape` — 3 underscores (slash + two dots).
    expect(sanitiseSessionId('../escape')).toBe('___escape');
    expect(sanitiseSessionId('a..b')).toBe('a__b');
    // Round-trip safety: the result never contains a `..` segment,
    // so it cannot escape the parent directory.
    expect(sanitiseSessionId('../escape')).not.toContain('..');
  });

  it('falls back to "default" for empty/whitespace input', () => {
    expect(sanitiseSessionId('')).toBe('default');
    expect(sanitiseSessionId('   ')).toBe('default');
  });
});

describe('session-store/resolveSessionPaths', () => {
  it('joins base + sanitised id', () => {
    const r = resolveSessionPaths({
      sessionId: '+628123',
      baseDir: '/tmp/wa-test',
    });
    expect(r.baseDir).toBe('/tmp/wa-test');
    expect(r.sessionDir.replace(/\\/g, '/')).toBe('/tmp/wa-test/+628123');
  });

  it('does not create directories', () => {
    const dir = join(tmpdir(), `wa-pure-${Date.now()}`);
    resolveSessionPaths({ sessionId: 'x', baseDir: dir });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('session-store/ensureSessionDir', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-session-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the base + session directories', () => {
    const r = ensureSessionDir({ sessionId: '+628123', baseDir: tmp });
    expect(existsSync(r.baseDir)).toBe(true);
    expect(existsSync(r.sessionDir)).toBe(true);
  });

  it('is idempotent across repeated calls', () => {
    const r1 = ensureSessionDir({ sessionId: '+628', baseDir: tmp });
    const r2 = ensureSessionDir({ sessionId: '+628', baseDir: tmp });
    expect(r1.sessionDir).toBe(r2.sessionDir);
    expect(existsSync(r1.sessionDir)).toBe(true);
  });
});

describe('session-store/acquireSessionLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-lock-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes the lockfile on acquire and removes it on release', () => {
    const lock = acquireSessionLock({
      sessionDir: dir,
      heartbeatMs: 1_000_000, // effectively disabled in this test
      pid: 4242,
      hostname: 'tester',
      now: () => 1_700_000_000_000,
    });
    expect(lock.path).toBe(join(dir, LOCK_FILENAME));
    expect(existsSync(lock.path)).toBe(true);
    const parsed = JSON.parse(readFileSync(lock.path, 'utf8'));
    expect(parsed).toMatchObject({
      pid: 4242,
      hostname: 'tester',
      startedAt: 1_700_000_000_000,
      heartbeatAt: 1_700_000_000_000,
    });
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it('throws SessionLockedError when a fresh lock exists', () => {
    // Plant a fresh-looking lock from a different pid.
    const lockPath = join(dir, LOCK_FILENAME);
    const now = 1_700_000_000_000;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 9999, hostname: 'other', startedAt: now, heartbeatAt: now }),
      'utf8',
    );

    expect(() =>
      acquireSessionLock({
        sessionDir: dir,
        pid: 1,
        hostname: 'me',
        now: () => now + 1_000, // 1s after the lock was written — fresh
      }),
    ).toThrow(SessionLockedError);

    // Existing lock untouched.
    const after = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(after.pid).toBe(9999);
  });

  it('takes over a stale lock with a warn', () => {
    const lockPath = join(dir, LOCK_FILENAME);
    const oldHeartbeat = 1_700_000_000_000;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 9999,
        hostname: 'other',
        startedAt: oldHeartbeat,
        heartbeatAt: oldHeartbeat,
      }),
      'utf8',
    );

    const lock = acquireSessionLock({
      sessionDir: dir,
      pid: 1,
      hostname: 'me',
      staleMs: 90_000,
      now: () => oldHeartbeat + 91_000, // 91s after — stale
      heartbeatMs: 1_000_000,
    });
    expect(lock.info.pid).toBe(1);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(parsed.pid).toBe(1);
    expect(parsed.hostname).toBe('me');
    lock.release();
  });

  it('overwrites an unparseable lockfile', () => {
    const lockPath = join(dir, LOCK_FILENAME);
    writeFileSync(lockPath, 'not-json', 'utf8');
    const lock = acquireSessionLock({
      sessionDir: dir,
      pid: 1,
      hostname: 'me',
      heartbeatMs: 1_000_000,
    });
    expect(existsSync(lock.path)).toBe(true);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(parsed.pid).toBe(1);
    lock.release();
  });

  it('lets the same pid re-acquire its own lock', () => {
    const now = 1_700_000_000_000;
    const lock1 = acquireSessionLock({
      sessionDir: dir,
      pid: 4242,
      hostname: 'tester',
      heartbeatMs: 1_000_000,
      now: () => now,
    });
    // Same pid + hostname tries again — should not throw.
    const lock2 = acquireSessionLock({
      sessionDir: dir,
      pid: 4242,
      hostname: 'tester',
      heartbeatMs: 1_000_000,
      now: () => now + 100,
    });
    expect(lock2.info.pid).toBe(4242);
    lock1.release();
    lock2.release();
  });

  it('release is idempotent', () => {
    const lock = acquireSessionLock({
      sessionDir: dir,
      pid: 1,
      hostname: 'me',
      heartbeatMs: 1_000_000,
    });
    lock.release();
    // Second call must not throw.
    expect(() => lock.release()).not.toThrow();
  });

  it('release tolerates a manually deleted lockfile', () => {
    const lock = acquireSessionLock({
      sessionDir: dir,
      pid: 1,
      hostname: 'me',
      heartbeatMs: 1_000_000,
    });
    unlinkSync(lock.path);
    expect(() => lock.release()).not.toThrow();
  });
});

describe('session-store/readSessionLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-lock-read-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no lockfile exists', () => {
    expect(readSessionLock(dir)).toBeNull();
  });

  it('returns null on an unparseable lockfile', () => {
    writeFileSync(join(dir, LOCK_FILENAME), 'garbage', 'utf8');
    expect(readSessionLock(dir)).toBeNull();
  });

  it('returns the parsed struct on a valid lockfile', () => {
    writeFileSync(
      join(dir, LOCK_FILENAME),
      JSON.stringify({
        pid: 7,
        hostname: 'h',
        startedAt: 100,
        heartbeatAt: 200,
      }),
      'utf8',
    );
    expect(readSessionLock(dir)).toEqual({
      pid: 7,
      hostname: 'h',
      startedAt: 100,
      heartbeatAt: 200,
    });
  });
});

describe('session-store/pruneStaleSessions', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'wa-prune-'));
  });
  afterEach(() => {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('removes strictly empty folders', () => {
    mkdirSync(join(base, 'empty-1'));
    mkdirSync(join(base, 'empty-2'));
    const result = pruneStaleSessions(base);
    expect(result.pruned.sort()).toEqual(['empty-1', 'empty-2']);
    expect(result.kept).toEqual([]);
    expect(existsSync(join(base, 'empty-1'))).toBe(false);
    expect(existsSync(join(base, 'empty-2'))).toBe(false);
  });

  it('preserves folders with creds.json (real paired sessions)', () => {
    const paired = join(base, '+628123');
    mkdirSync(paired);
    writeFileSync(join(paired, 'creds.json'), '{}', 'utf8');
    const result = pruneStaleSessions(base);
    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual(['+628123']);
    expect(existsSync(join(paired, 'creds.json'))).toBe(true);
  });

  it('preserves folders with ANY content (lockfile, partial creds, …)', () => {
    // A lockfile alone means another process owns it — never delete.
    const locked = join(base, 'locked-session');
    mkdirSync(locked);
    writeFileSync(join(locked, LOCK_FILENAME), '{}', 'utf8');

    // Partial pair: pre-keys written before creds.json — never delete.
    const partial = join(base, 'partial-pair');
    mkdirSync(partial);
    writeFileSync(join(partial, 'pre-key-1.json'), '{}', 'utf8');

    const result = pruneStaleSessions(base);
    expect(result.pruned).toEqual([]);
    expect(result.kept.sort()).toEqual(['locked-session', 'partial-pair']);
    expect(existsSync(join(locked, LOCK_FILENAME))).toBe(true);
    expect(existsSync(join(partial, 'pre-key-1.json'))).toBe(true);
  });

  it('skips dotfile entries at the root', () => {
    writeFileSync(join(base, '.DS_Store'), '', 'utf8');
    mkdirSync(join(base, 'empty'));
    const result = pruneStaleSessions(base);
    expect(result.pruned).toEqual(['empty']);
    expect(result.kept).toEqual([]);
    // .DS_Store untouched — not considered a session folder at all.
    expect(existsSync(join(base, '.DS_Store'))).toBe(true);
  });

  it('returns empty result when baseDir does not exist', () => {
    const missing = join(base, 'never-created');
    const result = pruneStaleSessions(missing);
    expect(result).toEqual({ pruned: [], kept: [] });
  });

  it('keeps non-directory entries (regular files at root) untouched', () => {
    // Defensive: someone left a stray file at the WhatsApp root. Should
    // never be treated as a session folder; never deleted.
    writeFileSync(join(base, 'README.txt'), 'hello', 'utf8');
    const result = pruneStaleSessions(base);
    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual(['README.txt']);
    expect(existsSync(join(base, 'README.txt'))).toBe(true);
  });
});

describe('session-store/isSessionPaired', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-paired-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns false for an empty dir', () => {
    expect(isSessionPaired(dir)).toBe(false);
  });

  it('returns true once creds.json is present', () => {
    writeFileSync(join(dir, 'creds.json'), '{}', 'utf8');
    expect(isSessionPaired(dir)).toBe(true);
  });

  it('returns false for a non-existent dir', () => {
    expect(isSessionPaired(join(dir, 'does-not-exist'))).toBe(false);
  });
});

// 2026-05-17 — crash-recovery short-circuit. When a previous server died
// without releasing the lock, the heartbeat timestamp can be very recent
// (< 90 s old) even though the holder PID is long gone. The default
// acquireSessionLock would refuse for up to lockStaleMs, forcing the
// operator to wait. New logic: if the stored PID is no longer alive
// AND the hostname matches, take over immediately.
describe('session-store/isPidAlive', () => {
  it('returns true for the current process pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a definitely-dead pid (max int)', () => {
    // PID 2^31 - 1 is the upper bound on most OSes; vanishingly unlikely
    // to ever be a real running process. The cross-platform Node
    // process.kill(pid, 0) returns ESRCH for unallocated PIDs.
    expect(isPidAlive(2147483647)).toBe(false);
  });

  it('returns false for an invalid pid (non-integer / zero / negative)', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe('session-store/acquireSessionLock — crash-recovery short-circuit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-lock-recovery-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('takes over immediately when previous PID is dead (same host)', () => {
    const lockPath = join(dir, LOCK_FILENAME);
    const now = 1_700_000_000_000;
    const deadPid = 2147483647; // guaranteed-dead per isPidAlive test above
    // Plant a very recent heartbeat — old code would refuse for 90 s.
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: 'tester-host',
        startedAt: now,
        heartbeatAt: now,
      }),
      'utf8',
    );

    const lock = acquireSessionLock({
      sessionDir: dir,
      pid: 1234,
      hostname: 'tester-host', // same host
      staleMs: 90_000,
      now: () => now + 5_000, // 5 s after heartbeat — would normally refuse
      heartbeatMs: 1_000_000,
    });

    expect(lock.info.pid).toBe(1234);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(parsed.pid).toBe(1234);
    lock.release();
  });

  it('does NOT short-circuit when hostname differs (cross-host PIDs are meaningless)', () => {
    const lockPath = join(dir, LOCK_FILENAME);
    const now = 1_700_000_000_000;
    const deadPid = 2147483647;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadPid,
        hostname: 'OTHER-host',
        startedAt: now,
        heartbeatAt: now,
      }),
      'utf8',
    );

    // Different hostname + fresh heartbeat → must throw, even though PID
    // is dead (it's a different host, our PID space doesn't apply).
    expect(() =>
      acquireSessionLock({
        sessionDir: dir,
        pid: 1234,
        hostname: 'this-host',
        staleMs: 90_000,
        now: () => now + 5_000,
        heartbeatMs: 1_000_000,
      }),
    ).toThrow(SessionLockedError);
  });

  it('does NOT short-circuit when previous PID is still alive (this process)', () => {
    const lockPath = join(dir, LOCK_FILENAME);
    const now = 1_700_000_000_000;
    // Plant a lock claiming THIS process's PID but a different hostname
    // (simulates a parallel instance on the same machine reporting under
    // a different host name — rare, but the gate should still refuse).
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: 'parallel-instance',
        startedAt: now,
        heartbeatAt: now,
      }),
      'utf8',
    );

    expect(() =>
      acquireSessionLock({
        sessionDir: dir,
        pid: process.pid + 1, // different PID so sameProcess check fails
        hostname: 'this-host',
        staleMs: 90_000,
        now: () => now + 5_000,
        heartbeatMs: 1_000_000,
      }),
    ).toThrow(SessionLockedError);
  });

  it('still respects stale-age takeover when PID-liveness probe is unhelpful', () => {
    // Same-host, alive PID, but heartbeat is genuinely old → fall through
    // to the existing stale-age branch.
    const lockPath = join(dir, LOCK_FILENAME);
    const oldNow = 1_700_000_000_000;
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid, // alive
        hostname: 'tester-host',
        startedAt: oldNow,
        heartbeatAt: oldNow,
      }),
      'utf8',
    );

    const lock = acquireSessionLock({
      sessionDir: dir,
      pid: process.pid + 1,
      hostname: 'tester-host',
      staleMs: 90_000,
      now: () => oldNow + 91_000, // genuinely stale
      heartbeatMs: 1_000_000,
    });
    expect(lock.info.pid).toBe(process.pid + 1);
    lock.release();
  });
});
