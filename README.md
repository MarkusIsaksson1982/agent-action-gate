# agent-action-gate

A small, dependency-free **strict TypeScript** gate between an LLM agent and a backend that acts on its behalf –
with a fullstack web-operations demo (node:http API + TypeScript frontend) on top.
The agent proposes an action (tool + JSON args + rationale + idempotency key); the gate decides:

| decision | when | HTTP (Lambda-style `handler`) |
|---|---|---|
| `duplicate` | idempotency key already accepted (agent retries are safe) | 200 |
| `reject` | typed errors: unknown tool, role not allowed, missing/unknown field, wrong type, out of range, pattern mismatch, over hard limit, empty rationale | 422 |
| `needs_approval` | valid, but the amount is above the tool's approval threshold → a human signs off | 202 |
| `execute` | valid and within limits | 200 |

Every decision is appended to a **hash-chained audit log** (`verifyLog` returns the first tampered index), and `evaluate` replays
recorded agent proposals against expected decisions, counting **unsafe executes** (the metric that matters most).

Why: in an agentic-first backend the model is one step in a pipeline; the deterministic parts around it (schemas, limits,
idempotency, approval, audit) decide whether that is safe. Typed errors can be fed back to the agent for a bounded retry.

```bash
npm i -D typescript @types/node   # only dev dependencies
npx tsc -p . && node --test dist/test/ && node dist/src/demo.js
```

## v0.2: fullstack web-operations demo
`npm start` → http://localhost:8787 – a TypeScript frontend (no framework) and a JSON API on `node:http`:

| route | what it does |
|---|---|
| `POST /api/proposals` | an agent's proposal (SEO meta edit, ad-budget change, CMS draft) goes through the gate; `needs_approval` ones are queued |
| `GET /api/pending`, `POST /api/approvals` | a human approves or denies; an agent can never approve its own proposal (403), double decisions → 409 |
| `GET /api/audit` | hash-chained audit log + integrity check |
| `POST /api/track` | **tracking guard** for GA4-style dataLayer events: consent required, naming rules, reserved names, ≤25 params, ≤100-char values, **no personal data** (e-mail, Swedish phone numbers, personnummer) |
| `POST /api/vitals` | rates Core Web Vitals (LCP, INP, CLS) against Google's good / needs-improvement / poor thresholds |

Policy in the demo: SEO agents may edit titles (10–60 chars) and meta descriptions (50–160); growth agents may change ad budgets, above 1,000/day
a human signs off and above 10,000/day it is rejected; content agents may only save CMS **drafts** – publishing stays with a person.
Request bodies are capped at 64 KB (413). Everything is in memory.

- `src/server.ts` – API + static frontend · `src/tracking.ts` – tracking guard + vitals rating · `web/app.ts`, `web/index.html` – frontend
- `test/server.test.ts`, `test/tracking.test.ts` – end-to-end API test on a random port + tracking/vitals tests (10 node:test tests in total)

- `src/action-gate.ts` – the gate (validateProposal, decide, appendEvent, verifyLog, handler, evaluate)
- `test/action-gate.test.ts` – 6 node:test tests for the gate (`tsc --strict`)
- `src/demo.ts` – synthetic replay of ten recorded proposals

All data is synthetic; this is a demonstration of approach, not a production system. Built with an agentic workflow
(spec → hidden tests → free/local models in a sandbox → `tsc --strict` + tests → human review). MIT licence.
