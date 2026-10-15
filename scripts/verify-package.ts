import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}): string {
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
  const legacy = await import(pathToFileURL(join(installed, 'scripts/server.mjs')).href) as typeof import('./server.js');
  assert.equal(legacy.TOOL_NAME, 'review_sensitive_action');
  process.stdout.write('Installed archive: CLI, MCP, legacy imports and declarations passed without runtime TypeScript.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
