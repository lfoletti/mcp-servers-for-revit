/**
 * v2_state_dump.mjs — dump l'état KG v2 (projection embarquée C# via les
 * commandes RevitMCPKgCommandSet) en shape `<project_id>.kg.json` PoC,
 * pour que verify.py puisse scorer par-scenario un run stack C (Stage-3).
 *
 * Différent de v1_state_dump : v1 lit le BLOB ES brut (kg_blob_read +
 * log_chunks JSONL) ; ici la projection est *traduite* par les commandes
 * read-only (kg_session_info / kg_query / kg_diff_since) — pas d'accès
 * direct au blob côté agent.
 *
 * Output shape (≡ PoC .kg.json + v1_state_dump) :
 *   { project_id, turn, nodes: [{_type, id, _revit_id, created_at_turn,
 *     modified_at_turn, deleted_at_turn, ...attrs}], action_log: [...] }
 * Pas d'edges (les checkers verify.py actuels ne lisent que `nodes` ;
 * audit-trail scenarios F2 viendront avec une commande kg_dump_edges
 * dédiée si Stage-3 en a besoin).
 *
 * Prérequis : Revit ouvert sur le .rvt du run v2, plugin chargé + Switch
 * ON, profil v2-kg actif (KG_V2_TOOLS=on côté MCP).
 *
 *   node kg_bridge/benchmark/live/v2_state_dump.mjs [port] [outFile]
 *     défauts : 8080  out/v2_state.kg.json
 */
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.argv[2] || 8080);
const OUT =
  process.argv[3] || "kg_bridge/benchmark/live/out/v2_state.kg.json";
const HOST = "127.0.0.1";

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    let buf = "";
    const to = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timeout ${method}`));
    }, 30000);
    sock.on("connect", () =>
      sock.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: "1" }))
    );
    sock.on("data", (d) => {
      buf += d.toString();
      try {
        const m = JSON.parse(buf);
        clearTimeout(to);
        sock.end();
        m.error
          ? reject(new Error(m.error.message || "Revit error"))
          : resolve(m.result);
      } catch {
        /* trame incomplète */
      }
    });
    sock.on("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
  });
}

function unwrap(res, op) {
  if (res == null || typeof res !== "object")
    throw new Error(`${op}: réponse vide`);
  if ((res.Success ?? res.success) === false)
    throw new Error(res.Message ?? res.message ?? `${op} échec`);
  return res.Response ?? res.response;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((o, k) => {
      o[k] = sortKeys(v[k]);
      return o;
    }, {});
  }
  return v;
}

// KgNodeView (lifecycle keys top-level, attrs nested) → v1/PoC flat shape
// (lifecycle + attrs at top level). _type carries the node kind (verify.py
// reads `n["_type"]`). _revit_id is the binding to the Revit ElementId.
function v2ToFlatNode(n) {
  return {
    id: n.llm_id,
    _type: n.node_type,
    _revit_id: n.revit_id ?? null,
    created_at_turn: n.created_at_turn,
    modified_at_turn: n.modified_at_turn ?? [],
    deleted_at_turn: n.deleted_at_turn ?? null,
    ...(n.attrs || {}),
  };
}

const info = unwrap(await rpc("kg_session_info", {}), "kg_session_info");
if (!info) {
  console.error("[v2_state_dump] kg_session_info vide — KG v2 actif ?");
  process.exit(1);
}

const queryResp = unwrap(
  await rpc("kg_query", { include_soft_deleted: true }),
  "kg_query"
);
const rawNodes = queryResp?.nodes ?? queryResp?.Nodes ?? [];
const nodes = rawNodes.map(v2ToFlatNode);

// action_log proxy via kg_diff_since(0) — la projection ne porte pas
// l'action_log textuel v1 mais le delta journal sert le même use case
// (qui-a-fait-quoi-à-quel-turn). Chaque entrée = un DeltaEntry tel quel.
let actionLog = [];
try {
  const diffResp = unwrap(
    await rpc("kg_diff_since", { since_turn: 0 }),
    "kg_diff_since"
  );
  actionLog = diffResp?.entries ?? diffResp?.Entries ?? [];
} catch (e) {
  // Diff is optional context for the dump ; absence ne casse pas la file.
  actionLog = [];
}

const projectId = info.project_id ?? info.ProjectId ?? "unknown";
const turn = info.turn ?? info.Turn ?? 0;

const kgjson = sortKeys({
  project_id: projectId,
  turn,
  nodes,
  action_log: actionLog,
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(kgjson, null, 2), "utf-8");

console.log(
  `[v2_state_dump] project_id=${projectId} turn=${turn} ` +
    `nodes=${nodes.length} actions=${actionLog.length} -> ${OUT}`
);
