/**
 * persist.test.ts — vérifie le contrat de persistance v1 (étape 2, DESIGN-
 * internalize-es.md §10.2) SANS aucun transport réel : `InMemoryBlobTransport`
 * exerce tout le contrat avant que les commandes C# (étape 3) n'existent —
 * c'est la preuve que `persist.ts` est bien agnostique du transport.
 *
 * Filet "ne pas perdre la suite" (§7) : même runner que l'étape 1
 * (`node:test`, zéro dépendance, `tsconfig.test.json` + `npm test`).
 * N'instancie `core/` (figé `beacfb6`) que via sa surface publique.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ProjectKG } from "../core/index.js";
import {
  BlobKgPersistence,
  GRAPH_SCHEMA_VERSION,
  InMemoryBlobTransport,
  KgPersistenceError,
  LOG_SCHEMA_VERSION,
  NotImplementedPersistence,
  assembleProjectKG,
  loadProjectKG,
  packChunk,
  readEntriesFromChunks,
  saveProjectKG,
  splitProjectKG,
  unpackChunk,
} from "../persist.js";
import type { KgBlobRecord, KgPersistence } from "../persist.js";

// ----- helpers ------------------------------------------------------------

/** KG réaliste : Level + WallType + Wall, 2 arêtes, 1 modify, 2 revit ids. */
function seed(projectId = "proj"): {
  kg: ProjectKG;
  wall: string;
  level: string;
} {
  const kg = new ProjectKG(projectId);
  kg.advance_turn(); // turn 1
  const level = kg.add_node("Level", { name: "N00", elevation: 0.0 });
  const wt = kg.add_node("WallType", {
    name: "STD200",
    total_thickness: 0.2,
  });
  const wall = kg.add_node("Wall", {
    type_ref: wt,
    level_ref: level,
    p1: [0, 0],
    p2: [5, 0],
    length: 5.0,
    height: 3.0,
  });
  kg.add_edge(wall, level, "at_level");
  kg.add_edge(wall, wt, "is_type");
  kg.advance_turn(); // turn 2
  kg.modify_node(wall, { length: 6.0 });
  kg.set_revit_id(wall, 123456);
  kg.set_revit_id(level, 222);
  return { kg, wall, level };
}

const fresh = () => new BlobKgPersistence(new InMemoryBlobTransport());

/** entry de log opaque (JSON {turn,...}) — cohérent avec le `turnOf` défaut. */
const entry = (turn: number, tag = "x"): string =>
  JSON.stringify({ turn, action: tag, target: "n", details: {} });

// ----- round-trip core/ <-> blob ------------------------------------------

test("saveProjectKG/loadProjectKG round-trips to_dict exactly", async () => {
  const { kg } = seed();
  const store = fresh();
  await saveProjectKG(store, kg);

  const loaded = await loadProjectKG(store, kg.project_id);
  assert.ok(loaded !== null);
  assert.deepStrictEqual(loaded.to_dict(), kg.to_dict());
});

test("round-trip preserves turn, counters, revit binding", async () => {
  const { kg, wall, level } = seed();
  const store = fresh();
  await saveProjectKG(store, kg);
  const loaded = (await loadProjectKG(store, kg.project_id))!;

  assert.equal(loaded.turn, 2);
  assert.deepStrictEqual(loaded._counters, kg._counters);
  assert.equal(loaded.get_revit_id(wall), 123456);
  assert.equal(loaded.get_revit_id(level), 222);
  assert.equal(loaded.find_by_revit_id(123456), wall);
  // action_log survit (modify émis au tour 2)
  assert.deepStrictEqual(loaded.action_log, kg.action_log);
  assert.ok(loaded.action_log.some((a) => a.action === "modify"));
});

test("splitProjectKG -> assembleProjectKG is identity on to_dict", () => {
  const { kg } = seed();
  const { graph, log } = splitProjectKG(kg);
  const rebuilt = assembleProjectKG(graph, log);
  assert.deepStrictEqual(rebuilt.to_dict(), kg.to_dict());
});

test("splitProjectKG projects the ElementId->llm_id binding", () => {
  const { kg, wall, level } = seed();
  const { graph } = splitProjectKG(kg);
  assert.equal(graph.revit_binding[123456], wall);
  assert.equal(graph.revit_binding[222], level);
  assert.equal(graph.schema_version, GRAPH_SCHEMA_VERSION);
  // `action_log` n'est PAS dans le graphe (conteneurs distincts, §4)
  assert.ok(!("action_log" in (graph.data as Record<string, unknown>)));
});

// ----- absence / DataStorage manquante ------------------------------------

test("loadProjectKG returns null when nothing persisted", async () => {
  assert.equal(await loadProjectKG(fresh(), "never-saved"), null);
});

test("loadGraph null / loadLog empty when DataStorage absent", async () => {
  const store = fresh();
  assert.equal(await store.loadGraph("absent"), null);
  assert.deepStrictEqual(await store.loadLog("absent"), {
    schema_version: LOG_SCHEMA_VERSION,
    chunks: [],
  });
});

test("purge (Purge Unused / .rvt closed) makes the graph reload as null", async () => {
  const { kg } = seed();
  const transport = new InMemoryBlobTransport();
  const store = new BlobKgPersistence(transport);
  await saveProjectKG(store, kg);
  assert.ok(transport.has(kg.project_id));

  transport.purge(kg.project_id);
  assert.equal(await loadProjectKG(store, kg.project_id), null);
});

// ----- les deux conteneurs ne se piétinent pas ----------------------------

test("saveGraph does not clobber the log, appendLog does not clobber the graph", async () => {
  const { kg } = seed();
  const { graph } = splitProjectKG(kg);
  const store = fresh();

  await store.appendLog("k", ["a", "b"]);
  await store.saveGraph("k", graph); // ne doit pas écraser a,b
  assert.deepStrictEqual(readEntriesFromChunks((await store.loadLog("k")).chunks), [
    "a",
    "b",
  ]);

  await store.appendLog("k", ["c"]); // ne doit pas écraser le graphe
  const g = await store.loadGraph("k");
  assert.ok(g !== null);
  assert.deepStrictEqual(g.data, graph.data);
  assert.deepStrictEqual(
    readEntriesFromChunks((await store.loadLog("k")).chunks),
    ["a", "b", "c"]
  );
});

// ----- chunking (plafond 16 Mo/string ES, §3/§4) --------------------------

test("split chunks the log under the byte cap, order exactly preserved", () => {
  const kg = new ProjectKG("c");
  kg.advance_turn();
  for (let i = 0; i < 60; i++) {
    kg.add_node("Level", { name: `N${i}`, elevation: i });
  }
  const cap = 400;
  const { log } = splitProjectKG(kg, cap);

  assert.ok(log.chunks.length > 1, "doit produire plusieurs chunks");
  assert.ok(
    log.chunks.length < kg.action_log.length,
    "doit empaqueter >1 entry par chunk"
  );
  for (const c of log.chunks) {
    // Invariant : un chunk ne dépasse le cap QUE s'il est mono-entry.
    const oversize = Buffer.byteLength(c, "utf8") > cap;
    if (oversize) assert.equal(unpackChunk(c).length, 1);
  }
  // Reconstruction strictement ordonnée == action_log d'origine.
  const back = readEntriesFromChunks(log.chunks).map((s) => JSON.parse(s));
  assert.deepStrictEqual(back, kg.action_log);
});

test("appendLog keeps sealed chunks byte-stable and order intact", async () => {
  const store = new BlobKgPersistence(new InMemoryBlobTransport(), {
    maxChunkBytes: 40,
  });
  // ~27 octets/entry → packChunk d'1 entry < 40, de 2 entries > 40 :
  // chaque entry scelle son propre chunk (A produit 5 chunks scellés).
  const A = [1, 2, 3, 4, 5].map((i) => `A${i}`.padEnd(25, "-"));
  const B = [1, 2, 3].map((i) => `B${i}`.padEnd(25, "-"));

  await store.appendLog("k", A);
  const before = (await store.loadLog("k")).chunks;
  assert.ok(before.length >= 2, "A doit déjà sceller >=1 chunk");

  await store.appendLog("k", B);
  const after = (await store.loadLog("k")).chunks;

  // Le 1er chunk scellé est identique octet-pour-octet (append stable).
  assert.equal(after[0], before[0]);
  assert.deepStrictEqual(readEntriesFromChunks(after), [...A, ...B]);
});

// ----- compaction (politique : par chunk entier) --------------------------

test("compactLog prunes only fully-stale chunks, keeps straddling whole", async () => {
  const transport = new InMemoryBlobTransport();
  const rec: KgBlobRecord = {
    graph: "",
    log_chunks: [
      packChunk([entry(1), entry(1)]), // max turn 1
      packChunk([entry(2), entry(3)]), // à cheval sur keepFromTurn=3
      packChunk([entry(5)]), // récent
    ],
    log_schema_version: LOG_SCHEMA_VERSION,
  };
  await transport.write("k", rec);
  const store = new BlobKgPersistence(transport);

  await store.compactLog("k", 3);
  const turns = readEntriesFromChunks((await store.loadLog("k")).chunks).map(
    (s) => JSON.parse(s).turn
  );
  // chunk0 (max 1) élagué ; chunk1 gardé ENTIER (turn 2 survit) ; chunk2 gardé.
  assert.deepStrictEqual(turns, [2, 3, 5]);
});

test("compactLog past every turn empties the log", async () => {
  const transport = new InMemoryBlobTransport();
  await transport.write("k", {
    graph: "",
    log_chunks: [packChunk([entry(1)]), packChunk([entry(2)])],
    log_schema_version: LOG_SCHEMA_VERSION,
  });
  const store = new BlobKgPersistence(transport);
  await store.compactLog("k", 99);
  assert.deepStrictEqual((await store.loadLog("k")).chunks, []);
});

test("compactLog is a no-op on absent DataStorage", async () => {
  await fresh().compactLog("absent", 5); // ne doit pas lever
});

// ----- robustesse : schéma trop récent / blob corrompu --------------------

test("assembleProjectKG rejects a forward-incompatible graph schema", () => {
  const { kg } = seed();
  const { graph, log } = splitProjectKG(kg);
  graph.schema_version = GRAPH_SCHEMA_VERSION + 1;
  assert.throws(
    () => assembleProjectKG(graph, log),
    (e: unknown) =>
      e instanceof KgPersistenceError && /forward-incompat/.test(e.message)
  );
});

test("loadGraph rejects a forward-incompatible blob, loadLog a forward log", async () => {
  const transport = new InMemoryBlobTransport();
  await transport.write("k", {
    graph: JSON.stringify({
      schema_version: GRAPH_SCHEMA_VERSION + 1,
      data: {},
      revit_binding: {},
    }),
    log_chunks: [],
    log_schema_version: LOG_SCHEMA_VERSION + 1,
  });
  const store = new BlobKgPersistence(transport);
  await assert.rejects(() => store.loadGraph("k"), KgPersistenceError);
  await assert.rejects(() => store.loadLog("k"), KgPersistenceError);
});

test("corrupt graph / corrupt chunk raise KgPersistenceError", async () => {
  const transport = new InMemoryBlobTransport();
  await transport.write("k", {
    graph: "{ not json",
    log_chunks: [],
    log_schema_version: LOG_SCHEMA_VERSION,
  });
  await assert.rejects(
    () => new BlobKgPersistence(transport).loadGraph("k"),
    KgPersistenceError
  );
  assert.throws(() => unpackChunk("nope"), KgPersistenceError);
  assert.throws(() => unpackChunk(JSON.stringify([1, 2])), KgPersistenceError);
});

test("assembleProjectKG enforces the expected project_id", () => {
  const { kg } = seed("A");
  const { graph, log } = splitProjectKG(kg);
  assert.throws(
    () => assembleProjectKG(graph, log, null, "B"),
    KgPersistenceError
  );
});

// ----- transport en mémoire : isolation comme une vraie frontière ---------

test("InMemoryBlobTransport deep-clones (no shared mutable state)", async () => {
  const t = new InMemoryBlobTransport();
  const rec: KgBlobRecord = {
    graph: "g",
    log_chunks: ["x"],
    log_schema_version: LOG_SCHEMA_VERSION,
  };
  await t.write("k", rec);
  rec.log_chunks.push("MUTATED"); // mutation après write
  const read1 = (await t.read("k"))!;
  read1.log_chunks.push("ALSO MUTATED"); // mutation d'une lecture
  const read2 = (await t.read("k"))!;
  assert.deepStrictEqual(read2.log_chunks, ["x"]);
});

// ----- sentinelle : aucun transport câblé ---------------------------------

test("NotImplementedPersistence fails loud on every method", () => {
  const p: KgPersistence = new NotImplementedPersistence();
  for (const call of [
    () => p.loadGraph("k"),
    () => p.saveGraph("k", {} as never),
    () => p.loadLog("k"),
    () => p.appendLog("k", []),
    () => p.compactLog("k", 0),
  ]) {
    assert.throws(call, KgPersistenceError);
  }
});
