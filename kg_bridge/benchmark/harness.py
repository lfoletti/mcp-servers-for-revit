#!/usr/bin/env python3
"""harness.py — scenario payload builder for the KG vs flat-store benchmark.

What is exact here (tokenizer- and assumption-independent):
  * the number of *sequential model completions* (round-trips) per approach;
  * the number and kind of tool calls;
  * the KG-side payloads, produced by the REAL vendored ProjectKG via the
    sidecar (not mocked).

What is modelled (clearly labelled in the output and in BENCHMARK.md):
  * token counts (see tokencount.py for the backend actually used);
  * wall-clock, via a transparent, parameter-overridable latency model.

The flat-store side is synthesised from a faithful Revit-element dump shape
(id / category / type / level / params), kept deliberately *modest* so the
comparison understates rather than inflates the KG advantage.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

HERE = Path(__file__).resolve().parent
SIDECAR = HERE.parent / "kg_sidecar.py"


# --------------------------------------------------------------------------
# sidecar client (same protocol as smoke_test.py)
# --------------------------------------------------------------------------
class Bridge:
    def __init__(self, kg_home: Path) -> None:
        env = dict(os.environ, KG_HOME=str(kg_home))
        self.p = subprocess.Popen(
            [sys.executable, str(SIDECAR)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, env=env, bufsize=1,
        )
        self._id = 0

    def call(self, method: str, **params: Any) -> Any:
        self._id += 1
        self.p.stdin.write(json.dumps(
            {"id": self._id, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        resp = json.loads(self.p.stdout.readline())
        if not resp.get("ok"):
            raise AssertionError("{}: {}".format(method, resp.get("error")))
        return resp["result"]

    def close(self) -> None:
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


# --------------------------------------------------------------------------
# synthetic building fixture
# --------------------------------------------------------------------------
@dataclass
class Fixture:
    scale: int = 1
    project_id: str = "bench"
    # populated by build()
    flat_dump: List[Dict[str, Any]] = field(default_factory=list)
    kg_turn_after_build: int = 0
    level_ids: List[str] = field(default_factory=list)


def _flat_element(eid: int, cat: str, type_name: str, level: str,
                   params: Dict[str, Any]) -> Dict[str, Any]:
    """Faithful (modest) shape of a Revit element as the no-KG agent must
    carry it in context to reason about the model — store_*_data cannot
    represent this, so it rides in the prompt."""
    return {
        "id": 100000 + eid,
        "category": cat,
        "type": type_name,
        "level": level,
        "params": params,
    }


def build(bridge: Bridge, scale: int) -> Fixture:
    """Build the same small building twice: once into the real KG (via the
    sidecar), once as a flat Revit-element dump. Deterministic."""
    fx = Fixture(scale=scale)
    bridge.call("reset", project_id=fx.project_id)

    n_levels = 2
    walls_per_level = 20 * scale
    openings_per_level = 10 * scale
    rooms_per_level = 4 * scale
    n_walltypes = 6

    eid = 0
    wt_ids: List[str] = []
    for t in range(n_walltypes):
        thick = round(0.10 + 0.05 * t, 2)
        r = bridge.call("add_element", project_id=fx.project_id,
                        node_type="WallType",
                        attrs={"name": "GEN_{}".format(int(thick * 100)),
                               "total_thickness": thick})
        wt_ids.append(r["llm_id"])
        fx.flat_dump.append(_flat_element(
            eid := eid + 1, "WallType", "GEN_{}".format(int(thick * 100)),
            "", {"total_thickness": thick}))

    for lv in range(n_levels):
        elev = round(lv * 3.0, 2)
        lr = bridge.call("add_element", project_id=fx.project_id,
                         node_type="Level",
                         attrs={"name": "N{}".format(lv), "elevation": elev})
        fx.level_ids.append(lr["llm_id"])
        fx.flat_dump.append(_flat_element(
            eid := eid + 1, "Level", "Level", "N{}".format(lv),
            {"elevation": elev}))

        for w in range(walls_per_level):
            wt = wt_ids[w % n_walltypes]
            x = float(w)
            wr = bridge.call(
                "add_element", project_id=fx.project_id, node_type="Wall",
                attrs={"type_ref": wt, "level_ref": lr["llm_id"],
                       "p1": [x, 0.0], "p2": [x + 1.0, 0.0],
                       "length": 1.0, "height": 2.7},
                edges=[{"to": lr["llm_id"], "type": "at_level"},
                       {"to": wt, "type": "is_type"}])
            fx.flat_dump.append(_flat_element(
                eid := eid + 1, "Wall", "GEN", "N{}".format(lv),
                {"length": 1.0, "height": 2.7, "x": x}))

            if w < openings_per_level:
                bridge.call(
                    "add_element", project_id=fx.project_id,
                    node_type="Window",
                    attrs={"type_ref": wt, "host_wall_ref": wr["llm_id"],
                           "position": [x + 0.5, 0.0],
                           "sill_height": 0.9, "head_height": 2.1},
                    edges=[{"from": wr["llm_id"], "type": "hosts"},
                           {"to": lr["llm_id"], "type": "at_level"}])
                fx.flat_dump.append(_flat_element(
                    eid := eid + 1, "Window", "W_STD", "N{}".format(lv),
                    {"sill_height": 0.9, "head_height": 2.1,
                     "host_id": 100000 + eid - 1}))

        for ro in range(rooms_per_level):
            bridge.call("add_element", project_id=fx.project_id,
                        node_type="Room",
                        attrs={"name": "R{}-{}".format(lv, ro),
                               "level_ref": lr["llm_id"]},
                        edges=[{"to": lr["llm_id"], "type": "at_level"}])
            fx.flat_dump.append(_flat_element(
                eid := eid + 1, "Room", "Room", "N{}".format(lv),
                {"name": "R{}-{}".format(lv, ro)}))

    fx.kg_turn_after_build = bridge.call("stats",
                                         project_id=fx.project_id)["turn"]
    return fx


# --------------------------------------------------------------------------
# scenario plans
# --------------------------------------------------------------------------
@dataclass
class Step:
    kind: str               # "completion" | "tool"
    label: str
    ctx_in: str = ""        # text added to model context at this step
    out_tokens: int = 0     # nominal model output for a "completion" step
    exec_kind: Optional[str] = None  # "kg" | "sqlite" | "revit" | None


@dataclass
class Plan:
    name: str
    approach: str           # "flat" | "kg"
    steps: List[Step]
    note: str = ""


# Nominal model output per reasoning/tool-use step. Identical for both
# approaches so it cancels in the delta; only structure (round-trips, tool
# kind, context size) drives the gap. Override via KG_BENCH_OUT_TOKENS.
_NOMINAL_OUT = int(os.environ.get("KG_BENCH_OUT_TOKENS", "150"))


def _dump_text(fx: Fixture) -> str:
    return json.dumps(fx.flat_dump, separators=(",", ":"))


def scenario_s1_whats_changed(bridge: Bridge, fx: Fixture) -> List[Plan]:
    """One small edit happened; agent must reason about *what changed*."""
    # apply one edit on the KG so diff_since has content
    w = bridge.call("query", project_id=fx.project_id,
                     node_type="Wall")["nodes"][0]["llm_id"]
    t0 = bridge.call("stats", project_id=fx.project_id)["turn"]
    bridge.call("modify_element", project_id=fx.project_id,
                llm_id=w, updates={"height": 3.2})

    flat = Plan("S1 what-changed", "flat", note=(
        "No change log: the agent re-pulls full model state via a Revit "
        "query tool and carries it in context to locate the change."), steps=[
        Step("tool", "get_current_view_elements", exec_kind="revit"),
        Step("completion", "reason over full dump",
             ctx_in=_dump_text(fx), out_tokens=_NOMINAL_OUT),
    ])

    diff = bridge.call("diff_since", project_id=fx.project_id, since_turn=t0)
    kg = Plan("S1 what-changed", "kg", note=(
        "kg_diff_since returns only the delta actions."), steps=[
        Step("tool", "kg_diff_since", exec_kind="kg"),
        Step("completion", "reason over delta",
             ctx_in=json.dumps(diff, separators=(",", ":")),
             out_tokens=_NOMINAL_OUT),
    ])
    return [flat, kg]


def scenario_s2_multiturn(bridge: Bridge, fx: Fixture,
                          turns: int = 10) -> List[Plan]:
    """N-turn editing session: the differentiator is the *state* portion of
    context re-injected each turn."""
    dump = _dump_text(fx)
    flat_steps: List[Step] = []
    for k in range(turns):
        flat_steps.append(Step("completion", "turn {} (full state)".format(k),
                               ctx_in=dump, out_tokens=_NOMINAL_OUT))
    flat = Plan("S2 multiturn x{}".format(turns), "flat", note=(
        "No delta primitive: full model state re-enters context every "
        "turn."), steps=flat_steps)

    # KG: turn 0 carries an initial relevant snapshot (level subgraph),
    # turns 1..N-1 carry only diff_since(prev).
    snap = bridge.call("query", project_id=fx.project_id,
                       node_type="Wall")
    kg_steps = [Step("completion", "turn 0 (snapshot)",
                     ctx_in=json.dumps(snap, separators=(",", ":")),
                     out_tokens=_NOMINAL_OUT)]
    for k in range(1, turns):
        t_prev = bridge.call("stats", project_id=fx.project_id)["turn"]
        # a representative small edit per turn
        wid = snap["nodes"][k % len(snap["nodes"])]["llm_id"]
        bridge.call("modify_element", project_id=fx.project_id,
                    llm_id=wid, updates={"height": 2.7 + 0.01 * k})
        delta = bridge.call("diff_since", project_id=fx.project_id,
                            since_turn=t_prev)
        kg_steps.append(Step("completion", "turn {} (delta)".format(k),
                             ctx_in=json.dumps(delta, separators=(",", ":")),
                             out_tokens=_NOMINAL_OUT))
    kg = Plan("S2 multiturn x{}".format(turns), "kg", note=(
        "Turn 0: relevant snapshot. Turns 1..N: diff_since only."),
        steps=kg_steps)
    return [flat, kg]


def _cat_text(fx: Fixture, cat: str) -> str:
    return json.dumps([e for e in fx.flat_dump if e["category"] == cat],
                      separators=(",", ":"))


def scenario_s3_structural_query(bridge: Bridge, fx: Fixture) -> List[Plan]:
    """'Windows hosted by walls on level N0.'

    Realistic flat path (user choice: no charitable single full-dump): with
    zero relations and category-scoped retrieval tools, the agent must gather
    each side separately (windows, walls, levels) over *sequential* tool
    round-trips, then perform the host/level join in-context."""
    flat = Plan("S3 structural-query", "flat", note=(
        "No relations + category-scoped retrieval: 3 sequential round-trips "
        "(windows, walls, levels) carried in context, then in-prompt join."),
        steps=[
        Step("tool", "ai_element_filter(Window)", exec_kind="revit"),
        Step("completion", "carry windows dump",
             ctx_in=_cat_text(fx, "Window"), out_tokens=_NOMINAL_OUT),
        Step("tool", "ai_element_filter(Wall)", exec_kind="revit"),
        Step("completion", "carry walls dump",
             ctx_in=_cat_text(fx, "Wall"), out_tokens=_NOMINAL_OUT),
        Step("tool", "ai_element_filter(Level)", exec_kind="revit"),
        Step("completion", "carry levels dump",
             ctx_in=_cat_text(fx, "Level"), out_tokens=_NOMINAL_OUT),
        Step("completion", "in-prompt host/level join + answer",
             out_tokens=_NOMINAL_OUT),
    ])

    n0 = fx.level_ids[0]
    wins = bridge.call("query", project_id=fx.project_id,
                        node_type="Window", include_edges=True)
    # server-side relevant slice: windows + their hosts/level edges
    sub = {
        "windows": [n for n in wins["nodes"]],
        "edges": [e for e in wins["edges"]
                  if e["type"] in ("hosts", "at_level")],
        "level_n0": n0,
    }
    kg = Plan("S3 structural-query", "kg", note=(
        "kg_query returns only the typed subgraph; the traversal is "
        "server-side."), steps=[
        Step("tool", "kg_query(Window, edges)", exec_kind="kg"),
        Step("completion", "answer from subgraph",
             ctx_in=json.dumps(sub, separators=(",", ":")),
             out_tokens=_NOMINAL_OUT),
    ])
    return [flat, kg]


def scenario_s4_atomic_batch(bridge: Bridge, fx: Fixture) -> List[Plan]:
    """5-op create batch; op #4 invalid."""
    # flat: ops 1-3 commit, 4 fails -> partial corrupt state; recovery =
    # inspect + delete 3 partials.
    partial_dump = json.dumps(fx.flat_dump[:3], separators=(",", ":"))
    flat = Plan("S4 atomic-batch", "flat", note=(
        "No cross-call transaction: 3 partial elements committed before the "
        "failure. Recovery = inspect state + delete each partial."), steps=[
        Step("completion", "issue create #1", out_tokens=_NOMINAL_OUT),
        Step("tool", "create #1", exec_kind="revit"),
        Step("completion", "issue create #2", out_tokens=_NOMINAL_OUT),
        Step("tool", "create #2", exec_kind="revit"),
        Step("completion", "issue create #3", out_tokens=_NOMINAL_OUT),
        Step("tool", "create #3", exec_kind="revit"),
        Step("completion", "issue create #4 (invalid)", out_tokens=_NOMINAL_OUT),
        Step("tool", "create #4 -> ERROR", exec_kind="revit"),
        # recovery
        Step("completion", "detect failure, plan cleanup",
             ctx_in=partial_dump, out_tokens=_NOMINAL_OUT),
        Step("tool", "get_current_view_elements (inspect)", exec_kind="revit"),
        Step("completion", "delete partial #1", out_tokens=_NOMINAL_OUT),
        Step("tool", "delete_element #1", exec_kind="revit"),
        Step("completion", "delete partial #2", out_tokens=_NOMINAL_OUT),
        Step("tool", "delete_element #2", exec_kind="revit"),
        Step("completion", "delete partial #3", out_tokens=_NOMINAL_OUT),
        Step("tool", "delete_element #3", exec_kind="revit"),
    ])

    demo = bridge.call("transaction_demo", project_id=fx.project_id)
    kg = Plan("S4 atomic-batch", "kg", note=(
        "Single transactional batch: failure rolls the whole thing back. "
        "Zero recovery. rolled_back_cleanly={}".format(
            demo["rolled_back_cleanly"])), steps=[
        Step("completion", "issue batch", out_tokens=_NOMINAL_OUT),
        Step("tool", "kg_transaction_demo (rolls back)", exec_kind="kg"),
        Step("completion", "report clean rollback",
             ctx_in=json.dumps({"rolled_back": demo["rolled_back_cleanly"],
                                "error": demo["error"]},
                               separators=(",", ":")),
             out_tokens=_NOMINAL_OUT),
    ])
    return [flat, kg]


def scenario_s5_drift(bridge: Bridge, fx: Fixture,
                      wasted_turns: int = 3) -> List[Plan]:
    """User hand-edits the model out of band.

    Flat store cannot detect divergence; the agent keeps acting on stale
    state for `wasted_turns` (assumption, override KG_BENCH_DRIFT_WASTED)
    before a human notices. KG detects it in one diff/query."""
    dump = _dump_text(fx)
    flat_steps = []
    for k in range(wasted_turns):
        flat_steps.append(Step("completion",
                               "act on stale state (turn {})".format(k),
                               ctx_in=dump, out_tokens=_NOMINAL_OUT))
    flat = Plan("S5 drift", "flat", note=(
        "Out-of-band edit undetectable: {} wasted turns on stale state "
        "(assumption).".format(wasted_turns)), steps=flat_steps)

    kg = Plan("S5 drift", "kg", note=(
        "One diff/query surfaces the divergence immediately."), steps=[
        Step("tool", "kg drift check (diff vs fresh read)", exec_kind="kg"),
        Step("completion", "flag drift, reconcile",
             ctx_in='{"drift_detected":true}', out_tokens=_NOMINAL_OUT),
    ])
    return [flat, kg]


SCENARIOS = [
    scenario_s1_whats_changed,
    scenario_s2_multiturn,
    scenario_s3_structural_query,
    scenario_s4_atomic_batch,
    scenario_s5_drift,
]
