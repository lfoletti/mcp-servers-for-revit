/**
 * seed_repro.mjs — rejoue le SEED du benchmark (00_seed.txt) contre le
 * KG en mémoire, HORS-LIGNE : zéro Revit, zéro API Claude, instantané.
 * Sert de débogueur rapide à la place du harness live facturable. Le bug
 * « seed timeout » est déterministe (un lot kg_add_element qui erre) ; on
 * le voit ici en ~10 ms avec le message enrichi par-élément (atItem).
 *
 *   node server/scripts/seed_repro.mjs
 *
 * Stratégie agent réaliste = quelques appels bulk **ordonnés par
 * dépendance** (le steering corrigé) : levels+type → murs → fenêtres.
 */
import { KgService } from "../build/kg/service.js";
import { BlobKgPersistence, InMemoryBlobTransport } from "../build/kg/persist.js";

const svc = new KgService(new BlobKgPersistence(new InMemoryBlobTransport()));
const PID = "Demo";

async function call(label, params) {
  try {
    const r = await svc.call("add_element", { project_id: PID, ...params });
    console.log(`OK   ${label}: count=${r.count} turn=${r.turn} ` +
      `edges_added=${r.edges_added} sample=${JSON.stringify(r.sample_ids.slice(0,3))}`);
    return r;
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message}`);
    return null;
  }
}

// --- 00_seed.txt, littéral ------------------------------------------------
// 2 Levels, 1 WallType GEN_200, 20 murs (1 m, bout à bout sur X, h 2.7),
// 8 fenêtres hostées sur les 8 premiers murs (sill 0.9, head 2.1).

const c1 = await call("levels+type", {
  elements: [
    { node_type: "Level", attrs: { name: "N0", elevation: 0 } },
    { node_type: "Level", attrs: { name: "N1", elevation: 3 } },
    { node_type: "WallType", attrs: { name: "GEN_200", total_thickness: 0.2 } },
  ],
});
if (!c1) process.exit(1);
const [n0, n1, gen200] = c1.sample_ids;

const c2 = await call("20 walls", {
  elements: Array.from({ length: 20 }, (_, i) => ({
    node_type: "Wall",
    attrs: {
      type_ref: gen200,
      level_ref: n0,
      p1: [i, 0],
      p2: [i + 1, 0],
      length: 1,
      height: 2.7,
    },
    edges: [
      { type: "at_level", to: n0 },
      { type: "is_type", to: gen200 },
    ],
  })),
});
const wallIds = c2 ? c2.sample_ids : [];

// Fenêtres : le prompt ne mentionne AUCUN type de fenêtre. Window exige
// `type_ref` (un FamilyType) + `host_wall_ref`. On tente tel quel pour
// voir l'erreur exacte (probable cause racine du thrash agent).
const c3 = await call("8 windows (no FamilyType, as prompt says)", {
  elements: Array.from({ length: 8 }, (_, i) => ({
    node_type: "Window",
    attrs: {
      host_wall_ref: wallIds[i] ?? "wall_001",
      position: [i + 0.5, 0],
      sill_height: 0.9,
      head_height: 2.1,
    },
  })),
});

// Variante : avec un FamilyType fenêtre créé d'abord.
console.log("\n-- variante : créer un FamilyType fenêtre d'abord --");
const cf = await call("FamilyType (window)", {
  elements: [
    {
      node_type: "FamilyType",
      attrs: { family_name: "W", type_name: "W-0610", category: "Windows" },
    },
  ],
});
if (cf) {
  const wt = cf.sample_ids[0];
  await call("8 windows (with type_ref + hosts edge)", {
    elements: Array.from({ length: 8 }, (_, i) => ({
      node_type: "Window",
      attrs: {
        type_ref: wt,
        host_wall_ref: wallIds[i] ?? "wall_001",
        position: [i + 0.5, 0],
        sill_height: 0.9,
        head_height: 2.1,
      },
      edges: [{ type: "hosts", from: wallIds[i] ?? "wall_001" }],
    })),
  });
}

const stats = await svc.call("stats", { project_id: PID });
console.log(`\nFINAL stats: nodes=${stats.nodes_total} ` +
  `edges=${stats.edges_total} turn=${stats.turn} ` +
  `by_type=${JSON.stringify(stats.by_type)}`);
