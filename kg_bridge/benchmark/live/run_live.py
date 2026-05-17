#!/usr/bin/env python3
"""run_live.py — real client A/B benchmark via Claude Code.

Drives the 5 scenario prompts through `claude -p --output-format json` in two
profile working directories (each holding a .mcp.json that points at the same
built server with a different KG_BENCH_MODE), parses the *real* token usage,
turn count and wall-clock from Claude Code, and writes a comparison table.

This is the ground-truth complement to the offline modelled benchmark
(../run_benchmark.py). It makes REAL Anthropic API calls (generation) and is
therefore BILLABLE — it refuses to run without --yes.

Preconditions (one-time, per profile dir):
  1. Server built:  cd server && npm install && npm run build
  2. Approve the MCP server interactively once per profile dir so headless
     runs can use it:
        cd <flat-dir> && claude        (answer the .mcp.json approval; /mcp; exit)
        cd <kg-dir>   && claude        (same)
     In <kg-dir>, /mcp must list the 6 kg_* tools; in <flat-dir>, none.

Usage:
  python run_live.py --flat-dir C:\\...\\bench-flat --kg-dir C:\\...\\bench-kg --yes

Portable: no hardcoded user paths. Profile dirs are arguments (or env
KG_BENCH_FLAT_DIR / KG_BENCH_KG_DIR).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Steering suffix per profile, so each side actually exercises its own memory
# layer (the comparison would be meaningless if both used the same tools).
SUFFIX = {
    "flat": " (Use the store_* data tools to persist and query project state.)",
    "kg": " (Use the kg_* tools to record and query project state.)",
    "kg-many": " (Use the kg_* tools to record and query project state; "
               "when acting on multiple elements, prefer the *_many bulk "
               "variants.)",
}

# Pairs to report ratios for, when both profiles are present.
RATIO_PAIRS = [("flat", "kg"), ("kg", "kg-many")]


def die(msg: str, code: int = 2) -> None:
    print("ERROR: " + msg, file=sys.stderr)
    raise SystemExit(code)


def read_profile(dir_: Path) -> dict:
    """Parse the profile's .mcp.json to derive reset targets."""
    mcp = dir_ / ".mcp.json"
    if not mcp.exists():
        die(".mcp.json not found in profile dir: {}".format(dir_))
    cfg = json.loads(mcp.read_text(encoding="utf-8"))
    srv = next(iter(cfg["mcpServers"].values()))
    env = srv.get("env", {})
    index_js = Path(srv["args"][0])
    # .../server/build/index.js -> .../server/revit-data.db (their SQLite store)
    server_dir = index_js.parent.parent
    return {
        "kg_home": env.get("KG_HOME"),
        "sqlite_db": str(server_dir / "revit-data.db"),
        "mode": env.get("KG_BENCH_MODE", "?"),
    }


def reset_state(profile: dict) -> list[str]:
    cleared = []
    kgh = profile.get("kg_home")
    if kgh and Path(kgh).exists():
        shutil.rmtree(kgh, ignore_errors=True)
        cleared.append(kgh)
    db = profile.get("sqlite_db")
    if db and Path(db).exists():
        try:
            Path(db).unlink()
            cleared.append(db)
        except OSError:
            pass
    return cleared


def parse_claude_json(stdout: str) -> dict:
    """Defensive: --output-format json yields one result object; tolerate a
    list or NDJSON just in case."""
    stdout = stdout.strip()
    obj = None
    try:
        obj = json.loads(stdout)
    except json.JSONDecodeError:
        for line in reversed(stdout.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if isinstance(obj, list):
        results = [m for m in obj if isinstance(m, dict)
                   and m.get("type") == "result"]
        obj = results[-1] if results else (obj[-1] if obj else None)
    if not isinstance(obj, dict):
        return {"_parse_error": True, "raw_head": stdout[:400]}
    u = obj.get("usage") or {}
    return {
        "is_error": bool(obj.get("is_error", False)),
        "num_turns": obj.get("num_turns"),
        "duration_ms": obj.get("duration_ms"),
        "total_cost_usd": obj.get("total_cost_usd"),
        "input_tokens": u.get("input_tokens"),
        "output_tokens": u.get("output_tokens"),
        "cache_read_input_tokens": u.get("cache_read_input_tokens"),
        "cache_creation_input_tokens": u.get("cache_creation_input_tokens"),
        "result_head": str(obj.get("result", ""))[:2500],
    }


def run_one(claude: str, cwd: Path, prompt: str, max_turns: int,
            timeout: int) -> dict:
    cmd = [
        claude, "-p", prompt,
        "--output-format", "json",
        "--max-turns", str(max_turns),
        "--allowedTools", "mcp__revit",
    ]
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd, cwd=str(cwd), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except FileNotFoundError:
        die("`{}` not found. Install Claude Code or pass --claude PATH."
            .format(claude))
    except subprocess.TimeoutExpired:
        return {"is_error": True, "_timeout": True,
                "wall_s": round(time.time() - t0, 2)}
    m = parse_claude_json(proc.stdout)
    m["wall_s"] = round(time.time() - t0, 2)
    if proc.returncode != 0 and not m.get("is_error"):
        m["is_error"] = True
        m["_exit"] = proc.returncode
        m["_stderr_head"] = proc.stderr[:300]
    return m


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flat-dir", default=os.environ.get("KG_BENCH_FLAT_DIR"))
    ap.add_argument("--kg-dir", default=os.environ.get("KG_BENCH_KG_DIR"))
    ap.add_argument("--many-dir", default=os.environ.get("KG_BENCH_MANY_DIR"),
                    help="optional 3rd profile: KG + _many bulk variants "
                         "(KG_BENCH_MODE=kg-many)")
    ap.add_argument("--prompts-dir", default=str(HERE / "prompts"))
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--claude", default="claude")
    ap.add_argument("--max-turns", type=int, default=40)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--no-reset", action="store_true",
                    help="do not wipe KG_HOME / revit-data.db before each profile")
    ap.add_argument("--yes", action="store_true",
                    help="required: confirms you accept REAL billable API calls")
    args = ap.parse_args()

    if not args.flat_dir or not args.kg_dir:
        die("--flat-dir and --kg-dir are required (or set KG_BENCH_FLAT_DIR / "
            "KG_BENCH_KG_DIR). --many-dir is optional (3rd profile).")

    profiles: dict[str, dict] = {}
    profiles["flat"] = {"dir": Path(args.flat_dir).resolve()}
    profiles["kg"] = {"dir": Path(args.kg_dir).resolve()}
    if args.many_dir:
        profiles["kg-many"] = {"dir": Path(args.many_dir).resolve()}
    for label in profiles:
        profiles[label].update(read_profile(profiles[label]["dir"]))

    if not args.yes:
        die("This runs REAL, billable Anthropic API calls (scenarios x {} "
            "profiles, multi-turn). Re-run with --yes to confirm.".format(
                len(profiles)))

    prompts = sorted(Path(args.prompts_dir).glob("*.txt"))
    if not prompts:
        die("no prompt .txt files in {}".format(args.prompts_dir))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Profiles: " + " | ".join(
        "{}={} (mode={})".format(lbl, p["dir"], p["mode"])
        for lbl, p in profiles.items()))

    results: dict[str, dict[str, dict]] = {}
    for label, prof in profiles.items():
        if not args.no_reset:
            cleared = reset_state(prof)
            print("[{}] reset: {}".format(
                label, cleared or "(nothing to clear)"))
        for pf in prompts:
            scen = pf.stem
            prompt = pf.read_text(encoding="utf-8").strip() + SUFFIX[label]
            print("[{}] {} ...".format(label, scen), flush=True)
            m = run_one(args.claude, prof["dir"], prompt,
                        args.max_turns, args.timeout)
            results.setdefault(scen, {})[label] = m
            print("    in={} out={} turns={} wall={}s err={}".format(
                m.get("input_tokens"), m.get("output_tokens"),
                m.get("num_turns"), m.get("wall_s"), m.get("is_error")))

    (out_dir / "live_results.json").write_text(
        json.dumps(results, indent=2), encoding="utf-8")

    def num(x):
        return x if isinstance(x, (int, float)) else None

    def ratio(a, b):
        a, b = num(a), num(b)
        if a is None or b is None or not b:
            return "-"
        return "x{}".format(round(a / b, 2))

    lines = ["# Live A/B results (Claude Code, real usage)\n",
             "Real Anthropic usage via `claude -p --output-format json`. "
             "Each scenario is a fresh session; state persists on disk "
             "between scenarios within a profile.\n",
             "| Scenario | Profile | in tok | out tok | turns | wall s "
             "| cost $ | err |",
             "|---|---|--:|--:|--:|--:|--:|:--:|"]
    order = [p for p in ("flat", "kg", "kg-many") if p in profiles]
    # Display the real KG_BENCH_MODE (e.g. "kg-many") rather than the slot
    # key, so a flat-vs-kg-many run reads correctly even though it occupies
    # the generic --kg-dir slot.
    def disp(label: str) -> str:
        return profiles.get(label, {}).get("mode", label)

    for scen in sorted(results):
        for label in order:
            m = results[scen].get(label, {})
            lines.append("| {} | {} | {} | {} | {} | {} | {} | {} |".format(
                scen, disp(label), m.get("input_tokens"),
                m.get("output_tokens"), m.get("num_turns"), m.get("wall_s"),
                m.get("total_cost_usd"), m.get("is_error")))
        for a, b in RATIO_PAIRS:
            if a not in profiles or b not in profiles:
                continue
            ma, mb = results[scen].get(a, {}), results[scen].get(b, {})
            lines.append(
                "| **{}** | **{}/{}** | **{}** | {} | **{}** | {} | {} | |"
                .format(scen, disp(a), disp(b),
                        ratio(ma.get("input_tokens"), mb.get("input_tokens")),
                        ratio(ma.get("output_tokens"), mb.get("output_tokens")),
                        ratio(ma.get("num_turns"), mb.get("num_turns")),
                        ratio(ma.get("wall_s"), mb.get("wall_s")),
                        ratio(ma.get("total_cost_usd"),
                              mb.get("total_cost_usd"))))
    md = "\n".join(lines) + "\n"
    (out_dir / "live_results.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    print("Wrote {}/live_results.{{json,md}}".format(out_dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
