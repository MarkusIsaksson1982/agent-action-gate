// Audit log: append-only (immutable once written), hash chain verify, tampered log detection.
// Append-only, hash-chained audit log stored as JSONL (one JSON object per line).
// Each entry carries seq, ts, type, data, prevHash and hash = sha256(canonicalJson({seq, ts, type, data, prevHash})).
// verifyHashChain() re-computes every hash and reports tampered entries, sequence gaps, reordering, broken links,
// unparseable lines and (when you pass a previously recorded head) truncation of the tail.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { canonicalJson, sha256Hex } from './canonical-json.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry<D = unknown> { seq: number; ts: string; type: string; data: D; prevHash: string; hash: string }

export function hashAuditEntry(e: Omit<AuditEntry, 'hash'>): string {
  return sha256Hex(canonicalJson({ seq: e.seq, ts: e.ts, type: e.type, data: e.data, prevHash: e.prevHash }));
}

export type AuditIssueCode = 'parse_error' | 'bad_shape' | 'seq_gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'head_mismatch' | 'empty_line';
export interface AuditIssue { line: number; seq?: number; code: AuditIssueCode; message: string }
export interface VerifyResult { ok: boolean; entries: number; head: string; lastSeq: number; issues: AuditIssue[] }
export interface VerifyOptions { /** head hash recorded earlier (e.g. in a separate store); detects tail truncation */ expectedHead?: string; expectedCount?: number }

const isEntry = (x: unknown): x is AuditEntry => {
  if (x === null || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return Number.isInteger(e.seq) && typeof e.ts === 'string' && typeof e.type === 'string' && 'data' in e
    && typeof e.prevHash === 'string' && typeof e.hash === 'string';
};

/** Verify a hash chain given as parsed entries or JSONL text. Never throws on bad input; reports issues instead. */
export function verifyHashChain(input: string | AuditEntry[], opts: VerifyOptions = {}): VerifyResult {
  const issues: AuditIssue[] = [];
  let rows: { line: number; raw: unknown }[];
  if (typeof input === 'string') {
    const lines = input.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    rows = [];
    lines.forEach((text, i) => {
      if (text.trim() === '') { issues.push({ line: i + 1, code: 'empty_line', message: 'blank line inside the log' }); return; }
      try { rows.push({ line: i + 1, raw: JSON.parse(text) }); }
      catch { issues.push({ line: i + 1, code: 'parse_error', message: 'line is not valid JSON' }); }
    });
  } else rows = input.map((raw, i) => ({ line: i + 1, raw }));

  let prevHash = GENESIS_HASH; let expectedSeq = 0; let count = 0; let lastSeq = -1;
  for (const { line, raw } of rows) {
    if (!isEntry(raw)) { issues.push({ line, code: 'bad_shape', message: 'entry lacks seq/ts/type/data/prevHash/hash' }); continue; }
    count++;
    if (raw.seq !== expectedSeq) issues.push({ line, seq: raw.seq, code: 'seq_gap', message: `expected seq ${expectedSeq}, found ${raw.seq}` });
    if (raw.prevHash !== prevHash) issues.push({ line, seq: raw.seq, code: 'prev_hash_mismatch', message: 'prevHash does not link to the previous entry' });
    let computed: string | undefined;
    try { computed = hashAuditEntry(raw); } catch { computed = undefined; }
    if (computed !== raw.hash) issues.push({ line, seq: raw.seq, code: 'hash_mismatch', message: 'entry content was modified after it was written' });
    prevHash = raw.hash; expectedSeq = raw.seq + 1; lastSeq = raw.seq;
  }
  if (opts.expectedHead !== undefined && opts.expectedHead !== prevHash)
    issues.push({ line: rows.length, code: 'head_mismatch', message: 'last hash differs from the recorded head (log truncated or rewritten)' });
  if (opts.expectedCount !== undefined && opts.expectedCount !== count)
    issues.push({ line: rows.length, code: 'head_mismatch', message: `expected ${opts.expectedCount} entries, found ${count}` });
  return { ok: issues.length === 0, entries: count, head: prevHash, lastSeq, issues };
}

export interface AuditLogOptions { path?: string; now?: () => Date }

/** Append-only audit log. With `path`, every append is written synchronously to a JSONL file (O_APPEND).
 *  Single writer: one AuditLog instance per file. append() checks the file size first and throws if another writer
 *  appended in between. That is best-effort detection, not a lock: two processes racing can still fork the chain
 *  (verify will then report it). Use one writer process, or an OS file lock, for several workers. */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private head = GENESIS_HASH;
  private readonly path: string | undefined;
  private readonly now: () => Date;
  private bytes = 0;

  constructor(opts: AuditLogOptions = {}) {
    this.path = opts.path; this.now = opts.now ?? (() => new Date());
    if (this.path && existsSync(this.path)) {
      const text = readFileSync(this.path, 'utf8');
      const v = verifyHashChain(text);
      if (!v.ok) throw new Error(`refusing to append to a broken audit log ${this.path}: ${v.issues[0]!.code} at line ${v.issues[0]!.line}`);
      this.entries = text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as AuditEntry);
      this.head = v.head; this.bytes = Buffer.byteLength(text, 'utf8');
    }
  }

  append<D>(type: string, data: D): AuditEntry<D> {
    // store a JSON round-tripped copy: the caller cannot mutate history, and what we hash is exactly what is written
    const stored = JSON.parse(canonicalJson(data)) as D;
    const base = { seq: this.entries.length, ts: this.now().toISOString(), type, data: stored, prevHash: this.head };
    const entry: AuditEntry<D> = { ...base, hash: hashAuditEntry(base) };
    if (this.path) {
      const size = existsSync(this.path) ? statSync(this.path).size : 0;
      if (size !== this.bytes) throw new Error(`audit log ${this.path} changed on disk (another writer?); expected ${this.bytes} bytes, found ${size}`);
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.path, line, { encoding: 'utf8', flag: 'a' });
      this.bytes += Buffer.byteLength(line, 'utf8');
    }
    this.entries.push(entry); this.head = entry.hash;
    return structuredClone(entry);
  }

  /** Read-only snapshot (copies, so callers cannot mutate history). */
  all(): AuditEntry[] { return this.entries.map((e) => structuredClone(e)); }
  get headHash(): string { return this.head; }
  get length(): number { return this.entries.length; }
  verify(opts?: VerifyOptions): VerifyResult { return verifyHashChain(this.entries, opts); }
  toJsonl(): string { return this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : ''); }
}
