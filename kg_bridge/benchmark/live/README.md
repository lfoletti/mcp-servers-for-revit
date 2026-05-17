# Live A/B benchmark (real Claude Code usage)

Ground-truth complement to the offline modelled benchmark
(`../run_benchmark.py`). Drives the 5 scenario prompts through **real**
Claude Code sessions against two server profiles and reports the actual
token usage, turn count, wall-clock and cost reported by Claude Code.

> ⚠️ This makes **real, billable** Anthropic API calls (5 scenarios × 2
> profiles, multi-turn). `run_live.py` refuses to run without `--yes`.

## Why two profile directories

MCP tool availability is per-session. A clean A/B needs the kg_* tools
present in one run and absent in the other. So we use **two working dirs**,
each with a `.mcp.json` pointing at the *same built server* with a different
`KG_BENCH_MODE`:

- `bench-flat/.mcp.json` → `KG_BENCH_MODE=flat` (kg_* not registered; pure
  upstream baseline; sidecar never spawns)
- `bench-kg/.mcp.json`   → `KG_BENCH_MODE=kg` (baseline + the 6 kg_* tools)

These dirs live **outside** this repo (they hold machine-specific absolute
paths) — they are not part of the deliverable. This kit (prompts + runner)
is portable: profile dirs are arguments.

## Preconditions

1. Build the server once:
   ```
   cd server && npm install && npm run build
   ```
2. Approve the MCP server **interactively once per profile dir** (headless
   `-p` runs can only use an already-approved `.mcp.json` server):
   ```
   cd <bench-flat> && claude      # approve, run /mcp (expect 0 kg_* tools), exit
   cd <bench-kg>   && claude      # approve, run /mcp (expect 6 kg_* tools), exit
   ```
   Seeing the 6 `kg_*` tools only under `bench-kg` is itself the proof that
   the `KG_BENCH_MODE` gate works.

## Run

```
python kg_bridge/benchmark/live/run_live.py \
  --flat-dir  <abs path to bench-flat> \
  --kg-dir    <abs path to bench-kg> \
  --yes
```

(or set `KG_BENCH_FLAT_DIR` / `KG_BENCH_KG_DIR` instead of the flags.)

Options: `--no-reset` (keep persisted state between runs; default wipes
`KG_HOME` and the flat `revit-data.db` before each profile so the seed
starts clean), `--max-turns` (default 40, needed for S2/S4),
`--timeout` (s per scenario, default 600), `--claude` (path to the CLI).

Writes `out/live_results.{json,md}` (gitignored) and prints the table.

## What it measures

Per scenario, per profile: real `input_tokens`, `output_tokens`,
`num_turns` (≈ sequential round-trips), wall-clock seconds, `total_cost_usd`
— straight from Claude Code's `--output-format json`. Each scenario runs in
a **fresh** session (no conversation memory); project state persists on disk
between scenarios within a profile, so S1/S3/S5 genuinely exercise the
memory layer (`kg_*` vs `store_*_data`) rather than chat recall.

Interpret alongside `../../../BENCHMARK.md`: the offline harness gives exact,
assumption-free round-trip counts and modelled tokens; this gives the real
numbers but with API variance (rerun N times if you need confidence
intervals).
