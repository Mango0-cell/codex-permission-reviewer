import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(command: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
  return result.stdout;
}
const temporary = await mkdtemp(join(tmpdir(), 'reviewer-package-'));
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary])) as { filename: string }[];
  assert.equal(packed.length, 1);
  const archive = join(temporary, packed[0]!.filename);
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: temporary });
  const installed = join(temporary, 'node_modules/codex-permission-reviewer');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { bin: Record<string, string>; types: string };
  await access(join(installed, manifest.types));
  await assert.rejects(access(join(temporary, 'node_modules/typescript')), { code: 'ENOENT' });
  const cli = join(installed, manifest.bin['codex-permission-reviewer']!);
  assert.match(run(process.execPath, [cli, '--help']), /Usage:/u);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'review_sensitive_action', arguments: {} } },
  ];
  const replies = run(process.execPath, [cli, 'mcp'], { input: requests.map(value => JSON.stringify(value)).join('\n') + '\n' })
    .trim().split('\n').map(line => JSON.parse(line) as { id: number; result: { tools?: { name: string }[]; structuredContent?: { verdict: string } } });
  assert.equal(replies.find(reply => reply.id === 2)?.result.tools?.[0]?.name, 'review_sensitive_action');
  assert.equal(replies.find(reply => reply.id === 3)?.result.structuredContent?.verdict, 'deny');
  if (process.platform !== 'win32') {
    const codexHome = join(temporary, 'isolated-codex-home');
    const fakeBin = join(temporary, 'fake-bin');
    const recordedArgs = join(temporary, 'codex-arguments.json');
    const fakeCodex = join(fakeBin, 'codex');
    await mkdir(fakeBin);
    await writeFile(fakeCodex, [
      '#!/usr/bin/env node',
      'import fs from "node:fs";',
      'fs.writeFileSync(process.env.REVIEWER_CODEX_ARGUMENTS, JSON.stringify(process.argv.slice(2)));',
      '',
    ].join('\n'), { mode: 0o755 });
    await chmod(fakeCodex, 0o755);
    const installOutput = run(process.execPath, [cli, 'install'], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        REVIEWER_CODEX_ARGUMENTS: recordedArgs,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
    assert.match(installOutput, /Installed codex-permission-reviewer/u);
    const copiedSkill = join(codexHome, 'skills/sensitive-permission-review/SKILL.md');
    assert.equal(await readFile(copiedSkill, 'utf8'), await readFile(join(installed, 'skills/sensitive-permission-review/SKILL.md'), 'utf8'));
    assert.equal((await stat(copiedSkill)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(recordedArgs, 'utf8')), [
      'mcp', 'add', '--env', 'CODEX_PERMISSION_REVIEW_MODEL=gpt-5.6-luna', '--env',
      'CODEX_PERMISSION_REVIEW_EFFORT=max', 'codex-permission-reviewer', '--', 'npx', '-y',
      'github:adriancho91s/codex-permission-reviewer#v0.3.0', 'mcp',
    ]);
  }
  const legacy = await import(pathToFileURL(join(installed, 'scripts/server.mjs')).href) as typeof import('./server.js');
  assert.equal(legacy.TOOL_NAME, 'review_sensitive_action');
  process.stdout.write('Installed archive: CLI, MCP, isolated installer, legacy imports and declarations passed without runtime TypeScript.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
