#!/usr/bin/env python3
"""verify.py — quality scoring for the live benchmark.

Cost alone is meaningless without correctness. This scores each scenario from
the **persisted state snapshot** (deterministic, ground-truth checks — the
rigorous part) plus a claim↔state consistency verdict (catches fabrication —
the "coherence" axis), and joins it with the run's cost.

Inputs: one or more run output dirs (each holding `live_results.json` and a
`snapshots/<scen>__<profile>/` tree produced by `run_live.py --snapshot`).

    python verify.py --out <out_main> [<out_bulkN> <out_wow> <out_cases> ...]

Outputs `verify_report.{json,md}` in the FIRST --out dir: per scenario×profile
→ task_success, state_accuracy∈[0,1], verdict, cost$, cost_per_correct.

Epistemic honesty: state checks are rigorous where the artifact is
representable; read-only scenarios are flagged `claim`-graded; an ambiguous /
missing artifact yields `indeterminate` (we do not guess).
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Callable, Optional


# ---------- artifact loaders --------------------------------------------
def load_kg_files(snap: Path) -> list[dict]:
    out = []
    kdir = snap / "kg"
    if kdir.is_dir():
        for f in sorted(kdir.glob("*.kg.json")):
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except Exception:
                pass
    return out


def pick_project(kgs: list[dict], name: str) -> Optional[dict]:
    """The KG file whose project_id matches `name` (case-insensitive); else
    the one with the most nodes (the model may have used project_id
    'default')."""
    name_l = name.lower()
    for d in kgs:
        if str(d.get("project_id", "")).lower() == name_l:
            return d
    cand = [d for d in kgs if name_l in str(d.get("project_id", "")).lower()]
    if cand:
        return cand[0]
    return max(kgs, key=lambda d: len(d.get("nodes", [])), default=None)


def live_nodes(d: dict, ntype: str) -> list[dict]:
    return [n for n in d.get("nodes", [])
            if n.get("_type") == ntype and n.get("deleted_at_turn") is None]


def all_nodes(d: dict, ntype: str) -> list[dict]:
    return [n for n in d.get("nodes", []) if n.get("_type") == ntype]


def load_flat_rooms(snap: Path, project_substr: str) -> Optional[list[dict]]:
    db = snap / "flat.db"
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(str(db))
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT r.* FROM rooms r JOIN projects p ON r.project_id=p.id "
            "WHERE p.project_name LIKE ?", ("%" + project_substr + "%",)
        ).fetchall()
        con.close()
        return [dict(r) for r in rows]
    except Exception:
        return None


# ---------- claim heuristics --------------------------------------------
_SUCCESS = ("done", "complete", "persisted", "fixed", "updated all",
            "all 8", "all 10", "all 20", "compliant", "✅", "verified")
_INCAPACITY = ("cannot", "can't", "unable", "not possible", "no history",
               "does not support", "only project", "only stores",
               "store_*_data can only", "nothing to reopen", "not represent",
               "no relation", "no way to", "structurally")


def claims_success(text: str) -> bool:
    t = (text or "").lower()
    return any(s in t for s in _SUCCESS)


def admits_incapacity(text: str) -> bool:
    t = (text or "").lower()
    return any(s in t for s in _INCAPACITY)


def combine(state_ok: Optional[bool], text: str) -> str:
    """state_ok True/False/None(→read-only). Verdict ternary (+indeterminate)."""
    cs, ai = claims_success(text), admits_incapacity(text)
    if state_ok is True:
        return "correct"
    if state_ok is False:
        return "fabricated" if (cs and not ai) else "honest_incomplete"
    return "indeterminate"  # read-only: resolved by the checker via claims


def frac(conds: list[bool]) -> float:
    return round(sum(1 for c in conds if c) / len(conds), 3) if conds else 0.0


# ---------- per-scenario checkers ---------------------------------------
# Each: (kgs, snap, text) -> dict(task_success, state_accuracy, verdict, basis,
# notes). KG-representable scenarios are state-graded; flat snapshots of BIM
# scenarios have no walls/windows → state_ok False → verdict from claims.

def _bim_state(kgs, name, conds_fn):
    d = pick_project(kgs, name) if kgs else None
    if not d:
        # State-graded scenario with no KG artifact: the required state is
        # not demonstrated (flat-on-BIM by design; or a real KG miss). NOT
        # "read-only" → False, so combine() routes it to honest_incomplete
        # (admitted) or fabricated (falsely claimed) via the claim.
        return False, 0.0
    conds = conds_fn(d)
    acc = frac(conds)
    return all(conds), acc


def chk_seed(kgs, snap, text):
    ok, acc = _bim_state(kgs, "Demo", lambda d: [
        len(live_nodes(d, "Level")) == 2,
        len(live_nodes(d, "WallType")) == 1,
        len(live_nodes(d, "Wall")) == 20,
        len(live_nodes(d, "Window")) == 8])
    return _wrap(ok, acc, text, "state(KG Demo counts)")


def chk_s1(kgs, snap, text):
    def c(d):
        walls = live_nodes(d, "Wall")
        return [any(abs(float(w.get("height", 0)) - 3.2) < 1e-6 for w in walls),
                any(a.get("action") == "modify" for a in d.get("action_log", []))]
    return _wrap(*_bim_state(kgs, "Demo", c), text=text,
                 basis="state(wall height 3.2 + modify log)")


def chk_s2(kgs, snap, text):
    targets = {round(2.80 + 0.01 * i, 2) for i in range(10)}
    def c(d):
        hs = [round(float(w.get("height", -1)), 2)
              for w in live_nodes(d, "Wall")]
        hit = sum(1 for t in targets if t in hs)
        return [hit >= 10]
    return _wrap(*_bim_state(kgs, "Demo", c), text=text,
                 basis="state(10 wall heights 2.80..2.89)")


def chk_readonly(kgs, snap, text, must_have):
    """S3-like: no state change; grade by claim containing all tokens."""
    t = (text or "").lower()
    ok = all(tok.lower() in t for tok in must_have) and not _bad_claim(text)
    return {"task_success": ok, "state_accuracy": None,
            "verdict": "correct" if ok else "fabricated"
            if claims_success(text) else "honest_incomplete",
            "basis": "claim(read-only)", "notes": "tokens=%s" % (must_have,)}


def _bad_claim(text):
    return False


def chk_s3(kgs, snap, text):
    return chk_readonly(kgs, snap, text, ["8", "n0"])


def chk_s4(kgs, snap, text):
    bad = {10.0, 13.0, 16.0, 22.0}
    def c(d):
        elevs = {round(float(l.get("elevation", -999)), 1)
                 for l in live_nodes(d, "Level")}
        return [len(elevs & bad) == 0, len(live_nodes(d, "Level")) == 2]
    return _wrap(*_bim_state(kgs, "Demo", c), text=text,
                 basis="state(atomic rollback: no 10/13/16/22, levels==2)")


def chk_s5(kgs, snap, text):
    # Correct = honestly states it cannot detect an out-of-band edit.
    honest = admits_incapacity(text) or "cannot detect" in (text or "").lower()
    fab = claims_success(text) and "detect" in (text or "").lower() \
        and not honest
    v = "correct" if honest else ("fabricated" if fab
                                  else "honest_incomplete")
    return {"task_success": honest, "state_accuracy": None, "verdict": v,
            "basis": "claim(drift honesty)",
            "notes": "must admit it cannot detect hand edits"}


def chk_s6(kgs, snap, text):
    def c(d):
        w = live_nodes(d, "Window")
        return [len(w) >= 8,
                all(abs(float(x.get("sill_height", -1)) - 0.8) < 1e-6
                    for x in w) if w else False]
    return _wrap(*_bim_state(kgs, "Demo", c), text=text,
                 basis="state(all windows sill==0.8)")


def _rooms_check(kgs, snap, name, n, area=None):
    # Rooms ARE representable by flat too — verify whichever artifact exists.
    d = pick_project(kgs, name) if kgs else None
    if d and live_nodes(d, "Room"):
        rooms = live_nodes(d, "Room")
        conds = [len(rooms) == n]
        if area is not None:
            conds.append(all(abs(float(r.get("area", -1)) - area) < 1e-6
                             for r in rooms))
        return _wrap(all(conds), frac(conds), text="", basis="state(KG rooms)")
    fr = load_flat_rooms(snap, name)
    if fr is not None:
        conds = [len(fr) == n]
        if area is not None:
            conds.append(all(abs(float((r.get("area") or -1)) - area) < 1e-6
                             for r in fr))
        return _wrap(all(conds), frac(conds), text="", basis="state(flat rooms)")
    return {"task_success": None, "state_accuracy": None,
            "verdict": "indeterminate", "basis": "no rooms artifact",
            "notes": ""}


def chk_seed_n10(kgs, snap, text):
    r = _rooms_check(kgs, snap, "RoomBench10", 10)
    return _merge_text(r, text)


def chk_edit_n10(kgs, snap, text):
    return _merge_text(_rooms_check(kgs, snap, "RoomBench10", 10, 25.0), text)


def chk_seed_n20(kgs, snap, text):
    return _merge_text(_rooms_check(kgs, snap, "RoomBench20", 20), text)


def chk_edit_n20(kgs, snap, text):
    return _merge_text(_rooms_check(kgs, snap, "RoomBench20", 20, 25.0), text)


def chk_wow(kgs, snap, text):
    def c(d):
        w = live_nodes(d, "Window")
        return [len(live_nodes(d, "Level")) == 3,
                len(live_nodes(d, "Wall")) == 30,
                len(w) == 18,
                all(float(x.get("sill_height", -1)) >= 0.9 - 1e-9
                    for x in w) if w else False]
    return _wrap(*_bim_state(kgs, "Tower", c), text=text,
                 basis="state(Tower: 3 lvl/30 wall/18 win, all sill>=0.9)")


def _modwhere_check(kgs, name, text):
    def c(d):
        w = live_nodes(d, "Window")
        return [len(live_nodes(d, "Level")) == 1,
                len(live_nodes(d, "Wall")) == 30,
                len(w) == 30,
                all(float(x.get("sill_height", -1)) >= 0.9 - 1e-9
                    for x in w) if w else False]
    return _wrap(*_bim_state(kgs, name, c), text=text,
                 basis="state(%s: 1 lvl/30 wall/30 win, all sill>=0.9)" % name)


def chk_mw_loop(kgs, snap, text):
    return _modwhere_check(kgs, "MWLoop", text)


def chk_mw_where(kgs, snap, text):
    return _modwhere_check(kgs, "MWWhere", text)


def _level_elev_map(d):
    return {l["id"]: round(float(l.get("elevation", -999)), 1)
            for l in live_nodes(d, "Level")}


def chk_cs9_a(kgs, snap, text):
    def c(d):
        lev = _level_elev_map(d)
        walls = live_nodes(d, "Wall")
        wins = live_nodes(d, "Window")
        n1_lids = {lid for lid, e in lev.items() if abs(e - 3.0) < 1e-6}
        n1_walls = {w["id"] for w in walls
                    if w.get("level_ref") in n1_lids}
        win_hosts = {x.get("host_wall_ref") for x in wins}
        return [len(walls) == 12, len(wins) == 6,
                len(win_hosts & n1_walls) == 0]
    return _wrap(*_bim_state(kgs, "Resume", c), text=text,
                 basis="state(12 walls, 6 win all on N0, none on N1)")


def chk_cs9_b(kgs, snap, text):
    def c(d):
        lev = _level_elev_map(d)
        walls = live_nodes(d, "Wall")
        wins = live_nodes(d, "Window")
        n1_lids = {lid for lid, e in lev.items() if abs(e - 3.0) < 1e-6}
        n1_walls = [w["id"] for w in walls if w.get("level_ref") in n1_lids]
        hosted = [x.get("host_wall_ref") for x in wins]
        each_n1_one = all(hosted.count(wid) == 1 for wid in n1_walls) \
            and len(n1_walls) == 6
        return [len(wins) == 12, each_n1_one]
    return _wrap(*_bim_state(kgs, "Resume", c), text=text,
                 basis="state(12 win, each N1 wall hosts exactly 1)")


def chk_cs10(kgs, snap, text):
    def c(d):
        live_wall_ids = {w["id"] for w in live_nodes(d, "Wall")}
        wins = live_nodes(d, "Window")
        dangling = [x for x in wins
                    if x.get("host_wall_ref") not in live_wall_ids]
        deleted_walls = [w for w in all_nodes(d, "Wall")
                         if w.get("deleted_at_turn") is not None]
        return [len(dangling) == 0,
                len(live_nodes(d, "Wall")) == 4,
                len(wins) == 1,
                len(deleted_walls) >= 1]
    return _wrap(*_bim_state(kgs, "Integrity", c), text=text,
                 basis="state(no dangling host; 4 walls,1 win,>=1 deleted)")


def _wrap(state_ok, acc, text, basis):
    return {"task_success": state_ok, "state_accuracy": acc,
            "verdict": combine(state_ok, text), "basis": basis, "notes": ""}


def _merge_text(r, text):
    if r.get("verdict") == "indeterminate":
        return r
    r["verdict"] = combine(r.get("task_success"), text)
    return r


CHECKS: dict[str, Callable] = {
    "00_seed": chk_seed, "10_s1": chk_s1, "20_s2": chk_s2, "30_s3": chk_s3,
    "40_s4": chk_s4, "50_s5": chk_s5, "60_s6": chk_s6,
    "10_seed_n10": chk_seed_n10, "20_edit_n10": chk_edit_n10,
    "30_seed_n20": chk_seed_n20, "40_edit_n20": chk_edit_n20,
    "10_wow_compliance": chk_wow,
    "10_cs9_resume_a_build": chk_cs9_a,
    "20_cs9_resume_b_continue": chk_cs9_b,
    "30_cs10_integrity_delete": chk_cs10,
    "10_loop": chk_mw_loop,
    "20_where": chk_mw_where,
}


def main() -> int:
    try:  # console safety on non-UTF-8 terminals
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", nargs="+", required=True,
                    help="one or more run output dirs (with live_results.json "
                         "+ snapshots/)")
    args = ap.parse_args()

    rows = []
    for od in args.out:
        od = Path(od)
        lj = od / "live_results.json"
        if not lj.exists():
            print("skip (no live_results.json): %s" % od, file=sys.stderr)
            continue
        results = json.loads(lj.read_text(encoding="utf-8"))
        for scen, byprof in results.items():
            chk = CHECKS.get(scen)
            for prof, rec in byprof.items():
                snap = od / "snapshots" / ("%s__%s" % (scen, prof))
                kgs = load_kg_files(snap) if snap.exists() else []
                text = rec.get("result_head", "")
                if chk is None:
                    sc = {"task_success": None, "state_accuracy": None,
                          "verdict": "indeterminate",
                          "basis": "no checker", "notes": ""}
                else:
                    sc = chk(kgs, snap, text)
                cost = rec.get("total_cost_usd")
                ok = sc.get("verdict") == "correct"
                rows.append({
                    "scenario": scen, "profile": prof,
                    "task_success": sc.get("task_success"),
                    "state_accuracy": sc.get("state_accuracy"),
                    "verdict": sc.get("verdict"),
                    "cost_usd": cost,
                    "cost_per_correct": (round(cost, 4)
                                         if (ok and cost is not None)
                                         else None),
                    "basis": sc.get("basis"),
                })

    out0 = Path(args.out[0])
    (out0 / "verify_report.json").write_text(
        json.dumps(rows, indent=2), encoding="utf-8")

    by_prof: dict[str, dict] = {}
    lines = ["# Verify report - quality x cost\n",
             "verdict: correct = state matches ground truth | "
             "honest_incomplete = couldn't, said so, no fabrication | "
             "fabricated = claimed success, state disagrees | "
             "indeterminate = read-only/ambiguous (claim-graded)\n",
             "| Scenario | Profile | success | state_acc | verdict "
             "| cost $ | basis |",
             "|---|---|:--:|--:|---|--:|---|"]
    for r in rows:
        lines.append("| {} | {} | {} | {} | {} | {} | {} |".format(
            r["scenario"], r["profile"], r["task_success"],
            r["state_accuracy"], r["verdict"],
            r["cost_usd"], r["basis"]))
        p = by_prof.setdefault(r["profile"], {
            "correct": 0, "fabricated": 0, "honest_incomplete": 0,
            "indeterminate": 0, "cost": 0.0, "cost_correct": 0.0})
        p[r["verdict"]] = p.get(r["verdict"], 0) + 1
        if r["cost_usd"]:
            p["cost"] += r["cost_usd"]
            if r["verdict"] == "correct":
                p["cost_correct"] += r["cost_usd"]
    lines += ["", "## Per-profile summary", "",
              "| Profile | correct | fabricated | honest_incomp | indet "
              "| total $ | $/correct |", "|---|--:|--:|--:|--:|--:|--:|"]
    for prof, p in by_prof.items():
        cpc = round(p["cost_correct"] / p["correct"], 4) if p["correct"] \
            else None
        lines.append("| {} | {} | {} | {} | {} | {} | {} |".format(
            prof, p["correct"], p["fabricated"], p["honest_incomplete"],
            p["indeterminate"], round(p["cost"], 3), cpc))
    md = "\n".join(lines) + "\n"
    (out0 / "verify_report.md").write_text(md, encoding="utf-8")
    print(md)
    print("Wrote %s/verify_report.{json,md}" % out0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
