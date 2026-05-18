/**
 * service.test.ts — vérifie le KG en-process v1 (étape 4, §10.4) qui
 * remplace le sidecar Python, SANS Revit : `InMemoryBlobTransport` (étape 2)
 * tient lieu d'ExtensibleStorage. Filet « ne pas perdre la suite » (§7) :
 * porte l'esprit de `kg_bridge/smoke_test.py` + prouve persistance/reload et
 * rollback atomique. Même runner zéro-dep que les étapes 1–2.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { KgService } from "../service.js";
import { BlobKgPersistence, InMemoryBlobTransport } from "../persist.js";
import type { KgDocStateProvider } from "../transport.js";

/** Provider §5 pilotable : simule ouverture/bascule de document (docKey)
 *  et changement hors-bande / Sync (epoch) sans Revit. */
class FakeDocState implements KgDocStateProvider {
  epoch = 0;
  docKey = "doc-A";
  async getState() {
    return { epoch: this.epoch, docKey: this.docKey };
  }
}

/** Service neuf + le store qu'il utilise (réutilisable pour tester le
 *  reload depuis l'ES via un SECOND service au cache vide). */
function make(): { svc: KgService; store: BlobKgPersistence } {
  const store = new BlobKgPersistence(new InMemoryBlobTransport());
  return { svc: new KgService(store), store };
}

const PID = "default";

// ----- CRUD + persistance -------------------------------------------------

test("add_element persists and round-trips through the store", async () => {
  const { svc, store } = make();
  const r = await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0.0 },
  });
  assert.equal(r.llm_id, "level_001");
  assert.equal(r.turn, 1); // 1 op MCP == 1 turn
  assert.equal(r.edges_added, 0);

  // Un service NEUF (cache vide) qui partage le store doit recharger le
  // graphe depuis l'ES — c'est tout l'intérêt v1 (survit au restart).
  const svc2 = new KgService(store);
  const q = await svc2.call("query", { project_id: PID });
  assert.equal(q.count, 1);
  assert.equal(q.nodes[0].llm_id, "level_001");
  assert.equal(q.nodes[0].type, "Level");
});

test("add_element wires typed edges (to / from)", async () => {
  const { svc } = make();
  const lvl = await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const wt = await svc.call("add_element", {
    project_id: PID,
    node_type: "WallType",
    attrs: { name: "STD200", total_thickness: 0.2 },
  });
  const wall = await svc.call("add_element", {
    project_id: PID,
    node_type: "Wall",
    attrs: {
      type_ref: wt.llm_id,
      level_ref: lvl.llm_id,
      p1: [0, 0],
      p2: [5, 0],
      length: 5,
      height: 3,
    },
    edges: [
      { type: "at_level", to: lvl.llm_id },
      { type: "is_type", to: wt.llm_id },
    ],
  });
  assert.equal(wall.edges_added, 2);
  const q = await svc.call("query", {
    project_id: PID,
    node_type: "Wall",
  });
  assert.equal(q.edges.length, 2);
  assert.deepEqual(
    q.edges.map((e: any) => e.type).sort(),
    ["at_level", "is_type"]
  );
});

test("modify_element records history; diff_since reports it", async () => {
  const { svc } = make();
  const a = await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const m = await svc.call("modify_element", {
    project_id: PID,
    llm_id: a.llm_id,
    updates: { elevation: 3.0 },
  });
  assert.equal(m.turn, 2);
  assert.deepEqual(m.modified_at_turn, [2]);

  const d = await svc.call("diff_since", {
    project_id: PID,
    since_turn: 2,
  });
  assert.equal(d.action_count, 1);
  assert.equal(d.actions[0].action, "modify");
  assert.equal(d.current_turn, 2);
});

test("soft_delete hides from default query, kept with include_deleted", async () => {
  const { svc } = make();
  const a = await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const s = await svc.call("soft_delete", {
    project_id: PID,
    llm_id: a.llm_id,
  });
  assert.equal(s.deleted_at_turn, 2);

  assert.equal((await svc.call("query", { project_id: PID })).count, 0);
  const all = await svc.call("query", {
    project_id: PID,
    include_deleted: true,
  });
  assert.equal(all.count, 1);
});

// ----- projections fidèles au sidecar -------------------------------------

test("query compact returns counts/ids only; node_view keeps `id` in attrs", async () => {
  const { svc } = make();
  await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const c = await svc.call("query", { project_id: PID, compact: true });
  assert.deepEqual(c, {
    count: 1,
    by_type: { Level: 1 },
    ids: ["level_001"],
    edges_count: 0,
  });

  const full = await svc.call("query", { project_id: PID });
  // Quirk porté **fidèlement** du sidecar `_node_view` : la clé `id`
  // reste dans `attrs` (ne pop que _type + 3 attrs de cycle de vie).
  assert.equal(full.nodes[0].attrs.id, "level_001");
  assert.equal(full.nodes[0].attrs.name, "N00");
});

test("schema and stats expose the typed model", async () => {
  const { svc } = make();
  const sch = await svc.call("schema", {});
  assert.deepEqual(sch.node_types.Level.required.sort(), [
    "elevation",
    "name",
  ]);
  assert.ok(sch.edge_types.includes("at_level"));

  await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const st = await svc.call("stats", { project_id: PID });
  assert.equal(st.nodes_total, 1);
  assert.equal(st.turn, 1);
  assert.deepEqual(st.by_type, { Level: { live: 1, deleted: 0 } });
});

// ----- bulk + select-and-mutate ------------------------------------------

test("add_many / modify_many are atomic, one turn, compact return", async () => {
  const { svc } = make();
  const add = await svc.call("add_many", {
    project_id: PID,
    items: [
      { node_type: "Level", attrs: { name: "A", elevation: 0 } },
      { node_type: "Level", attrs: { name: "B", elevation: 3 } },
    ],
  });
  assert.equal(add.count, 2);
  assert.equal(add.turn, 1); // N items, ONE turn
  assert.equal(add.truncated, false);

  const mod = await svc.call("modify_many", {
    project_id: PID,
    items: add.sample_ids.map((id: string) => ({
      llm_id: id,
      updates: { elevation: 9 },
    })),
  });
  assert.equal(mod.count, 2);
  assert.equal(mod.turn, 2);
});

test("modify_where filters by predicates and mutates atomically", async () => {
  const { svc } = make();
  await svc.call("add_many", {
    project_id: PID,
    items: [
      { node_type: "Level", attrs: { name: "low", elevation: 0 } },
      { node_type: "Level", attrs: { name: "mid", elevation: 5 } },
      { node_type: "Level", attrs: { name: "high", elevation: 9 } },
    ],
  });
  const r = await svc.call("modify_where", {
    project_id: PID,
    node_type: "Level",
    where: [{ attr: "elevation", op: "lt", value: 6 }],
    updates: { elevation: 1 },
  });
  assert.equal(r.matched, 2);
  assert.equal(r.modified, 2);

  const q = await svc.call("query", { project_id: PID });
  const elevs = q.nodes.map((n: any) => n.attrs.elevation).sort();
  assert.deepEqual(elevs, [1, 1, 9]);
});

// ----- atomicité : rien ne fuit ni en mémoire ni dans l'ES ----------------

test("transaction_demo rolls back the failing default batch cleanly", async () => {
  const { svc } = make();
  const r = await svc.call("transaction_demo", { project_id: PID });
  assert.equal(r.rolled_back_cleanly, true);
  assert.equal(r.error, "ValueError: Unknown node type: Frobnicator");
  assert.deepEqual(r.before, r.after);
  assert.equal(r.after.nodes_total, 0);
  assert.equal(r.after.turn, 0);
});

test("a failed mutation persists NOTHING (memory + store both intact)", async () => {
  const { svc, store } = make();
  await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  // node_type inconnu → ValueError ; doit rejeter, sans rien persister.
  await assert.rejects(
    () =>
      svc.call("add_element", {
        project_id: PID,
        node_type: "Frobnicator",
        attrs: {},
      }),
    /Unknown node type/
  );
  // Mémoire : toujours 1 node, turn inchangé.
  const q = await svc.call("query", { project_id: PID });
  assert.equal(q.count, 1);
  // ES : un service neuf rechargé voit le MÊME état (pas de demi-écriture).
  const svc2 = new KgService(store);
  const q2 = await svc2.call("query", { project_id: PID });
  assert.equal(q2.count, 1);
  assert.equal((await svc2.call("stats", { project_id: PID })).turn, 1);
});

// ----- divers -------------------------------------------------------------

test("reset clears cache and zeroes the persisted graph", async () => {
  const { svc, store } = make();
  await svc.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const rst = await svc.call("reset", { project_id: PID });
  assert.equal(rst.removed, true);
  assert.equal((await svc.call("query", { project_id: PID })).count, 0);
  const svc2 = new KgService(store);
  assert.equal((await svc2.call("query", { project_id: PID })).count, 0);
});

test("unknown method rejects", async () => {
  const { svc } = make();
  await assert.rejects(() => svc.call("nope", {}), /unknown method: nope/);
});

// ----- cohérence cache↔.rvt (§5, étape 5) ---------------------------------

test("stable epoch ⇒ long-lived cache (does not reload mid-session)", async () => {
  const store = new BlobKgPersistence(new InMemoryBlobTransport());
  const fake = new FakeDocState();
  const a = new KgService(store, fake);

  await a.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  // Un AUTRE writer persiste un 2ᵉ node dans le MÊME store (= édition
  // hors-bande du blob ES), mais l'epoch ne bouge pas.
  const b = new KgService(store, new FakeDocState());
  await b.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N01", elevation: 3 },
  });
  // `a` garde son cache (epoch/doc inchangés) ⇒ lecture « périmée ».
  assert.equal((await a.call("query", { project_id: PID })).count, 1);
});

test("epoch bump (out-of-band / Sync) ⇒ reload from ES", async () => {
  const store = new BlobKgPersistence(new InMemoryBlobTransport());
  const fake = new FakeDocState();
  const a = new KgService(store, fake);

  await a.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const b = new KgService(store, new FakeDocState());
  await b.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N01", elevation: 3 },
  });

  fake.epoch += 1; // signal : le .rvt a changé sous nous
  assert.equal((await a.call("query", { project_id: PID })).count, 2);
});

test("docKey change (document opened/switched) ⇒ reload from ES", async () => {
  const store = new BlobKgPersistence(new InMemoryBlobTransport());
  const fake = new FakeDocState();
  const a = new KgService(store, fake);

  await a.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N00", elevation: 0 },
  });
  const b = new KgService(store, new FakeDocState());
  await b.call("add_element", {
    project_id: PID,
    node_type: "Level",
    attrs: { name: "N01", elevation: 3 },
  });

  fake.docKey = "doc-B"; // un autre document a été ouvert
  assert.equal((await a.call("query", { project_id: PID })).count, 2);
});

test("calls are serialized (no interleaving corrupts the graph)", async () => {
  const { svc } = make();
  // 25 ajouts concurrents : la file interne doit les sérialiser → 25 nodes,
  // turns 1..25 sans collision (le snapshot/rollback n'est pas réentrant).
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      svc.call("add_element", {
        project_id: PID,
        node_type: "Level",
        attrs: { name: `N${i}`, elevation: i },
      })
    )
  );
  const st = await svc.call("stats", { project_id: PID });
  assert.equal(st.nodes_total, 25);
  assert.equal(st.turn, 25);
});
