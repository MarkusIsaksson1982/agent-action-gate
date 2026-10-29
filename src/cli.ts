#!/usr/bin/env node
// agent-action-gate CLI
//   verify <audit.jsonl> [--head <hash>] [--count <n>] [--json]   verify the audit log hash chain (exit 0 ok, 1 tampered, 2 usage)
//   check  <policy.json> <call.json> [--json]                      policy check before a tool call (prints allow/deny/require_approval)
//   lint   <policy.json>                                           validate a policy file
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyHashChain, loadPolicy, approvalGate, PolicyError, type ToolCall } from './gate/index.js';

export interface CliIo { out: (s: string) => void; err: (s: string) => void }

function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

export function runCli(argv: string[], io: CliIo = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }): number {
  const [cmd, ...rest] = argv; const json = rest.includes('--json');
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--head', '--count'].includes(rest[i - 1]!)));
  try {
    if (cmd === 'verify' && pos[0]) {
      const head = flag(rest, '--head'); const count = flag(rest, '--count');
      if ((rest.includes('--head') && !/^[0-9a-f]{64}$/.test(head ?? '')) || (rest.includes('--count') && !/^[0-9]+$/.test(count ?? ''))) {
        io.err('--head needs a 64-char hex hash and --count a non-negative integer'); return 2;
      }
      const r = verifyHashChain(readFileSync(pos[0], 'utf8'), { ...(head ? { expectedHead: head } : {}), ...(count ? { expectedCount: Number(count) } : {}) });
      if (json) io.out(JSON.stringify(r));
      else if (r.ok) io.out(`OK ${r.entries} entries, head ${r.head}`);
      else { io.out(`TAMPERED ${r.issues.length} issue(s) in ${r.entries} entries`); for (const i of r.issues) io.out(`  line ${i.line}${i.seq !== undefined ? ` seq ${i.seq}` : ''}: ${i.code} - ${i.message}`); }
      return r.ok ? 0 : 1;
    }
    if (cmd === 'check' && pos[0] && pos[1]) {
      const policy = loadPolicy(JSON.parse(readFileSync(pos[0], 'utf8')));
      const call = JSON.parse(readFileSync(pos[1], 'utf8')) as ToolCall;
      if (!call || typeof call.tool !== 'string' || typeof call.agent !== 'string' || !call.args || typeof call.args !== 'object') {
        io.err('call.json must be {"tool": string, "agent": string, "role"?: string, "args": object}'); return 2;
      }
      const d = approvalGate(policy, call);
      io.out(json ? JSON.stringify(d) : `${d.effect}${d.decidingRules.length ? ' [' + d.decidingRules.join(', ') + ']' : ''}: ${d.reasons.join('; ')}`);
      return d.effect === 'allow' ? 0 : d.effect === 'require_approval' ? 3 : 4;
    }
    if (cmd === 'lint' && pos[0]) { const p = loadPolicy(JSON.parse(readFileSync(pos[0], 'utf8'))); io.out(`OK ${p.rules.length} rules`); return 0; }
  } catch (e) {
    io.err(e instanceof PolicyError ? `invalid policy: ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`); return 2;
  }
  io.err('usage: agent-action-gate verify <audit.jsonl> [--head H] [--count N] [--json] | check <policy.json> <call.json> [--json] | lint <policy.json>');
  return 2;
}

const isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) process.exitCode = runCli(process.argv.slice(2));
