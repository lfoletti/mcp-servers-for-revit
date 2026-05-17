#!/usr/bin/env python3
"""run_benchmark.py — execute the KG vs flat-store scenarios and report
fine-grained input/output tokens, round-trips, and a modelled completion time.

    python kg_bridge/benchmark/run_benchmark.py [--scale N]

Outputs:
  * a table on stdout
  * benchmark_results.json  (machine-readable)
  * benchmark_results.md    (drop-in for BENCHMARK.md)

EXACT (assumption-free): round-trip / sequential-completion counts, tool-call
counts, context byte sizes.
MODELLED: token counts (method self-reported, see tokencount.py) and seconds
(transparent latency model; every parameter is printed and overridable by env).

Set ANTHROPIC_API_KEY to get EXACT Claude token counts via the count_tokens
endpoint (a counting call — it does not generate, so no generation spend).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from harness import (  # noqa: E402
    Bridge, Plan, SCENARIOS, build,
)
from tokencount import count  # noqa: E402

# --- latency model parameters (printed + overridable) --------------------
TTFT = float(os.environ.get("KG_BENCH_TTFT", "0.6"))          # s, time-to-first-token
TPS = float(os.environ.get("KG_BENCH_TPS", "55"))             # output tokens/s
TEXEC = {
    "kg": float(os.environ.get("KG_BENCH_TEXEC_KG", "0.01")),
    "sqlite": float(os.environ.get("KG_BENCH_TEXEC_SQLITE", "0.005")),
    "revit": float(os.environ.get("KG_BENCH_TEXEC_REVIT", "0.30")),
}


def eval_plan(plan: Plan) -> dict:
    in_tok = 0
    out_tok = 0
    n_completions = 0
    tool_calls = {"kg": 0, "sqlite": 0, "revit": 0, "other": 0}
    method = ""
    seconds = 0.0
    for s in plan.steps:
        if s.ctx_in:
            c, method = count(s.ctx_in)
            in_tok += c
        if s.kind == "completion":
            n_completions += 1
            out_tok += s.out_tokens
            seconds += TTFT + s.out_tokens / TPS
        else:  # tool
            kind = s.exec_kind or "other"
            tool_calls[kind] = tool_calls.get(kind, 0) + 1
            seconds += TEXEC.get(kind, 0.05)
    return {
        "approach": plan.approach,
        "input_tokens": in_tok,
        "output_tokens": out_tok,
        "sequential_completions": n_completions,
        "tool_calls": tool_calls,
        "modelled_seconds": round(seconds, 3),
        "token_method": method or "n/a",
        "note": plan.note,
    }


def main() -> int:
    try:  # console safety: never crash the run on a non-UTF-8 terminal
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--scale", type=int, default=1,
                    help="building size multiplier (default 1)")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="kg_bench_"))
    bridge = Bridge(tmp)
    results = []
    try:
        fx = build(bridge, scale=args.scale)
        for sc in SCENARIOS:
            plans = sc(bridge, fx)
            by = {p.approach: eval_plan(p) for p in plans}
            name = plans[0].name
            flat, kg = by["flat"], by["kg"]

            def ratio(a, b):
                return round(a / b, 2) if b else float("inf")

            results.append({
                "scenario": name,
                "flat": flat,
                "kg": kg,
                "input_token_ratio_flat_over_kg":
                    ratio(flat["input_tokens"], kg["input_tokens"]),
                "completions_flat_minus_kg":
                    flat["sequential_completions"]
                    - kg["sequential_completions"],
                "seconds_ratio_flat_over_kg":
                    ratio(flat["modelled_seconds"], kg["modelled_seconds"]),
            })
    finally:
        bridge.close()

    token_method = results[0]["kg"]["token_method"] if results else "n/a"
    meta = {
        "scale": args.scale,
        "token_method": token_method,
        "latency_model": {
            "ttft_s": TTFT, "output_tps": TPS, "tool_exec_s": TEXEC,
            "nominal_out_tokens_per_step":
                int(os.environ.get("KG_BENCH_OUT_TOKENS", "150")),
        },
        "exact_metrics": ["sequential_completions", "tool_calls"],
        "modelled_metrics": ["input_tokens(method above)",
                             "output_tokens", "modelled_seconds"],
    }

    out = {"meta": meta, "results": results}
    out_dir = HERE / "out"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "benchmark_results.json").write_text(
        json.dumps(out, indent=2), encoding="utf-8")

    # --- human table ---
    lines = []
    lines.append("# Benchmark results (generated)\n")
    lines.append("Token method: **{}**  |  scale: {}  |  "
                 "latency model: TTFT={}s, {} tok/s, "
                 "tool_exec(kg/sqlite/revit)={}/{}/{}s, "
                 "nominal out/step={}\n".format(
                     token_method, args.scale, TTFT, TPS,
                     TEXEC["kg"], TEXEC["sqlite"], TEXEC["revit"],
                     meta["latency_model"]["nominal_out_tokens_per_step"]))
    lines.append("\n_Exact (assumption-free): sequential completions & tool "
                 "calls. Modelled: tokens & seconds._\n")
    hdr = ("| Scenario | Approach | in tok | out tok | seq. completions "
           "| tool calls (kg/sql/revit) | modelled s |")
    sep = "|---|---|--:|--:|--:|--:|--:|"
    lines += ["", hdr, sep]
    for r in results:
        for ap_ in ("flat", "kg"):
            d = r[ap_]
            tc = d["tool_calls"]
            lines.append("| {} | {} | {} | {} | {} | {}/{}/{} | {} |".format(
                r["scenario"], ap_, d["input_tokens"], d["output_tokens"],
                d["sequential_completions"],
                tc["kg"], tc["sqlite"], tc["revit"], d["modelled_seconds"]))
        lines.append("| **{}** | **flat/kg ratio** | **x{}** |  | "
                     "**+{}** |  | **x{}** |".format(
                         r["scenario"],
                         r["input_token_ratio_flat_over_kg"],
                         r["completions_flat_minus_kg"],
                         r["seconds_ratio_flat_over_kg"]))
    lines.append("\nNotes per scenario:\n")
    for r in results:
        lines.append("- **{}** — flat: {}  | kg: {}".format(
            r["scenario"], r["flat"]["note"], r["kg"]["note"]))
    md = "\n".join(lines) + "\n"
    (out_dir / "benchmark_results.md").write_text(md, encoding="utf-8")

    print(md)
    print("Wrote {}/benchmark_results.{{json,md}}".format(out_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
