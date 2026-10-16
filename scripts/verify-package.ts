import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_VERSION } from '../src/version.ts';

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPackFile(value: unknown): value is PackFile {
  return isRecord(value) && typeof value.path === 'string';
}

function isPackResult(value: unknown): value is PackResult {
  return isRecord(value)
    && typeof value.filename === 'string'
    && Array.isArray(value.files)
    && value.files.every((file: unknown) => isPackFile(file));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function run(command: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
  return result.stdout;
}
const temporary = await mkdtemp(join(tmpdir(), 'reviewer-package-'));
try {
  const rawPackOutput: unknown = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]));
  assert.ok(Array.isArray(rawPackOutput), 'npm pack must return a JSON array');
  const packResults = rawPackOutput as unknown[];
  assert.equal(packResults.length, 1);
  const packResult = packResults[0];
  assert.ok(isPackResult(packResult), 'npm pack must report the archive name and its files');

  const packagedPaths = new Set(packResult.files.map(file => file.path));
  for (const path of (await sourceFiles('src')).filter(path => path.endsWith('.ts'))) {
    const emitted = `dist/${path.replace(/\.ts$/u, '.js')}`;
    assert.ok(packagedPaths.has(emitted), `missing packaged runtime ${emitted}`);
    assert.ok(packagedPaths.has(emitted.replace(/\.js$/u, '.d.ts')), `missing packaged declaration ${emitted}`);
  }
  for (const path of ['scripts/server.mjs', 'scripts/app-server-client.mjs', 'bin/cli.mjs', 'skills/sensitive-permission-review/SKILL.md', '.mcp.json', '.codex-plugin/plugin.json']) {
    assert.ok(packagedPaths.has(path), `missing packaged entrypoint ${path}`);
  }
  assert.ok(![...packagedPaths].some(path => path.startsWith('graphify-out/') || path.startsWith('dist/tests/')));
  assert.ok(![...packagedPaths].some(path => /^(src|tests|bin|scripts)\/.*\.ts$/u.test(path)));

  const archive = join(temporary, packResult.filename);
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: temporary });
  const installed = join(temporary, 'node_modules/codex-permission-reviewer');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { bin: Record<string, string>; types: string; version: string };
  assert.equal(manifest.version, PACKAGE_VERSION, 'archive package version must match the compiled runtime version');
  await access(join(installed, manifest.types));
  await assert.rejects(access(join(temporary, 'node_modules/typescript')), { code: 'ENOENT' });
  const consumer = join(temporary, 'consumer.mts');
  await writeFile(consumer, [
    "import { TOOL_NAME } from 'codex-permission-reviewer';",
    "import type { ActionInput, ReviewResult } from 'codex-permission-reviewer';",
    'const name: string = TOOL_NAME;',
    'type PublicTypes = [ActionInput, ReviewResult];',
    'void name;',
  ].join('\n'));
  run(process.execPath, [
    join(process.cwd(), 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022', '--types', 'node', '--typeRoots', join(process.cwd(), 'node_modules/@types'), consumer,
  ], { cwd: temporary });
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
      `github:adriancho91s/codex-permission-reviewer#v${PACKAGE_VERSION}`, 'mcp',
    ]);
  }
  const legacy = await import(pathToFileURL(join(installed, 'scripts/server.mjs')).href) as typeof import('./server.ts');
  assert.equal(legacy.TOOL_NAME, 'review_sensitive_action');
  process.stdout.write('Installed archive: CLI, MCP, isolated installer, legacy imports and declarations passed without runtime TypeScript.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
