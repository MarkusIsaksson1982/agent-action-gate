import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, verifyHashChain, hashAuditEntry, GENESIS_HASH, canonicalJson } from '../src/gate/index.js';

const fx = (n: string) => readFileSync(new URL('../../fixtures/audit-logs/' + n, import.meta.url), 'utf8');
const HEAD = fx('valid.head.txt').trim();
const codes = (r: ReturnType<typeof verifyHashChain>) => r.issues.map((i) => `${i.line}:${i.code}`);

test('hash chain verify: valid fixture passes, head matches', () => {
  const r = verifyHashChain(fx('valid.jsonl'), { expectedHead: HEAD, expectedCount: 6 });
  assert.equal(r.ok, true); assert.equal(r.entries, 6); assert.equal(r.head, HEAD); assert.equal(r.lastSeq, 5);
});

test('hash chain verify: edited entry -> hash_mismatch on that line only', () => {
  assert.deepEqual(codes(verifyHashChain(fx('tampered-edited-entry.jsonl'))), ['6:hash_mismatch']);
});

test('hash chain verify: deleted entry -> seq gap and broken link', () => {
  assert.deepEqual(codes(verifyHashChain(fx('tampered-deleted-entry.jsonl'))), ['4:seq_gap', '4:prev_hash_mismatch']);
});

test('hash chain verify: reordered entries are detected', () => {
  const r = verifyHashChain(fx('tampered-reordered.jsonl'));
  assert.equal(r.ok, false); assert.ok(codes(r).includes('2:seq_gap'));
});

test('hash chain verify: truncated tail only caught with a recorded head', () => {
  assert.equal(verifyHashChain(fx('tampered-truncated.jsonl')).ok, true);
  assert.deepEqual(codes(verifyHashChain(fx('tampered-truncated.jsonl'), { expectedHead: HEAD })), ['4:head_mismatch']);
  assert.equal(verifyHashChain(fx('tampered-truncated.jsonl'), { expectedCount: 6 }).ok, false);
});

test('hash chain verify: unparseable line, blank line, wrong shape', () => {
  assert.deepEqual(codes(verifyHashChain(fx('tampered-bad-json.jsonl'))), ['3:parse_error', '4:seq_gap', '4:prev_hash_mismatch']);
  assert.deepEqual(codes(verifyHashChain('\n')), ['1:empty_line']);
  assert.deepEqual(codes(verifyHashChain('{"seq":0}\n')), ['1:bad_shape']);
  assert.deepEqual(verifyHashChain(''), { ok: true, entries: 0, head: GENESIS_HASH, lastSeq: -1, issues: [] });
});

test('hash chain verify: recomputing the edited hash still breaks the next link', () => {
  const lines = fx('valid.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  lines[2].data.outcome = 'executed'; lines[2].hash = hashAuditEntry(lines[2]);
  assert.deepEqual(codes(verifyHashChain(lines)), ['4:prev_hash_mismatch']);
});

test('audit log: append-only JSONL file, reopen continues the chain', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aag-')), 'audit.jsonl');
  const a = new AuditLog({ path, now: () => new Date('2026-01-01T00:00:00Z') });
  const e0 = a.append('decision', { b: 2, a: 1 });
  assert.equal(e0.prevHash, GENESIS_HASH);
  assert.equal(e0.hash, hashAuditEntry({ seq: 0, ts: '2026-01-01T00:00:00.000Z', type: 'decision', data: { a: 1, b: 2 }, prevHash: GENESIS_HASH }));
  const b = new AuditLog({ path });
  const e1 = b.append('decision', { n: 2 });
  assert.equal(e1.seq, 1); assert.equal(e1.prevHash, e0.hash);
  assert.equal(verifyHashChain(readFileSync(path, 'utf8')).ok, true);
  assert.equal(readFileSync(path, 'utf8').split('\n').length, 3);
});

test('audit log immutable: snapshots are copies, reopening a tampered file refuses to append', () => {
  const a = new AuditLog(); a.append('x', { v: 1 });
  const snap = a.all(); (snap[0]!.data as { v: number }).v = 99;
  assert.equal(a.verify().ok, true);
  assert.deepEqual(a.all()[0]!.data, { v: 1 });
  const path = join(mkdtempSync(join(tmpdir(), 'aag-')), 'audit.jsonl');
  writeFileSync(path, fx('tampered-edited-entry.jsonl'));
  assert.throws(() => new AuditLog({ path }), /refusing to append to a broken audit log/);
});

test('canonical JSON: key order independent, rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[1,{"c":2,"d":1}]}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /unsupported/);
});

test('audit log: second writer on the same file is refused instead of forking the chain', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aag-')), 'audit.jsonl');
  const a = new AuditLog({ path }); a.append('x', 1);
  const b = new AuditLog({ path }); b.append('x', 2);
  assert.throws(() => a.append('x', 3), /changed on disk/);
  assert.equal(verifyHashChain(readFileSync(path, 'utf8')).ok, true);
});

test('hash chain verify: duplicate seq numbers are a gap', () => {
  const lines = fx('valid.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(verifyHashChain([lines[0], lines[1], lines[1]]).issues[0]!.code, 'seq_gap');
});
