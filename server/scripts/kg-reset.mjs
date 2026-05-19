/**
 * kg-reset.mjs — vide le KG. Générique (vs kg-reset-repro.mjs qui ne
 * cible que les pids de sonde). project_ids en args (défaut: "Demo").
 *
 * L'ES v1 `.rvt` est MONO-projet (un seul blob) : écrire un `ProjectKG`
 * vide pour n'importe quel project_id REMPLACE tout le blob → un seul
 * reset suffit à isoler le set suivant, quel que soit le project_id que
 * l'agent finira par utiliser. Indispensable entre 2 sets de benchmark
 * v1 (run_live ne vide PAS l'ES `.rvt` pour le profil v1, contrairement
 * au PoC dont il vide KG_HOME) — sinon les graphes s'accumulent et l'A/B
 * est confondu.
 *
 * Prérequis : Revit + Switch ON + serveur TS buildé. Node conda revitmcp.
 *   node server/scripts/kg-reset.mjs [pid ...]
 */
const { KgService } = await import(
  new URL("../build/kg/service.js", import.meta.url)
);
const pids = process.argv.slice(2);
if (pids.length === 0) pids.push("Demo");
const svc = new KgService();
for (const pid of pids) {
  try {
    const r = await svc.call("reset", { project_id: pid });
    const q = await svc.call("query", { project_id: pid, compact: true });
    console.log(
      `[kg-reset] ${pid}: removed=${r.removed} -> count=${q.count}/${q.edges_count}`
    );
  } catch (e) {
    console.error(`[kg-reset] ${pid}: ECHEC - ${e.message || e}`);
    process.exitCode = 1;
  }
}
console.log("[kg-reset] termine.");
