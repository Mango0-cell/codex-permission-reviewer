import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeActionForReview } from '../src/action/metadata.js';
import { hasLearnedApproval, rememberLearnedApproval } from '../src/approvals/store.js';
import { action } from './helpers.js';

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
