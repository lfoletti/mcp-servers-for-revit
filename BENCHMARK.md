# Benchmark — Knowledge Graph vs flat `store_*_data`

Goal: quantify, with fine-grained input/output token and completion-time
figures, what graph-backed project memory buys an agent over the existing
flat SQLite tools (`store_project_data`, `store_room_data`,
`query_stored_data`).

This document leads with the numbers that are **exact** and lets the modelled
numbers refine — not carry — the argument.

## Methodology (read this before the numbers)

| Metric | Status | How obtained |
|---|---|---|
| Sequential model completions (round-trips) | **Exact** | counted from the interaction structure; tokenizer- and assumption-independent. The dominant driver of wall-clock. |
| Tool-call count & kind | **Exact** | counted from the plan. |
| Context byte size | **Exact** | the payloads are real (KG side comes from the actual vendored ProjectKG via the sidecar). |
| Input / output **tokens** | **Modelled** | `tokencount.py`, self-reporting its backend (see below). |
| Completion **seconds** | **Modelled** | transparent latency model; every parameter printed and env-overridable. |

**Token backend, in priority order** (each run prints which one it used):

1. `anthropic_count_tokens(exact)` — exact Claude tokens via the Anthropic
   `messages.count_tokens` endpoint. Requires `ANTHROPIC_API_KEY`. This is a
   *counting* call: it produces no model output, so it does **not** incur
   generation spend.
2. `tiktoken_cl100k(proxy)` — stable BPE proxy if `tiktoken` is installed.
3. `heuristic(estimate)` — structural estimator. **This is what produced the
   tables below** (offline authoring machine, no key, no `tiktoken`).

Because both architectures are tokenised with the *same* backend, the
**architecture-to-architecture ratio is robust** even when absolute counts
drift with the tokenizer. To get exact absolute Claude tokens, see
[§ Exact measurement](#exact-measurement).

**Latency model:** `T = Σ_completions (TTFT + out_tokens/TPS) + Σ_tools t_exec`.
Defaults (overridable via env, printed in every run):
`TTFT=0.6 s`, `TPS=55 tok/s`, `t_exec(kg/sqlite/revit)=0.01/0.005/0.30 s`,
nominal output per step `=150 tok` (identical for both approaches, so it
cancels in the delta — only structure drives the gap).

**Conservative bias:** the flat-store element dump shape is deliberately
modest (id/category/type/level/params). Real Revit dumps are larger, so the
KG advantage is *understated*, not inflated. History tokens common to both
approaches are excluded to isolate the differentiator (the state/delta
portion of context).

## The five scenarios

| # | Isolates | Flat-store mechanism | KG mechanism |
|---|---|---|---|
| **S1** what-changed | absence of a change log | re-pull full model state into context to locate the change | `kg_diff_since(turn)` → delta actions only |
| **S2** 10-turn session | compounding context cost | full state re-enters context every turn | turn 0 snapshot, turns 1..N `diff_since` only |
| **S3** structural query (windows hosted by walls on N0) | absence of relations | 3 sequential category retrievals (windows, walls, levels) + in-prompt join | one `kg_query` typed-subgraph traversal, server-side |
| **S4** atomic batch, op #4 invalid | absence of cross-call transaction | 3 partial elements committed, then inspect + delete-each recovery | single transaction, rolls back cleanly, zero recovery |
| **S5** out-of-band edit (drift) | absence of drift detection | undetectable → N wasted turns on stale state (assumption) | one diff/query surfaces it immediately |

## Results (measured, this PoC)

Token method **`heuristic(estimate)`**. Latency model defaults as above.
Exact columns (completions, tool calls) are assumption-free. Regenerate with
`python kg_bridge/benchmark/run_benchmark.py --scale N`.

### Scale 1 (~88 elements: 2 levels × 20 walls × 10 windows × 4 rooms + 6 types)

| Scenario | Approach | in tok | out tok | seq. compl. | tools kg/sql/revit | modelled s |
|---|---|--:|--:|--:|--:|--:|
| S1 what-changed | flat | 5 185 | 150 | 1 | 0/0/1 | 3.63 |
| S1 what-changed | **kg** | **219** | 150 | 1 | 1/0/0 | **3.34** |
| S1 — flat/kg | | **×23.7** | | +0 | | ×1.09 |
| S2 multiturn ×10 | flat | 51 850 | 1 500 | 10 | 0/0/0 | 33.27 |
| S2 multiturn ×10 | **kg** | **11 156** | 1 500 | 10 | 0/0/0 | 33.27 |
| S2 — flat/kg | | **×4.65** | | +0 | | ×1.0 |
| S3 structural-query | flat | 4 413 | 600 | 4 | 0/0/3 | 14.21 |
| S3 structural-query | **kg** | 4 170 | 150 | **1** | 1/0/0 | **3.34** |
| S3 — flat/kg | | ×1.06 | | **+3** | | **×4.26** |
| S4 atomic-batch | flat | 172 | 1 200 | 8 | 0/0/8 | 29.02 |
| S4 atomic-batch | **kg** | 30 | 300 | **2** | 1/0/0 | **6.67** |
| S4 — flat/kg | | ×5.73 | | **+6** | | **×4.35** |
| S5 drift | flat | 15 555 | 450 | 3 | 0/0/0 | 9.98 |
| S5 drift | **kg** | **11** | 150 | 1 | 1/0/0 | **3.34** |
| S5 — flat/kg | | ×1414 | | +2 | | ×2.99 |

### Scale 5 (~440 elements) — shows which gaps grow with model size

| Scenario | flat/kg in-tok | Δ completions | flat/kg modelled s |
|---|--:|--:|--:|
| S1 what-changed | **×110** | +0 | ×1.09 |
| S2 multiturn ×10 | ×5.0 | +0 | ×1.0 |
| S3 structural-query | ×1.04 | **+3** | **×4.26** |
| S4 atomic-batch | ×5.73 | **+6** | **×4.35** |
| S5 drift | ×6576 | +2 | ×2.99 |

(S4 is batch-size-bound by design, so it does not scale with the model; S1/S2/S5
scale with model size because the flat side is O(model) while the KG side is
O(changes).)

## Interpretation

- **Token/cost wins** concentrate in **S1, S2, S5**. S1 is the headline: the
  flat cost is O(model size) (re-read everything to know what changed) while
  the KG cost is O(changes) — the ratio *grows* from ×24 to ×110 between
  scale 1 and 5. On a real project this widens further.
- **Latency/round-trip wins** concentrate in **S3 and S4**. S3 makes the
  relational point honestly: the token sizes are similar (same data must
  exist somewhere), but the flat agent needs **+3 sequential round-trips**
  (gather each side, join in-prompt) where the KG does one server-side
  traversal → **×4.3 modelled time**. S4 adds **+6 completions** of manual
  recovery the KG transaction removes entirely.
- **S2** is the pure-economy case: *same* completions and *same* modelled
  time as flat, but ~5× fewer input tokens — the value is entirely token
  cost, which is exactly the multi-turn agent loop.
- **S4** also wins on **correctness**: the flat path leaves a corrupt partial
  model (3 orphan elements) if recovery is imperfect; the KG path cannot.
- **S5** is presented as an *illustrative bound*, not a measurement: the
  ×1414/×6576 is dominated by the `wasted_turns=3` assumption and the payload
  asymmetry. The defensible claim is qualitative — flat **cannot** detect
  drift; the KG detects it in one query — with the magnitude parameterised.

## Threats to validity (stated, not hidden)

1. **Token absolutes are estimates** offline. Ratios are tokenizer-robust;
   absolutes need the exact backend (next section).
2. **S5 magnitude is assumption-driven** (`KG_BENCH_DRIFT_WASTED`, default 3).
   Treat S5 as "flat = undetectable; KG = O(1)", not as "×1414".
3. **Latency is modelled.** The exact, assumption-free latency signal is the
   completion-count delta; seconds depend on `TTFT/TPS/t_exec`. Ground-truth
   wall-clock requires instrumenting a real MCP session (not done here).
4. **Flat dump is modest** → conservative; a fuller Revit dump widens the gap.
5. **History excluded** to isolate the state/delta differentiator; in a real
   session shared history adds the *same* cost to both, so the *delta* holds.

## Exact measurement

To replace the estimated token columns with **exact Claude token counts**
(a counting call — no generation spend):

```bash
export ANTHROPIC_API_KEY=...        # your key; only count_tokens is called
python kg_bridge/benchmark/run_benchmark.py --scale 1
# token method line will read: anthropic_count_tokens(exact)
```

`tokencount.py` auto-detects the key and switches backend; nothing else
changes. The harness never spends generation tokens and never touches the key
beyond the `count_tokens` call.

## Run it yourself in a real client (A/B by server profile)

This gives you ground-truth `usage` (real input/output tokens) and wall-clock,
measured by your own MCP client — the rigorous A/B.

**One build, three server profiles**, selected by `KG_BENCH_MODE`:

- `KG_BENCH_MODE=flat` → the kg_* tools are **not registered** (pure upstream
  baseline; the sidecar never spawns).
- `KG_BENCH_MODE=kg` (or unset) → baseline **+** the kg_* tools (single-element
  ops only).
- `KG_BENCH_MODE=kg-many` → baseline + kg_* **+** the `_many` bulk variants
  (`kg_add_elements_many`, `kg_modify_elements_many`): N elements in one
  atomic call / one round-trip.

The gate lives only in the additive kg_* modules — zero change to the
upstream core. Declare **three entries** in the client config (Claude Desktop
`claude_desktop_config.json` shown; same shape for Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "revit-flat":    { "command": "node", "args": ["ABS/server/build/index.js"],
      "env": { "KG_BENCH_MODE": "flat" } },
    "revit-kg":      { "command": "node", "args": ["ABS/server/build/index.js"],
      "env": { "KG_BENCH_MODE": "kg",      "KG_PYTHON": "python",
               "KG_HOME": "ABS/.kg-bench" } },
    "revit-kg-many": { "command": "node", "args": ["ABS/server/build/index.js"],
      "env": { "KG_BENCH_MODE": "kg-many", "KG_PYTHON": "python",
               "KG_HOME": "ABS/.kg-bench-many" } }
  }
}
```

**On bulk and the original C# command set (scope honesty):** the upstream
Revit commands in `commandset/Commands` are *already* batch-shaped — every
`create_*` takes a `List<…Info>`, `delete_element` a `string[]`. Upstream
already follows the bulk-variant policy on the Revit side; there is nothing
to "add a `_many` to" there. The single-vs-bulk economy is therefore
benchmarked where this PoC actually contributes — the **KG memory layer**
(`kg` vs `kg-many`) — which is also the only part measurable offline without
Revit. The Revit-side bulk economy already exists upstream and would only be
an *agent-usage* measurement (loop vs batch) under live Revit (Stage 2).

**Protocol** — for each scenario, run the *same* prompt in a *fresh*
conversation against `revit-flat`, then against `revit-kg`, with the *same*
model; record the input/output tokens and latency your client/API reports;
compare. In `revit-kg`, add "use the kg_* tools to track project state" (the
upstream store_*_data tools are still present and the model must be told to
prefer the graph — see the methodology caveat).

**No-Revit prompt set** (memory layer only — store_*_data vs kg_*; no Revit
licence needed). This also surfaces a *representational* gap: store_*_data can
only hold projects/rooms, so it physically cannot answer S3.

- **Seed** — "Project 'Demo': levels N0 (elev 0) and N1 (elev 3); wall type
  GEN_200 (thickness 0.2); 20 walls on N0 of GEN_200; 8 windows hosted on
  them."
- **S1** — "What changed since the seed?"
- **S2** — repeat a small edit ("raise wall k height by 0.1") for 10 turns,
  each followed by "summarise the current state".
- **S3** — "Which windows are on level N0 and which wall hosts each?"
- **S4** — "Add 5 levels; the 4th has an invalid elevation; keep the model
  consistent (all-or-nothing)."
- **S5** — after the seed, "I changed something by hand — detect and
  reconcile."
- **S6** (bulk) — "set the sill of ALL windows to 0.8 m". The differentiator:
  `kg` loops `kg_modify_element` (≥ N round-trips); `kg-many` does one
  `kg_modify_elements_many` (1 round-trip). Quantifies the bulk-variant
  economy in the contributed layer.

For the **Revit-augmented** variant (adds `get_current_view_elements` etc. on
the flat side), run the same prompts with a model open in Revit and the
plugin connected; this matches the modelled scenarios more closely but needs
the full stack.

## Reproduce

```bash
python -m pip install -r kg_bridge/requirements.txt
python kg_bridge/benchmark/run_benchmark.py --scale 1     # then --scale 5
# writes kg_bridge/benchmark/out/benchmark_results.{json,md}
```

Override the model: `KG_BENCH_TTFT`, `KG_BENCH_TPS`,
`KG_BENCH_TEXEC_{KG,SQLITE,REVIT}`, `KG_BENCH_OUT_TOKENS`,
`KG_BENCH_DRIFT_WASTED`, `KG_BENCH_MODEL`.

See `DESIGN-kg.md` for *why* the KG enables this and the Revit-coupled
Stage 2; this document only measures the Stage 1 memory layer.
