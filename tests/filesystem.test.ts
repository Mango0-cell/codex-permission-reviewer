import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReviewService } from '../src/review/service.js';
import { action, allow } from './helpers.js';

test('trusted read cache rechecks changed files, symlinks, binary and executable targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cpr-read-'));
  const previous = process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS;
  process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS = root;
  try {
    const path = join(root, 'note.md');
    await writeFile(path, 'Hello.');
    let calls = 0;
    const service = createReviewService({ approvalStore: { has: async () => false, remember: async () => {} }, authAvailable: async () => true, runAppServer: async () => { calls++; return JSON.stringify(allow); } });
    const request = action({ operationKind: 'file_read', command: undefined, fileTargets: [path], cwd: root, workspaceRoots: [root], userAuthorization: 'none', reason: 'Inspect text' });
    assert.equal((await service.reviewSensitiveAction(request)).verdict, 'allow');
    assert.equal((await service.reviewSensitiveAction(request)).verdict, 'allow');
    assert.equal(calls, 1);
    await chmod(path, 0o700);
    assert.notEqual((await service.reviewSensitiveAction(request)).verdict, 'allow');
    await chmod(path, 0o600);
    await writeFile(path, Buffer.from([0, 1, 2]));
    assert.notEqual((await service.reviewSensitiveAction(request)).verdict, 'allow');
    await rm(path);
    await symlink(join(root, 'missing.md'), path);
    assert.notEqual((await service.reviewSensitiveAction(request)).verdict, 'allow');
    delete process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS;
    assert.notEqual((await service.reviewSensitiveAction(request)).verdict, 'allow');
  } finally {
    if (previous === undefined) delete process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS; else process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('verified safe reads retain JavaScript and ES module extensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cpr-source-read-'));
  const previous = process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS;
  process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS = root;
  try {
    const service = createReviewService({
      approvalStore: { has: async () => false, remember: async () => {} },
      authAvailable: async () => true,
      runAppServer: async () => JSON.stringify(allow),
    });
    for (const extension of ['.js', '.mjs']) {
      const path = join(root, `module${extension}`);
      await writeFile(path, 'export const ready = true;');
      const request = action({
        operationKind: 'file_read',
        command: undefined,
        fileTargets: [path],
        cwd: root,
        workspaceRoots: [root],
        userAuthorization: 'none',
        reason: 'Inspect existing JavaScript source',
      });
      assert.equal((await service.reviewSensitiveAction(request)).verdict, 'allow', `${extension} should stay on the safe text-file allowlist`);
    }
  } finally {
    if (previous === undefined) delete process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS; else process.env.KIT_CODEX_AUTO_PERMISSION_WORKSPACE_ROOTS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
