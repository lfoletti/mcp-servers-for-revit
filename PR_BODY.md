# Proposal — graph-backed project memory (Knowledge Graph) for mcp-servers-for-revit

*Suggested as a **GitHub Discussion / proposal** rather than a bare PR: it
adds an optional capability and the repo has no contributing guide, so a
conversation is more useful than a drive-by PR. Everything is on the branch
`feat/kg-memory-poc`; nothing in the upstream core is modified.*

## TL;DR

- Adds an **optional, additive** project-memory layer: a typed, historized,
  atomic **Knowledge Graph**, exposed as `kg_*` MCP tools **alongside** the
  existing `store_*_data` — not replacing anything.
- **Zero changes to the upstream core** (server core, command set, plugin).
  The tools + a mode gate live only in new files and are picked up by the
  existing `server/src/tools/register.ts` auto-discovery.
- On **15 deterministic BIM case studies**, scored against the *persisted
  state* (not the model's prose): the KG profile is **15/15 correct**; the
  flat `store_*_data` baseline returned a confident but **false "done" on
  8/15** (it cannot represent walls/windows/relations). Effective cost per
  *correct* task: flat **$1.71** vs KG **$0.54**.
- Honest about scope, polyglot cost, and measurement caveats (below).

## Why

Persistence today is `store_*_data` → SQLite `projects`/`rooms`. With Revit
live the agent operates on the model **directly** via the C# commands each
turn (no memory); the DB is a flat scratchpad that **cannot mirror a BIM
model**. So across turns the agent has no typed, queryable, historized
memory of the building. The KG is exactly that substrate.

## What this is / isn't

- **Is:** a memory layer (Stage 1, no Revit). Typed nodes/edges,
  action-grained history (`diff_since`), soft-delete lifecycle, atomic
  transactions (snapshot/rollback), bulk + **select-and-mutate**
  (`kg_modify_where`), compact returns.
- **Isn't:** a change to Revit operations. The C# command set is **already
  batch-shaped** (every `create_*` takes a `List<…>`) — nothing to add
  there. The single-vs-bulk economy is shown where this PoC actually
  contributes: the memory layer.
- **Reuses, doesn't reimplement:** vendors the real, 821-test `project_kg.py`
  from the *claude-in-revit* project **verbatim** behind a ~250-line stdio
  sidecar. One source of truth, value provable today.

## Evidence (see `BENCHMARK.md`, reproducible)

Three measured proofs, each with stated caveats:

1. **Capability / trust** — 15 case studies; `verify.py` scores each against
   persisted state + a claim↔state verdict {correct | honest_incomplete |
   fabricated}. KG **15/15 correct**; flat **6 correct / 1 honest-incomplete
   / 8 fabricated**. $/correct: flat **$1.71** vs KG **$0.54**. Where flat is
   capable (room scenarios, in-domain for `store_*_data`) it scores
   **correct** — the comparison is not rigged; KG is still ~25–40 % cheaper
   there.
2. **Bulk economy scales** — N=10→20, round-trip ratio **3.6× → 4.3×**
   (widens with N).
3. **`kg_modify_where` vs query+loop** — N=30, *same correct end state*:
   **turns ×3.0**, **cost −31 %**.

Controlling fact the run established: with prompt caching the **input is
cache-cheap; output + round-trips dominate the bill**. That is *why* the KG
wins (server-side compute, fewer turns, terse returns) — measured, not
asserted.

## Architecture (additive)

```
MCP client ─ stdio ─► server (TS)
                        tools/kg_*.ts      (repo convention, auto-discovered)
                        kg/bridge.ts       (singleton spawner)
                        ▼ child process, JSON-lines
                      kg_sidecar.py ─► vendor/project_kg.py ─► <project>.kg.json
```

Same shape as `store_project_data → database/service.ts`. No Revit, no
WebSocket in Stage 1. The `KG_BENCH_MODE` gate (`flat` / `kg` / `kg-many`)
lives only in the `kg_*` modules — flip it to A/B-benchmark with no core
change (`BENCHMARK.md` → "Run it yourself").

## Honest caveats

- **Polyglot:** Stage 1 needs Python + `networkx` next to Node. A
  single-runtime merge endgame = a faithful TS port of the vendored file
  (which is the spec). The sidecar is the fast way to prove the value first.
- The flat **"fabricated"** verdicts are contingent on BIM tasks (out of
  `store_*_data`'s domain). The defensible claim is *"for BIM project
  memory the flat layer doesn't merely limit, it fabricates"* — **not**
  "flat is bad". On in-domain rooms it is scored correct.
- Single live run → API variance on the **dollar** figures; the **verdicts**
  and **turn counts** are robust (a binary capability gulf).
- Stage 1 is **memory only** — no Revit element is mutated by `kg_*`.

## Stage 2 (sketched, deliberately deferred)

`@kg_synced` across the WebSocket boundary: a Revit command's *successful*
transaction → KG write; failure → no write (or a compensating rollback) — the
model and the project memory never silently diverge. Plus `kg_detect_drift`
(KG vs a fresh `get_current_view_elements`) to surface out-of-band hand
edits. Needs live Revit + the C# loop; only worth building once the Stage-1
value is accepted. Full sketch in `DESIGN-kg.md`.

## What we're asking

1. Is a graph-backed memory layer of interest to the project?
2. For an initial integration, is the **Python sidecar** acceptable, or is a
   **TypeScript port** of the vendored KG required?
3. Appetite for Stage 2 (Revit-coupled atomicity + drift)?

Try it with no Revit and no API cost: `DEMO.md` (offline smoke) and
`BENCHMARK.md` (numbers + how to reproduce, incl. exact token counts via the
`count_tokens` recipe).

## Branch layout

`feat/kg-memory-poc` — additive only:
`kg_bridge/` (sidecar + vendored `project_kg.py` + benchmark/verify kit),
`server/src/kg/` + `server/src/tools/kg_*.ts`, and the docs
`DEMO.md` / `DESIGN-kg.md` / `BENCHMARK.md`. Upstream files untouched
(verified: every commit is `A`/additive except the doc and `.gitignore`).
