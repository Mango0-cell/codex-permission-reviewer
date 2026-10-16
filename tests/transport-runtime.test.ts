import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { readBoundedLines } from '../src/transport/mcp.ts';
import { buildMinimalChildEnvironment, appServerConfigText, buildAppServerRequests } from '../src/runtime/app-server-client.ts';

test('MCP rejects pre-initialize tool access and negotiates protocol through stable launcher', async () => {
  const child = spawn(process.execPath, ['scripts/server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'review_sensitive_action', arguments: {} } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(await closed, 0, stderr);
  const replies = new Map(stdout.trim().split('\n').map(line => { const value = JSON.parse(line); return [value.id, value]; }));
  assert.equal(replies.get(1).error.code, -32002);
  assert.equal(replies.get(2).result.protocolVersion, '2025-06-18');
  assert.equal(replies.get(3).result.tools[0].name, 'review_sensitive_action');
  assert.equal(replies.get(4).result.structuredContent.verdict, 'deny');
});

test('stream bounds recover after oversized chunks and preserve split UTF-8', async () => {
  async function* chunks() { yield Buffer.from('abcde'); yield Buffer.from('f\nok\r\n'); yield Buffer.from([0xc3]); yield Buffer.from([0xa9, 0x0a]); }
  const result = [];
  for await (const item of readBoundedLines(chunks(), 5)) result.push(item.oversized ? 'oversized' : item.line!.toString());
  assert.deepEqual(result, ['oversized', 'ok', 'é']);
});

test('runtime composition preserves no-tools configuration and filters inherited environment', () => {
  const env = buildMinimalChildEnvironment({ PATH: '/usr/bin', HOME: '/home/test', UNTRUSTED_TOKEN: 'fixture' }, '/tmp/isolated');
  assert.equal(env.UNTRUSTED_TOKEN, undefined);
  assert.equal(env.CODEX_HOME, '/tmp/isolated');
  const config = appServerConfigText();
  assert.match(config, /web_search = "disabled"/u);
  assert.match(config, /shell_tool = false/u);
  assert.match(config, /enabled = false/u);
  const requests = buildAppServerRequests({ cwd: '/tmp/isolated', prompt: 'Review fixture', outputSchema: { type: 'object' } });
  assert.ok(requests);
});
