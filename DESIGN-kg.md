# Design — a Knowledge Graph as project memory for the Revit MCP server

## The gap this addresses

The server already has a persistence layer: `store_project_data`,
`store_room_data`, `query_stored_data`, backed by SQLite (`database/db.ts`,
`service.ts`) — flat `projects` / `rooms` tables plus a JSON `metadata` blob.

That is a **passive scratchpad**. It cannot represent:

- **Topology** — "which openings are hosted by which walls on level N0", "what
  is the type of this wall" — relations are first-class in a model, absent in
  flat rows.
- **History** — "what changed since the agent last looked". Rows are
  overwritten in place; the previous value is gone.
- **Lifecycle** — a deleted element is `DELETE FROM`; there is no soft state,
  no undo, no "it existed until turn N".
- **Atomicity across a batch** — `storeRoomsBatch` is wrapped in a SQLite
  transaction, but project state mutated across *several* tool calls (the
  normal agent loop) has no all-or-nothing boundary.
- **Drift** — if the user edits the model by hand, the flat store has no way to
  notice it diverged.

These are exactly the things an agent needs to operate on a building model
across many turns without re-reading the whole model every time.

## What a KG adds

| Capability | `store_*_data` (flat) | ProjectKG (this PoC) |
|---|---|---|
| Typed, schema-validated entities | metadata blob | `NODE_TYPES` (Wall, Level, Door, …) enforced |
| Relations | — | typed edges (`at_level`, `is_type`, `hosts`, `bounded_by`, …) |
| Change history | overwrite in place | action-grained log, `diff_since(turn)` |
| Delete semantics | hard `DELETE` | soft-delete (`deleted_at_turn`), reversible |
| Batch atomicity | per-call only | `transaction()` snapshot/rollback over a whole batch |
| Cross-session | per row | full graph persisted as `<project_id>.kg.json` |
| Drift detection | impossible | diff KG vs a fresh model read |

The PoC proves every row of the right-hand column **offline** (see
`DEMO.md` / `smoke_test.py`).

## Why reuse, not reimplement

The KG here is `kg_bridge/vendor/project_kg.py`, a **byte-for-byte copy** of the
production module from the *claude-in-revit* agent (a PyRevit + Anthropic-API
agent that keeps this graph as a first-class mirror of the Revit model). It has
821 passing tests upstream. Reimplementing it in TypeScript for the PoC would
fork the semantics and double the maintenance; vendoring keeps one source of
truth and lets the PoC prove the value *today*. The only new code is the
sidecar (`kg_sidecar.py`, ~250 lines of glue) and the TS client/tools that
follow the repo's existing tool convention.

## Architecture

```
MCP client ── stdio ──► MCP server (TS)
                          │  server/src/tools/kg_*.ts   (repo convention)
                          │  server/src/kg/bridge.ts     (singleton spawner)
                          ▼  child process, JSON-lines stdio
                        kg_sidecar.py
                          ▼  imports, unmodified
                        vendor/project_kg.py  ──►  <project_id>.kg.json
```

This is the same shape as the flat path (`tools/store_project_data.ts` →
`database/service.ts` → SQLite). The KG path simply has a richer service behind
it. **No Revit and no WebSocket are involved in Stage 1** — the graph is
exercised on its own, which is why the whole thing runs on a laptop.

## Stage 2 — the Revit-coupled guarantee (`@kg_synced`)

Stage 1 proves the KG half of atomicity (a failed batch rolls the graph back
cleanly). The production system goes further with a decorator, `@kg_synced`,
that pairs a **Revit transaction** with the KG mutation: open Revit Tx → mutate
Revit → mutate KG → commit; if either side fails, **roll back both**. The model
and the project memory can never silently diverge.

In *this* server's architecture that contract spans the WebSocket boundary. The
sketch (not implemented in this PoC):

1. A Revit-bound command (e.g. the existing `create_level`) is wrapped so that,
   on a **successful** Revit transaction, the C# command set reports the
   resulting element back; the server records it in the KG via the sidecar.
2. On a **failed** Revit transaction, no KG write is emitted (or a compensating
   KG rollback is, mirroring `transaction()`).
3. A new `kg_detect_drift` tool diffs the KG against a fresh
   `get_current_view_elements` to surface out-of-band manual edits — something
   the flat store fundamentally cannot do.

This is deliberately deferred: it needs a live Revit + the C#/WebSocket loop,
and is only worth building once Stage 1's value is accepted.

## Upstream integration paths

Ordered from lowest to highest commitment:

1. **Additive sidecar (this PoC).** Coexists with `store_*_data`. Zero changes
   to the core. Cost: Python + `networkx` alongside Node.
2. **Faithful TypeScript port of `project_kg.py`.** Single runtime, no Python,
   directly mergeable; the vendored file is the spec. Cost: a port + keeping it
   in step with the reference implementation.
3. **Make existing tools KG-aware.** `get_material_quantities`,
   `analyze_model_statistics`, `ai_element_filter` could answer from the graph
   instead of round-tripping Revit each call — a latency/token win even before
   any new feature.
4. **KG as the substrate for higher-order features.** CAD/DXF import
   reconciliation, model audits, code-compliance checking — all need a typed,
   historized model mirror. The flat store cannot carry them; the KG is built
   for exactly this in the source project.

## Non-goals & honest caveats

- Stage 1 is **memory**, not Revit mutation. No element is created in Revit by
  the `kg_*` tools.
- **Polyglot runtime** is a real cost of path (1); path (2) removes it.
- `project_kg.py` persists Revit `ElementId`s with the documented caveat (the
  Revit API discourages persisting them across sessions; the source project
  reconciles via a full rescan at session start). Irrelevant to Stage 1, noted
  for Stage 2.
- The PoC "turn == one MCP op" simplification is in the sidecar only; the
  vendored KG is untouched.
