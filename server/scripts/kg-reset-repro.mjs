/**
 * kg-reset-repro.mjs — remet à ZÉRO le blob ES pour les project_id de
 * repro (`Demo-repro`, `Demo-repro-oneshot`) AVANT de relancer
 * `kg-durability-repro.mjs`. Sans ça, un blob laissé par une sonde
 * précédente fait dup-rejeter le palier « fondation » (atomique) et
 * invalide le test. `reset` = un petit write (graphe vide) → toujours
 * sous la limite socket entrante C#, donc fiable.
 *
 * Prérequis identiques à kg-durability-repro : Revit + Switch ON +
 * serveur TS buildé. Node de l'env conda `revitmcp`.
 *   node server/scripts/kg-reset-repro.mjs
 */
const { KgService } = await import(
  new URL("../build/kg/service.js", import.meta.url)
);
const svc = new KgService();
for (const pid of ["Demo-repro", "Demo-repro-oneshot"]) {
  try {
    const r = await svc.call("reset", { project_id: pid });
    const q = await svc.call("query", { project_id: pid, compact: true });
    console.log(`[reset] ${pid}: removed=${r.removed} → count=${q.count}/${q.edges_count}`);
  } catch (e) {
    console.error(`[reset] ${pid}: ÉCHEC — ${e.message || e}`);
    process.exitCode = 1;
  }
}
console.log("[kg-reset-repro] terminé.");
