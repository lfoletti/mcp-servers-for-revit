/**
 * kg-rvt-reset.mjs — Stage-2 : remet le MODÈLE Revit à son état template.
 * Supprime toutes les instances Wall/Window/Door + tout Level NON
 * protégé (les défauts template "Niveau 0/1/2" — vérifiés step-1).
 * Raw socket, sans Claude, non facturable. À appeler entre scénarios
 * Stage-2 (la géométrie réelle s'accumule sinon → A/B confondus).
 *
 * Prérequis : Revit + Switch ON, serveur buildé. Node conda revitmcp.
 *   node server/scripts/kg-rvt-reset.mjs
 */
import net from "node:net";
const PROTECTED_LEVELS = new Set(["Niveau 0", "Niveau 1", "Niveau 2"]);
function rpc(method, params) {
  return new Promise((res, rej) => {
    const s = net.connect(8080, "127.0.0.1");
    let b = "";
    const to = setTimeout(() => { s.destroy(); rej(new Error("timeout " + method)); }, 90000);
    s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: "r" })));
    s.on("data", (d) => { b += d; try { const m = JSON.parse(b); clearTimeout(to); s.end(); res(m); } catch {} });
    s.on("error", (e) => { clearTimeout(to); rej(e); });
  });
}
const R = (m) => (m.result ?? m.error);
async function filt(cat) {
  const m = await rpc("ai_element_filter", { data: { filterCategory: cat, includeInstances: true, includeTypes: false, filterVisibleInCurrentView: false, filterFamilySymbolId: "-1" } });
  const r = R(m); const a = r?.Response ?? r?.response ?? r;
  return Array.isArray(a) ? a : [];
}
const ids = [];
for (const cat of ["OST_Windows", "OST_Doors", "OST_Walls"]) {
  const els = await filt(cat);
  console.log(`${cat}: ${els.length} instance(s)`);
  ids.push(...els.map((e) => e.Id).filter((x) => Number.isInteger(x)));
}
const levels = await filt("OST_Levels");
const killLv = levels.filter((l) => !PROTECTED_LEVELS.has(l.Name));
console.log(`OST_Levels: ${levels.length} (protected ${levels.length - killLv.length}, deleting ${killLv.length}: ${killLv.map((l) => l.Name).join(",") || "-"})`);
ids.push(...killLv.map((l) => l.Id).filter((x) => Number.isInteger(x)));

if (ids.length) {
  const d = await rpc("delete_element", { elementIds: ids });
  console.log(`delete_element ${ids.length} -> ${JSON.stringify(R(d)).slice(0, 160)}`);
} else {
  console.log("nothing to delete (already at template baseline)");
}
const after = { Walls: (await filt("OST_Walls")).length, Windows: (await filt("OST_Windows")).length, Levels: (await filt("OST_Levels")).length };
console.log("AFTER:", JSON.stringify(after), "(expect Walls=0 Windows=0 Levels=3)");
console.log("[kg-rvt-reset] terminé.");
