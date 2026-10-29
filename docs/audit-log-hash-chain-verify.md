# Audit log: append-only, hash-chained JSONL with verify

Use when you need a tamper-evident (immutable in practice) audit log of what an agent did, and a CLI that proves it was not edited.

Source: [`src/gate/audit-log.ts`](../src/gate/audit-log.ts) · tests: [`test/audit-log.test.ts`](../test/audit-log.test.ts) · fixtures: [`fixtures/audit-logs/`](../fixtures/audit-logs/)

## Entry format (one JSON object per line)
```json
{"seq":5,"ts":"2026-10-29T12:00:06.000Z","type":"decision","data":{...},"prevHash":"<hash of seq 4>","hash":"<sha256>"}
```
`hash = sha256(canonicalJson({seq, ts, type, data, prevHash}))`; the first entry links to `GENESIS_HASH` (64 zeros).

```ts
const audit = new AuditLog({ path: 'audit.jsonl' }); // reopening verifies the file and refuses to append to a broken chain
audit.append('decision', entry);
verifyHashChain(fs.readFileSync('audit.jsonl', 'utf8'), { expectedHead: savedHead });
```

## Hash chain verify: what it detects
| tampering | issue code | fixture |
|---|---|---|
| entry content edited | `hash_mismatch` | `tampered-edited-entry.jsonl` |
| edited entry *and* its hash recomputed | `prev_hash_mismatch` on the next entry | test only |
| entry deleted | `seq_gap` + `prev_hash_mismatch` | `tampered-deleted-entry.jsonl` |
| entries reordered | `seq_gap` + `prev_hash_mismatch` | `tampered-reordered.jsonl` |
| tail truncated / whole chain rewritten | `head_mismatch` (needs `--head` or `--count`) | `tampered-truncated.jsonl` |
| corrupt line | `parse_error`, `bad_shape`, `empty_line` | `tampered-bad-json.jsonl` |

A hash chain alone cannot detect someone rewriting **every** entry from some point onward, or cutting off the tail. Anchor the head:
store `audit.headHash` somewhere the agent cannot write (a separate DB, a signed checkpoint, a git commit) and verify with `--head`.

## Single writer
One `AuditLog` instance per file. Before each append it checks the file size it last wrote; if another process appended in between,
`append()` throws (`changed on disk`) instead of forking the hash chain. This is best-effort detection, not a lock: two processes racing
in the same millisecond can still fork the chain, which `verify` then reports. Several workers should send entries to one writer process.

## CLI
```bash
agent-action-gate verify fixtures/audit-logs/valid.jsonl                   # OK 6 entries, head ae67…   (exit 0)
agent-action-gate verify fixtures/audit-logs/tampered-deleted-entry.jsonl  # TAMPERED … line 4 seq 4: seq_gap (exit 1)
agent-action-gate verify audit.jsonl --head "$(cat head.txt)" --json
```
Regenerate fixtures deterministically with `npm run fixtures`.
