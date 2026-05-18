/**
 * v1_state_dump.mjs — dump l'état KG v1 (dans le .rvt via ES) à la forme
 * `<project_id>.kg.json` du PoC, pour un contrôle de correction parité
 * v1↔PoC APRÈS un run live (étape 6). Pas de `verify.py` par scénario
 * (le harness hérité est sidecar/KG_HOME-centré ; la correction est déjà
 * prouvée par construction : 60/60 TS + 13 service + fumée ES 8/8). Ici =
 * un dump d'état FINAL diffable contre le `.kg.json` final du PoC.
 *
 * Prérequis : Revit ouvert sur le .rvt du run v1, add-in + Switch ON.
 *
 *   node kg_bridge/benchmark/live/v1_state_dump.mjs [port] [outFile]
 *     défauts : 8080  out/v1_state.kg.json
 *
 * Reconstruit `to_dict()` = data(graph) + action_log(log_chunks dépaquetés),
 * exactement comme `assembleProjectKG` (persist.ts). Clés triées
 * récursivement pour un diff textuel stable vs le `.kg.json` PoC
 * (json.dump sort_keys=True).
 */
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.argv[2] || 8080);
const OUT = process.argv[3] || "kg_bridge/benchmark/live/out/v1_state.kg.json";
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
        m.error ? reject(new Error(m.error.message || "Revit error"))
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

// tri récursif des clés (≡ json.dump(sort_keys=True) côté PoC) pour diff.
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

const r = unwrap(await rpc("kg_blob_read", {}), "kg_blob_read");
if (!r || !r.exists) {
  console.error("[v1_state_dump] aucune DataStorage KG (exists=false) — "
    + "le run v1 a-t-il tourné sur CE .rvt ?");
  process.exit(1);
}

const blob = JSON.parse(r.graph);            // LiveGraphBlob
const data = blob.data;                      // to_dict() SANS action_log
// log_chunks: string[] ; chunk = JSON.stringify(string[]) ; elt = JSON entry
const action_log = (r.log_chunks || [])
  .flatMap((c) => JSON.parse(c))
  .map((s) => JSON.parse(s));

const kgjson = sortKeys({ ...data, action_log });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(kgjson, null, 2), "utf-8");

console.log(`[v1_state_dump] project_id=${data.project_id} `
  + `nodes=${(data.nodes || []).length} edges=${(data.edges || []).length} `
  + `actions=${action_log.length} -> ${OUT}`);
console.log("Diff parité vs PoC : comparer à "
  + "<KG_HOME>\\<project_id>.kg.json (json trié des deux côtés).");
