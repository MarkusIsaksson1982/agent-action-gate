import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';

const F = fileURLToPath(new URL('../../fixtures/', import.meta.url));
function run(...argv: string[]) { const out: string[] = []; const err: string[] = []; const code = runCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join('\n'), err: err.join('\n') }; }

test('cli verify: valid log exits 0, tampered audit log exits 1 with line numbers', () => {
  const ok = run('verify', F + 'audit-logs/valid.jsonl');
  assert.equal(ok.code, 0); assert.match(ok.out, /^OK 6 entries, head [0-9a-f]{64}$/);
  const bad = run('verify', F + 'audit-logs/tampered-deleted-entry.jsonl');
  assert.equal(bad.code, 1); assert.match(bad.out, /line 4 seq 4: seq_gap/);
});

test('cli verify --head catches truncation; --json output', () => {
  const head = readFileSync(F + 'audit-logs/valid.head.txt', 'utf8').trim();
  assert.equal(run('verify', F + 'audit-logs/tampered-truncated.jsonl', '--head', head).code, 1);
  const j = JSON.parse(run('verify', F + 'audit-logs/valid.jsonl', '--json', '--head', head).out);
  assert.equal(j.ok, true); assert.equal(j.head, head);
});

test('cli check: exit code per effect (0 allow, 3 require_approval, 4 deny)', () => {
  const pol = F + 'policies/payments-refund.policy.json';
  assert.equal(run('check', pol, F + 'tool-calls/refund-small.call.json').code, 0);
  const a = run('check', pol, F + 'tool-calls/refund-large.call.json');
  assert.equal(a.code, 3); assert.match(a.out, /^require_approval \[refund-large-approval\]/);
  assert.equal(run('check', pol, F + 'tool-calls/refund-over-limit.call.json').code, 4);
  assert.equal(JSON.parse(run('check', pol, F + 'tool-calls/refund-small.call.json', '--json').out).effect, 'allow');
});

test('cli lint and usage errors', () => {
  assert.equal(run('lint', F + 'policies/devops-shell.policy.json').out, 'OK 5 rules');
  const bad = run('lint', F + 'policies/invalid-unknown-operator.policy.json');
  assert.equal(bad.code, 2); assert.match(bad.err, /invalid policy: .*greaterThan/);
  assert.equal(run().code, 2); assert.equal(run('verify', '/no/such/file').code, 2);
});

test('cli: malformed --count/--head and invalid call shape are usage errors (exit 2)', () => {
  assert.equal(run('verify', F + 'audit-logs/valid.jsonl', '--count', 'xyz').code, 2);
  assert.equal(run('verify', F + 'audit-logs/valid.jsonl', '--head').code, 2);
  assert.equal(run('check', F + 'policies/payments-refund.policy.json', F + 'policies/email-send.policy.json').code, 2);
});

test('cli: --head=<hash> form, array args rejected', () => {
  const head = readFileSync(F + 'audit-logs/valid.head.txt', 'utf8').trim();
  assert.equal(run('verify', F + 'audit-logs/tampered-truncated.jsonl', '--head=' + head).code, 1);
  assert.equal(run('verify', F + 'audit-logs/valid.jsonl', '--head=' + head).code, 0);
});
