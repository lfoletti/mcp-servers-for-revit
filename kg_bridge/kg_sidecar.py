#!/usr/bin/env python3
"""kg_sidecar.py — JSON-lines stdio bridge exposing the *real* claude-in-revit
ProjectKG to the TypeScript MCP server.

This is the only glue code of the PoC. It deliberately adds **zero** behaviour:
it imports `vendor/project_kg.py` (a byte-for-byte copy of the production file,
covered by 821 tests in the upstream project) and maps a tiny JSON-RPC-ish
protocol onto its public API. All graph semantics — typed schema, action-grained
history, soft-delete lifecycle, snapshot/rollback atomicity — come from that
unmodified module.

Protocol (one JSON object per line, both directions):

    -> {"id": <int>, "method": "<name>", "params": {...}}
    <- {"id": <int>, "ok": true,  "result": {...}}
    <- {"id": <int>, "ok": false, "error": "<message>"}

stdout carries *only* protocol frames. Diagnostics go to stderr (mirrors how
the Node server uses console.error as its log channel).

PoC turn model: the turn counter advances once per mutating call (add / modify /
soft_delete / transaction_demo). In the full claude-in-revit pipeline a "turn"
is one conversational user turn; here one MCP operation == one turn so that
`kg_diff_since` reads legibly in a demo. This is the only semantic concession
and it lives here, not in the vendored KG.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Dict

# --- import the unmodified production KG ---------------------------------
_VENDOR = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(_VENDOR))

from project_kg import (  # noqa: E402  (path set above)
    CREATED_AT,
    DELETED_AT,
    EDGE_TYPES,
    MODIFIED_AT,
    NODE_TYPES,
    SESSION_NODE_TYPES,
    ProjectKG,
)


def _log(msg: str) -> None:
    print("[kg_sidecar] {}".format(msg), file=sys.stderr, flush=True)


# --- per-project KG registry, persisted to disk --------------------------
# Disk persistence is itself a differentiator vs a stateless tool: the graph
# survives across MCP sessions (and across Revit restarts) at a stable path.
_KG_HOME = Path(os.environ.get("KG_HOME") or (Path.home() / ".mcp-revit-kg"))
_INSTANCES: Dict[str, ProjectKG] = {}


def _kg(project_id: str) -> ProjectKG:
    project_id = project_id or "default"
    kg = _INSTANCES.get(project_id)
    if kg is not None:
        return kg
    path = _KG_HOME / "{}.kg.json".format(project_id)
    if path.exists():
        kg = ProjectKG.load(path)
        _log("loaded existing KG '{}' (turn={}, path={})".format(
            project_id, kg.turn, path))
    else:
        kg = ProjectKG(project_id=project_id, persist_path=path)
        _log("new KG '{}' (path={})".format(project_id, path))
    _INSTANCES[project_id] = kg
    return kg


def _node_view(nid: str, attrs: Dict[str, Any]) -> Dict[str, Any]:
    """Public-API node projection for query results."""
    a = dict(attrs)
    return {
        "llm_id": nid,
        "type": a.pop("_type", None),
        "created_at_turn": a.pop(CREATED_AT, None),
        "modified_at_turn": a.pop(MODIFIED_AT, []),
        "deleted_at_turn": a.pop(DELETED_AT, None),
        "attrs": a,
    }


def _stats(kg: ProjectKG) -> Dict[str, Any]:
    by_type: Dict[str, Dict[str, int]] = {}
    for nid, attrs in [(n["id"], n) for n in kg.to_dict()["nodes"]]:
        t = attrs.get("_type", "?")
        slot = by_type.setdefault(t, {"live": 0, "deleted": 0})
        slot["deleted" if attrs.get(DELETED_AT) is not None else "live"] += 1
    d = kg.to_dict()
    return {
        "project_id": kg.project_id,
        "turn": kg.turn,
        "nodes_total": len(d["nodes"]),
        "edges_total": len(d["edges"]),
        "by_type": by_type,
        "action_log_len": len(d["action_log"]),
    }


# --- method handlers -----------------------------------------------------

def m_health(_p: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ok": True,
        "kg": "claude-in-revit ProjectKG (vendored, unmodified)",
        "kg_home": str(_KG_HOME),
        "node_types": sorted(NODE_TYPES),
        "edge_types": sorted(EDGE_TYPES),
    }


def m_schema(_p: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "node_types": {
            t: {
                "required": sorted(spec["required"]),
                "optional": sorted(spec["optional"]),
                "session_only": t in SESSION_NODE_TYPES,
            }
            for t, spec in NODE_TYPES.items()
        },
        "edge_types": sorted(EDGE_TYPES),
    }


def m_add_element(p: Dict[str, Any]) -> Dict[str, Any]:
    kg = _kg(p.get("project_id", "default"))
    node_type = p["node_type"]
    attrs = p.get("attrs") or {}
    llm_id = p.get("llm_id")
    edges = p.get("edges") or []
    with kg.transaction():
        kg.advance_turn()
        new_id = kg.add_node(node_type, attrs, llm_id=llm_id)
        for e in edges:
            etype = e["type"]
            if "to" in e:
                kg.add_edge(new_id, e["to"], etype)
            elif "from" in e:
                kg.add_edge(e["from"], new_id, etype)
            else:
                raise ValueError("edge needs 'to' or 'from': {}".format(e))
    return {"llm_id": new_id, "turn": kg.turn, "edges_added": len(edges)}


def m_modify_element(p: Dict[str, Any]) -> Dict[str, Any]:
    kg = _kg(p.get("project_id", "default"))
    llm_id = p["llm_id"]
    updates = p["updates"]
    with kg.transaction():
        kg.advance_turn()
        kg.modify_node(llm_id, updates)
    node = kg.get_node(llm_id)
    return {
        "llm_id": llm_id,
        "turn": kg.turn,
        "modified_at_turn": node.get(MODIFIED_AT, []),
    }


def _add_one(kg: Any, spec: Dict[str, Any]) -> str:
    """Per-item add (node + optional typed edges). No transaction here — the
    caller owns the transaction so unit and bulk share one code path (the
    project's bulk-variant policy: extract _do_one, wrap N in a single Tx)."""
    new_id = kg.add_node(spec["node_type"], spec.get("attrs") or {},
                         llm_id=spec.get("llm_id"))
    for e in spec.get("edges") or []:
        etype = e["type"]
        if "to" in e:
            kg.add_edge(new_id, e["to"], etype)
        elif "from" in e:
            kg.add_edge(e["from"], new_id, etype)
        else:
            raise ValueError("edge needs 'to' or 'from': {}".format(e))
    return new_id


def m_add_many(p: Dict[str, Any]) -> Dict[str, Any]:
    """Atomic bulk create. One transaction, one turn, N items: if any item
    fails the WHOLE batch rolls back (no partial project state). Mirrors the
    claude-in-revit bulk-variant policy and reinforces the S4 atomicity story
    at scale. One agent<->tool round-trip instead of N."""
    kg = _kg(p.get("project_id", "default"))
    items = p["items"]
    new_ids = []
    with kg.transaction():
        kg.advance_turn()
        for spec in items:
            new_ids.append(_add_one(kg, spec))
    return {"count": len(new_ids), "llm_ids": new_ids, "turn": kg.turn}


def m_modify_many(p: Dict[str, Any]) -> Dict[str, Any]:
    """Atomic bulk modify. One transaction, one turn, N {llm_id, updates}.
    The "set sill of ALL windows" case: 1 round-trip vs N single calls."""
    kg = _kg(p.get("project_id", "default"))
    items = p["items"]
    ids = []
    with kg.transaction():
        kg.advance_turn()
        for it in items:
            kg.modify_node(it["llm_id"], it["updates"])
            ids.append(it["llm_id"])
    return {"count": len(ids), "llm_ids": ids, "turn": kg.turn}


def m_soft_delete(p: Dict[str, Any]) -> Dict[str, Any]:
    kg = _kg(p.get("project_id", "default"))
    llm_id = p["llm_id"]
    with kg.transaction():
        kg.advance_turn()
        kg.soft_delete(llm_id)
    node = kg.get_node(llm_id)
    return {
        "llm_id": llm_id,
        "turn": kg.turn,
        "deleted_at_turn": node.get(DELETED_AT),
        "note": "soft delete: node retained, queryable with include_deleted=true",
    }


def m_query(p: Dict[str, Any]) -> Dict[str, Any]:
    kg = _kg(p.get("project_id", "default"))
    node_type = p.get("node_type")
    llm_id = p.get("llm_id")
    include_deleted = bool(p.get("include_deleted", False))
    include_edges = bool(p.get("include_edges", True))

    d = kg.to_dict()
    nodes = []
    for n in d["nodes"]:
        if llm_id is not None and n["id"] != llm_id:
            continue
        if node_type is not None and n.get("_type") != node_type:
            continue
        if not include_deleted and n.get(DELETED_AT) is not None:
            continue
        nodes.append(_node_view(n["id"], n))

    result: Dict[str, Any] = {"count": len(nodes), "nodes": nodes}
    if include_edges:
        ids = {n["llm_id"] for n in nodes}
        result["edges"] = [
            {"src": e["src"], "dst": e["dst"], "type": e.get("_type", e["key"])}
            for e in d["edges"]
            if e["src"] in ids or e["dst"] in ids
        ]
    return result


def m_diff_since(p: Dict[str, Any]) -> Dict[str, Any]:
    kg = _kg(p.get("project_id", "default"))
    since = int(p["since_turn"])
    diff = kg.diff_since(since)
    return {
        "since_turn": since,
        "current_turn": kg.turn,
        "action_count": len(diff),
        "actions": diff,
        "note": ("action-grained history -- a flat key/value store cannot answer "
                 "'what changed since turn N'"),
    }


def m_stats(p: Dict[str, Any]) -> Dict[str, Any]:
    return _stats(_kg(p.get("project_id", "default")))


def m_transaction_demo(p: Dict[str, Any]) -> Dict[str, Any]:
    """Prove all-or-nothing atomicity: run a batch whose last op is invalid
    inside a single kg.transaction(). The KG snapshots on entry and restores
    on *any* exception, so partial writes never land. A flat store (no
    transaction) would have committed the first writes and left the project
    state corrupt — exactly the failure mode `@kg_synced` exists to prevent
    when the same batch also mutates Revit."""
    kg = _kg(p.get("project_id", "default"))
    before = _stats(kg)
    ops = p.get("ops") or [
        {"node_type": "Level", "attrs": {"name": "Demo N0", "elevation": 0.0}},
        {"node_type": "Level", "attrs": {"name": "Demo N1", "elevation": 3.0}},
        # Intentionally invalid: unknown node type -> ValueError mid-batch.
        {"node_type": "Frobnicator", "attrs": {"name": "boom"}},
    ]
    error = None
    try:
        with kg.transaction():
            kg.advance_turn()
            for op in ops:
                kg.add_node(op["node_type"], op.get("attrs") or {})
    except BaseException as exc:  # noqa: BLE001 — we report it, not swallow it
        error = "{}: {}".format(type(exc).__name__, exc)
    after = _stats(kg)
    rolled_back = (
        before["nodes_total"] == after["nodes_total"]
        and before["turn"] == after["turn"]
        and before["action_log_len"] == after["action_log_len"]
    )
    return {
        "attempted_ops": ops,
        "error": error,
        "before": before,
        "after": after,
        "rolled_back_cleanly": rolled_back,
        "note": ("all-or-nothing: no node, no turn bump, no log entry survived "
                 "the failed batch"),
    }


def m_reset(p: Dict[str, Any]) -> Dict[str, Any]:
    """Drop a project KG (memory + disk). Demo hygiene only."""
    project_id = p.get("project_id", "default") or "default"
    _INSTANCES.pop(project_id, None)
    path = _KG_HOME / "{}.kg.json".format(project_id)
    existed = path.exists()
    if existed:
        path.unlink()
    return {"project_id": project_id, "removed": existed}


_DISPATCH = {
    "health": m_health,
    "schema": m_schema,
    "add_element": m_add_element,
    "add_many": m_add_many,
    "modify_element": m_modify_element,
    "modify_many": m_modify_many,
    "soft_delete": m_soft_delete,
    "query": m_query,
    "diff_since": m_diff_since,
    "stats": m_stats,
    "transaction_demo": m_transaction_demo,
    "reset": m_reset,
}


def main() -> None:
    _KG_HOME.mkdir(parents=True, exist_ok=True)
    _log("ready (KG_HOME={})".format(_KG_HOME))
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        rid = None
        try:
            req = json.loads(raw)
            rid = req.get("id")
            method = req["method"]
            handler = _DISPATCH.get(method)
            if handler is None:
                raise ValueError("unknown method: {}".format(method))
            result = handler(req.get("params") or {})
            out = {"id": rid, "ok": True, "result": result}
        except BaseException as exc:  # noqa: BLE001 — loop must never die
            _log("error: {}\n{}".format(exc, traceback.format_exc()))
            out = {"id": rid, "ok": False, "error": "{}: {}".format(
                type(exc).__name__, exc)}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
