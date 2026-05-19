/**
 * verify_rvt.mjs — Stage-2 .rvt-TRUTH reader. Lit l'état RÉEL du modèle
 * Revit (raw socket `ai_element_filter`, document-wide, sans Claude) et
 * en tire des faits DÉTERMINISTES : comptes/catégorie, niveau d'un mur,
 * hauteur d'un mur (z-extent de BoundingBox), fenêtres.
 * Base du grading Stage-2 : P1 déterministe ; P3 host claim-graded
 * (§4bis — host non exposé). Importable (readTruth) + CLI (résumé).
 *
 *   node kg_bridge/benchmark/stage2/verify_rvt.mjs
 */
import net from "node:net";
function rpc(method, params) {
  return new Promise((res, rej) => {
    const s = net.connect(8080, "127.0.0.1");
    let b = "";
    const to = setTimeout(() => { s.destroy(); rej(new Error("timeout " + method)); }, 90000);
    s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", method, params, id: "v" })));
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
function bboxHeight(bb) {
  if (!bb) return null;
  const lo = bb.Min ?? bb.min ?? bb.p0, hi = bb.Max ?? bb.max ?? bb.p1;
  if (!lo || !hi) return null;
  const z0 = lo.Z ?? lo.z, z1 = hi.Z ?? hi.z;
  return (z0 == null || z1 == null) ? null : Math.round((z1 - z0) * 10) / 10;
}
export async function readTruth() {
  const levels = await filt("OST_Levels");
  const walls = await filt("OST_Walls");
  const windows = await filt("OST_Windows");
  return {
    counts: { Levels: levels.length, Walls: walls.length, Windows: windows.length },
    levels: levels.map((l) => ({ Id: l.Id, Name: l.Name, Elevation: l.Elevation })),
    walls: walls.map((w) => ({ Id: w.Id, Level: w.Level, height: bboxHeight(w.BoundingBox), type: w.FamilyName })),
    windows: windows.map((w) => ({ Id: w.Id, Level: w.Level, type: w.FamilyName })),
  };
}
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("verify_rvt.mjs")) {
  const t = await readTruth();
  console.log(JSON.stringify(t, null, 1));
}
