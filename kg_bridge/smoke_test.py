#!/usr/bin/env python3
"""smoke_test.py — deterministic, offline proof of the KG sidecar.

No Node, no Revit, no network. Spawns `kg_sidecar.py`, drives every method
over the stdio protocol, asserts the differentiating invariants, and prints a
readable transcript. This is the fast validation stage (cycle ~seconds),
mirroring the upstream project's "offline test before anything Revit-aware"
discipline.

Run:  python kg_bridge/smoke_test.py
Exit code 0 == all invariants held.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE / "kg_sidecar.py"


class Bridge:
    def __init__(self, kg_home: Path) -> None:
        env = dict(os.environ, KG_HOME=str(kg_home))
        self.p = subprocess.Popen(
            [sys.executable, str(SIDECAR)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, env=env, bufsize=1,
        )
        self._id = 0

    def call(self, method: str, **params):
        self._id += 1
        self.p.stdin.write(json.dumps(
            {"id": self._id, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        resp = json.loads(self.p.stdout.readline())
        if not resp.get("ok"):
            raise AssertionError("{} failed: {}".format(method, resp.get("error")))
        return resp["result"]

    def close(self) -> None:
        self.p.stdin.close()
        self.p.wait(timeout=5)


def section(t: str) -> None:
    print("\n=== {} ===".format(t))


def show(label, obj) -> None:
    print("  {}: {}".format(label, json.dumps(obj, ensure_ascii=False)))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="kg_smoke_"))
    failures = []

    def check(cond: bool, msg: str) -> None:
        print("  [{}] {}".format("PASS" if cond else "FAIL", msg))
        if not cond:
            failures.append(msg)

    b = Bridge(tmp)
    try:
        b.call("reset", project_id="default")

        section("health + schema (typed graph — not a flat KV store)")
        h = b.call("health")
        show("node_types", h["node_types"])
        sch = b.call("schema")
        check("Wall" in sch["node_types"]
              and "type_ref" in sch["node_types"]["Wall"]["required"],
              "schema exposes typed Wall contract")

        section("add typed elements + relations")
        lvl = b.call("add_element", node_type="Level",
                     attrs={"name": "N0", "elevation": 0.0})
        wt = b.call("add_element", node_type="WallType",
                    attrs={"name": "GEN_200", "total_thickness": 0.2})
        show("level", lvl)
        show("walltype", wt)
        wall = b.call(
            "add_element", node_type="Wall",
            attrs={"type_ref": wt["llm_id"], "level_ref": lvl["llm_id"],
                   "p1": [0.0, 0.0], "p2": [5.0, 0.0],
                   "length": 5.0, "height": 2.7},
            edges=[{"to": lvl["llm_id"], "type": "at_level"},
                   {"to": wt["llm_id"], "type": "is_type"}],
        )
        show("wall", wall)
        check(wall["edges_added"] == 2, "wall created with 2 typed relations")

        section("query the topology (relations, not just rows)")
        q = b.call("query", node_type="Wall")
        show("walls", q)
        check(q["count"] == 1 and len(q["edges"]) == 2,
              "query returns the wall + its at_level/is_type edges")

        section("modify -> action-grained history")
        turn_before = b.call("stats")["turn"]
        b.call("modify_element", llm_id=wall["llm_id"], updates={"height": 3.0})
        d = b.call("diff_since", since_turn=turn_before)
        show("diff_since(turn_before)", d)
        check(d["action_count"] >= 1
              and any(a["action"] == "modify" for a in d["actions"]),
              "diff_since surfaces the modify action (impossible on a flat store)")

        section("soft delete (lifecycle, not destruction)")
        b.call("soft_delete", llm_id=lvl["llm_id"])
        live = b.call("query", node_type="Level")
        dead = b.call("query", node_type="Level", include_deleted=True)
        check(live["count"] == 0 and dead["count"] == 1
              and dead["nodes"][0]["deleted_at_turn"] is not None,
              "soft-deleted node hidden by default, retained with deleted_at_turn")

        section("bulk variants (1 round-trip, atomic) — bulk-tool policy")
        before_turn = b.call("stats")["turn"]
        added = b.call("add_many", items=[
            {"node_type": "Window", "attrs": {
                "type_ref": wt["llm_id"], "host_wall_ref": wall["llm_id"],
                "position": [float(i), 0.0], "sill_height": 0.9,
                "head_height": 2.1}} for i in range(8)
        ])
        check(added["count"] == 8
              and b.call("stats")["turn"] == before_turn + 1,
              "add_many: 8 windows created in ONE call / ONE turn")
        modded = b.call("modify_many", items=[
            {"llm_id": wid, "updates": {"sill_height": 0.8}}
            for wid in added["llm_ids"]
        ])
        win0 = b.call("query", llm_id=added["llm_ids"][0])["nodes"][0]
        check(modded["count"] == 8 and win0["attrs"]["sill_height"] == 0.8,
              "modify_many: 'set sill of all windows to 0.8' in ONE call")
        n_before = b.call("stats")["nodes_total"]
        bad = None
        try:
            b.call("add_many", items=[
                {"node_type": "Level", "attrs": {"name": "BX", "elevation": 1.0}},
                {"node_type": "Frobnicator", "attrs": {"name": "boom"}},
            ])
        except AssertionError as e:
            bad = str(e)
        check(bad is not None
              and b.call("stats")["nodes_total"] == n_before,
              "bulk add with one invalid item rolls back the WHOLE batch")

        section("atomic rollback (the @kg_synced guarantee, KG side)")
        demo = b.call("transaction_demo")
        show("transaction_demo", demo)
        check(demo["error"] is not None and demo["rolled_back_cleanly"],
              "failed batch rolled back fully: no node / turn / log leak")

        final_turn = b.call("stats")["turn"]
    finally:
        b.close()

    section("cross-session persistence (survives process restart)")
    b2 = Bridge(tmp)
    try:
        st = b2.call("stats")
        show("reloaded stats", st)
        check(st["turn"] == final_turn and st["nodes_total"] >= 3,
              "new sidecar process reloaded the KG from disk (turn + nodes)")
    finally:
        b2.close()

    print("\n" + ("ALL PASS" if not failures
                   else "FAILURES: {}".format(failures)))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
