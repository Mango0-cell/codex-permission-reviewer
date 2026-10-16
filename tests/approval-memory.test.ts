import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntOptions, Mode, OpenMode, PathLike } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { mock } from 'node:test';
import { LEARNED_APPROVAL_TTL_MS } from '../src/config.ts';
import { normalizeActionForReview } from '../src/action/metadata.ts';
import { hasLearnedApproval, rememberLearnedApproval } from '../src/approvals/store.ts';
import { action } from './helpers.ts';

test('approval memory retrieves exact scopes and rejects expired, malformed and changed scopes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    assert.equal(await hasLearnedApproval({ ...scope, userAuthorization: 'none' }), true);
    assert.equal(await hasLearnedApproval({ ...scope, command: 'printf different' }), false);
    assert.equal(await hasLearnedApproval({ ...scope, cwd: '/different-workspace' }), false);
    const file = join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json');
    const raw = await readFile(file, 'utf8');
    assert.ok(!raw.includes(scope.command!));
    const saved = JSON.parse(raw) as { version: number; approvals: { digest: string; expiresAtMs: number }[] };
    const approval = saved.approvals[0];
    assert.ok(approval);
    await writeFile(file, JSON.stringify({ ...saved, approvals: [{ ...approval, expiresAtMs: Date.now() - 1 }] }));
    assert.equal(await hasLearnedApproval(scope), false);
    await writeFile(file, JSON.stringify({ ...saved, approvals: [{ digest: 123, expiresAtMs: 'not-a-timestamp' }] }));
    assert.equal(await hasLearnedApproval(scope), false);
    await writeFile(file, '{broken');
    await assert.rejects(hasLearnedApproval(scope));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('warm approval lookups read the state file once and recheck its identity each time', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-cache-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    const directory = join(home, 'plugin-state/codex-permission-reviewer');
    const file = join(directory, 'learned-approvals.json');
    const raw = await readFile(file, 'utf8');
    const replacement = join(directory, 'replacement.json');
    await writeFile(replacement, raw, { encoding: 'utf8', mode: 0o600 });
    await rename(replacement, file);
    const canonicalFile = await fs.realpath(file);

    let stateOpens = 0;
    let stateBytesRead = 0;
    let stateStats = 0;
    const originalOpen = fs.open.bind(fs);
    const originalLstat = fs.lstat.bind(fs);
    mock.method(fs, 'open', async (path: PathLike, flags: OpenMode, mode?: Mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (String(path) === canonicalFile && flags === (constants.O_RDONLY | constants.O_NOFOLLOW)) {
        stateOpens += 1;
        const originalRead = handle.read.bind(handle);
        mock.method(handle, 'read', async (buffer: Buffer | Uint8Array, offset: number, length: number, position: number | null) => {
          const result = await originalRead(buffer, offset, length, position);
          stateBytesRead += result.bytesRead;
          return result;
        });
      }
      return handle;
    });
    mock.method(fs, 'lstat', async (path: PathLike, options?: BigIntOptions) => {
      if (String(path) === canonicalFile) stateStats += 1;
      return originalLstat(path, options);
    });
    try {
      for (let index = 0; index < 8; index += 1) {
        assert.equal(await hasLearnedApproval(scope), true);
      }
      assert.equal(stateOpens, 1);
      assert.equal(stateBytesRead, Buffer.byteLength(raw, 'utf8'));
      assert.ok(stateStats >= 8, 'each warm lookup should lstat the state file');
    } finally {
      mock.restoreAll();
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('approval expiry is checked on each warm lookup without changing the file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-expiry-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    assert.equal(await hasLearnedApproval(scope), true);
    now += LEARNED_APPROVAL_TTL_MS + 1;
    assert.equal(await hasLearnedApproval(scope), false);
  } finally {
    clock.mock.restore();
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('duplicate hashes preserve the previous any-unexpired-entry lookup behavior', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-duplicates-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    const file = join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as { version: number; approvals: { digest: string; approvedAtMs?: number; expiresAtMs: number }[] };
    const approval = saved.approvals[0];
    assert.ok(approval);
    await writeFile(file, JSON.stringify({
      ...saved,
      approvals: [approval, { ...approval, expiresAtMs: Date.now() - 1 }],
    }), 'utf8');
    assert.equal(await hasLearnedApproval(scope), true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('external replacement, deletion, corruption and symlinks cannot reuse a stale approval', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-revoke-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    const directory = join(home, 'plugin-state/codex-permission-reviewer');
    const file = join(directory, 'learned-approvals.json');
    const raw = await readFile(file, 'utf8');
    assert.equal(await hasLearnedApproval(scope), true);

    const emptyReplacement = join(directory, 'empty-replacement.json');
    await writeFile(emptyReplacement, JSON.stringify({ version: 1, approvals: [] }), { encoding: 'utf8', mode: 0o600 });
    await rename(emptyReplacement, file);
    assert.equal(await hasLearnedApproval(scope), false);
    const validReplacement = join(directory, 'valid-replacement.json');
    await writeFile(validReplacement, raw, { encoding: 'utf8', mode: 0o600 });
    await rename(validReplacement, file);
    assert.equal(await hasLearnedApproval(scope), true);

    await writeFile(file, '{broken', 'utf8');
    await assert.rejects(hasLearnedApproval(scope));
    await writeFile(file, raw, { encoding: 'utf8', mode: 0o600 });
    assert.equal(await hasLearnedApproval(scope), true);

    await rm(file);
    assert.equal(await hasLearnedApproval(scope), false);
    const target = join(directory, 'target.json');
    await writeFile(target, raw, { encoding: 'utf8', mode: 0o600 });
    await symlink(target, file);
    await assert.rejects(hasLearnedApproval(scope));
    await rm(file);
    await writeFile(file, raw, { encoding: 'utf8', mode: 0o600 });
    assert.equal(await hasLearnedApproval(scope), true);

    await fs.chmod(file, 0o644);
    await assert.rejects(hasLearnedApproval(scope));
    await fs.chmod(file, 0o600);
    assert.equal(await hasLearnedApproval(scope), true);

    const canonicalDirectory = join(home, 'trusted-approval-directory');
    await rename(directory, canonicalDirectory);
    await symlink(canonicalDirectory, directory, 'dir');
    await assert.rejects(hasLearnedApproval(scope));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('a symlink target swapped in before open is rejected without reading its contents', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-open-race-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    assert.equal(await hasLearnedApproval(scope), true);

    const directory = join(home, 'plugin-state/codex-permission-reviewer');
    const file = join(directory, 'learned-approvals.json');
    const canonicalFile = await fs.realpath(file);
    const raw = await readFile(file, 'utf8');
    const replacement = join(directory, 'replacement.json');
    const target = join(directory, 'symlink-target.json');
    await writeFile(replacement, raw, { encoding: 'utf8', mode: 0o600 });
    await writeFile(target, raw, { encoding: 'utf8', mode: 0o600 });
    await rename(replacement, file);

    let stateReads = 0;
    let stateBytesRead = 0;
    const originalOpen = fs.open.bind(fs);
    mock.method(fs, 'open', async (path: PathLike, flags: OpenMode, mode?: Mode) => {
      if (String(path) === canonicalFile) {
        await rm(canonicalFile);
        await symlink(target, canonicalFile, 'file');
      }
      const handle = await originalOpen(path, flags, mode);
      if (String(path) === canonicalFile) {
        const originalRead = handle.read.bind(handle);
        mock.method(handle, 'read', async (buffer: Buffer | Uint8Array, offset: number, length: number, position: number | null) => {
          stateReads += 1;
          const result = await originalRead(buffer, offset, length, position);
          stateBytesRead += result.bytesRead;
          return result;
        });
      }
      return handle;
    });
    try {
      await assert.rejects(hasLearnedApproval(scope));
      assert.equal(stateReads, 0, 'the replacement target must be rejected before a content read');
      assert.equal(stateBytesRead, 0);
    } finally {
      mock.restoreAll();
    }

    await rm(canonicalFile, { force: true });
    await writeFile(canonicalFile, raw, { encoding: 'utf8', mode: 0o600 });
    assert.equal(await hasLearnedApproval(scope), true);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('a state path replaced during reading rejects the load and cannot leave a warm positive', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-read-race-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const scope = normalizeActionForReview(action());
    assert.ok(scope);
    await rememberLearnedApproval(scope);
    assert.equal(await hasLearnedApproval(scope), true);

    const directory = join(home, 'plugin-state/codex-permission-reviewer');
    const file = join(directory, 'learned-approvals.json');
    const canonicalFile = await fs.realpath(file);
    const raw = await readFile(file, 'utf8');
    const reload = join(directory, 'reload.json');
    const emptyReplacement = join(directory, 'empty-replacement.json');
    await writeFile(reload, raw, { encoding: 'utf8', mode: 0o600 });
    await rename(reload, file);
    await writeFile(emptyReplacement, JSON.stringify({ version: 1, approvals: [] }), { encoding: 'utf8', mode: 0o600 });

    let replacedAfterRead = false;
    const originalOpen = fs.open.bind(fs);
    mock.method(fs, 'open', async (path: PathLike, flags: OpenMode, mode?: Mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (String(path) !== canonicalFile || replacedAfterRead) return handle;
      const originalRead = handle.read.bind(handle);
      mock.method(handle, 'read', async (buffer: Buffer | Uint8Array, offset: number, length: number, position: number | null) => {
        const result = await originalRead(buffer, offset, length, position);
        if (!replacedAfterRead && result.bytesRead > 0) {
          replacedAfterRead = true;
          await rename(emptyReplacement, canonicalFile);
        }
        return result;
      });
      return handle;
    });
    try {
      await assert.rejects(hasLearnedApproval(scope));
      assert.equal(replacedAfterRead, true);
      assert.equal(await hasLearnedApproval(scope), false);
    } finally {
      mock.restoreAll();
    }
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('learned state writes are atomic, clean up failed temporary files and serialize local approvals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'reviewer-memory-write-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const first = normalizeActionForReview(action());
    const second = normalizeActionForReview(action({ command: 'printf second' }));
    const third = normalizeActionForReview(action({ command: 'printf third' }));
    assert.ok(first && second && third);
    await rememberLearnedApproval(first);
    const file = join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json');
    const previousState = await readFile(file, 'utf8');
    const renameFailure = mock.method(fs, 'rename', async () => {
      throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' });
    });
    try {
      await assert.rejects(rememberLearnedApproval(second), /fixture rename failure/u);
    } finally {
      renameFailure.mock.restore();
    }
    assert.equal(await readFile(file, 'utf8'), previousState);
    assert.deepEqual(await readdir(dirname(file)), ['learned-approvals.json']);
    assert.equal(await hasLearnedApproval(first), true);
    assert.equal(await hasLearnedApproval(second), false);

    await Promise.all([second, third].map((scope) => rememberLearnedApproval(scope)));
    assert.equal(await hasLearnedApproval(first), true);
    assert.equal(await hasLearnedApproval(second), true);
    assert.equal(await hasLearnedApproval(third), true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
