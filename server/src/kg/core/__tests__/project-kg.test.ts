/**
 * project-kg.test.ts — portage **1:1** de
 * `claude-in-revit/tests/test_project_kg.py` (référence figée, byte-for-byte
 * vs `kg_bridge/vendor/project_kg.py` — SHA256 vérifié identique).
 *
 * Chemin critique de la v1 (DESIGN-internalize-es.md §7/§10) : supprimer le
 * sidecar Python retire le filet "tests passants". Cette suite doit être
 * **verte et iso-comportement** vs le fichier Python. Runner : `node:test`
 * intégré, zéro dépendance (cf. `tsconfig.test.json` + `npm test`).
 *
 * Correspondance pytest → node:test :
 *   - `pytest.raises(ValueError, match=...)`  → `raises(ValueError, fn, /.../)`
 *   - `pytest.raises(KeyError)`               → `raises(KeyError, fn)`
 *   - `pytest.raises(RuntimeError, match=..)` → `raises(/boom/, fn)` (pas de
 *     RuntimeError en JS : on lève `Error` et on matche le message)
 *   - `tmp_path / "kg.json"`                  → `mkdtempSync` + cleanup
 *   - `assert x is None`                      → `=== null`
 *   - égalité dict/list                       → `assert.deepStrictEqual`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CREATED_AT,
  DELETED_AT,
  MODIFIED_AT,
  REVIT_ID,
  ProjectKG,
  KeyError,
  ValueError,
} from "../index.js";

// ----- helpers (pendants de pytest) -----------------------------------

type ErrCtor = new (...args: any[]) => Error;

function raises(
  expected: ErrCtor | RegExp,
  fn: () => void,
  match?: RegExp
): void {
  assert.throws(fn, (err: any) => {
    if (expected instanceof RegExp) {
      assert.match(String(err?.message), expected);
      return true;
    }
    assert.ok(
      err instanceof expected,
      `expected ${expected.name}, got ${err?.name}: ${err?.message}`
    );
    if (match) assert.match(String(err?.message), match);
    return true;
  });
}

function withTmp(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kg-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function _seed(kg: ProjectKG): [string, string] {
  kg.advance_turn(); // turn 1
  const level = kg.add_node("Level", { name: "N00", elevation: 0.0 });
  const wt = kg.add_node("WallType", { name: "STD200", total_thickness: 0.2 });
  return [level, wt];
}

// ----- tests ----------------------------------------------------------

test("add_node assigns llm_id and lifecycle attrs", () => {
  const kg = new ProjectKG("p");
  kg.advance_turn();
  const nid = kg.add_node("Level", { name: "N00", elevation: 0.0 });
  assert.equal(nid, "level_001");
  const node = kg.get_node(nid);
  assert.equal(node[CREATED_AT], 1);
  assert.deepStrictEqual(node[MODIFIED_AT], []);
  assert.equal(node[DELETED_AT], null);
  assert.equal(node["_type"], "Level");
});

test("add_node rejects unknown type", () => {
  const kg = new ProjectKG("p");
  raises(ValueError, () => kg.add_node("Sofa", { name: "x" }), /Unknown node type/);
});

test("add_node rejects missing required attrs", () => {
  const kg = new ProjectKG("p");
  raises(
    ValueError,
    () => kg.add_node("Level", { name: "N00" }), // missing elevation
    /Missing required/
  );
});

test("add_node rejects unknown attrs", () => {
  const kg = new ProjectKG("p");
  raises(
    ValueError,
    () => kg.add_node("Level", { name: "N00", elevation: 0.0, color: "red" }),
    /Unknown attrs/
  );
});

test("modify_node logs history and marks modified_at_turn", () => {
  const kg = new ProjectKG("p");
  const [, wt] = _seed(kg);
  kg.advance_turn(); // turn 2
  kg.modify_node(wt, { total_thickness: 0.25 });
  const node = kg.get_node(wt);
  assert.equal(node["total_thickness"], 0.25);
  assert.deepStrictEqual(node[MODIFIED_AT], [2]);
  const log = kg.action_log;
  assert.equal(log[log.length - 1]["action"], "modify");
  assert.deepStrictEqual(log[log.length - 1]["details"]["before"], {
    total_thickness: 0.2,
  });
});

test("soft_delete marks node and excludes from default queries", () => {
  const kg = new ProjectKG("p");
  const [level] = _seed(kg);
  kg.advance_turn();
  kg.soft_delete(level);
  assert.equal(kg.get_node(level)[DELETED_AT], 2);
  assert.deepStrictEqual(kg.find_by_type("Level"), []);
  assert.deepStrictEqual(kg.find_by_type("Level", true), [level]);
});

test("add_edge validates type and endpoints", () => {
  const kg = new ProjectKG("p");
  const [level, wt] = _seed(kg);
  raises(
    ValueError,
    () => kg.add_edge(level, wt, "is_friends_with"),
    /Unknown edge type/
  );
  raises(KeyError, () => kg.add_edge(level, "wall_999", "at_level"));
});

test("persistence roundtrip", () => {
  withTmp((dir) => {
    const persist = join(dir, "kg.json");
    const kg = new ProjectKG("p", persist);
    const [level, wt] = _seed(kg);
    kg.add_edge(level, wt, "at_level"); // edge type doesn't matter here
    kg.persist();

    const loaded = ProjectKG.load(persist);
    assert.equal(loaded.project_id, "p");
    assert.equal(loaded.turn, 1);
    assert.deepStrictEqual(loaded.find_by_type("Level"), [level]);
    assert.deepStrictEqual(loaded.find_by_type("WallType"), [wt]);
    assert.deepStrictEqual(loaded.action_log, kg.action_log);
    assert.equal(loaded._g.number_of_edges(), 1); // edges survived
  });
});

test("transaction persists on success", () => {
  withTmp((dir) => {
    const persist = join(dir, "kg.json");
    const kg = new ProjectKG("p", persist);
    kg.transaction(() => {
      kg.advance_turn();
      kg.add_node("Level", { name: "N00", elevation: 0.0 });
    });
    assert.ok(existsSync(persist));
    const loaded = ProjectKG.load(persist);
    assert.ok(loaded.find_by_type("Level").length > 0);
  });
});

test("transaction rolls back on exception", () => {
  withTmp((dir) => {
    const persist = join(dir, "kg.json");
    const kg = new ProjectKG("p", persist);
    _seed(kg);
    kg.persist();
    const pre_log = kg.action_log;
    const pre_levels = kg.find_by_type("Level");

    raises(/boom/, () => {
      kg.transaction(() => {
        kg.advance_turn();
        kg.add_node("Level", { name: "rollback_me", elevation: 5.0 });
        throw new Error("boom");
      });
    });

    // In-memory state restored
    assert.deepStrictEqual(kg.action_log, pre_log);
    assert.deepStrictEqual(kg.find_by_type("Level"), pre_levels);
    // Disk state unchanged (still pre-rollback content)
    const loaded = ProjectKG.load(persist);
    assert.deepStrictEqual(loaded.action_log, pre_log);
    assert.deepStrictEqual(loaded.find_by_type("Level"), pre_levels);
  });
});

test("diff_since returns actions at or after turn", () => {
  const kg = new ProjectKG("p");
  _seed(kg); // turn 1
  kg.advance_turn();
  kg.add_node("Level", { name: "N01", elevation: 3.0 }); // turn 2
  const diff = kg.diff_since(2);
  assert.equal(diff.length, 1);
  assert.equal(diff[0]["turn"], 2);
});

test("set and get revit_id roundtrip", () => {
  const kg = new ProjectKG("p");
  const [level] = _seed(kg);
  kg.set_revit_id(level, 12345);
  assert.equal(kg.get_revit_id(level), 12345);
  // Reserved attr materialised on the node, not validated against schema.
  assert.equal(kg.get_node(level)[REVIT_ID], 12345);
});

test("set_revit_id unknown node raises", () => {
  const kg = new ProjectKG("p");
  raises(KeyError, () => kg.set_revit_id("ghost_001", 1));
});

test("find_by_revit_id returns llm_id or null", () => {
  const kg = new ProjectKG("p");
  const [level, wt] = _seed(kg);
  kg.set_revit_id(level, 100);
  kg.set_revit_id(wt, 200);
  assert.equal(kg.find_by_revit_id(100), level);
  assert.equal(kg.find_by_revit_id(200), wt);
  assert.equal(kg.find_by_revit_id(999), null);
});

test("revit_id survives persistence roundtrip", () => {
  withTmp((dir) => {
    const persist = join(dir, "kg.json");
    const kg = new ProjectKG("p", persist);
    const [level] = _seed(kg);
    kg.set_revit_id(level, 42);
    kg.persist();

    const loaded = ProjectKG.load(persist);
    assert.equal(loaded.get_revit_id(level), 42);
    assert.equal(loaded.find_by_revit_id(42), level);
  });
});

test("Column and ColumnType node types accepted", () => {
  // Phase 14: columns added to the KG (architectural + structural).
  const kg = new ProjectKG("p");
  kg.advance_turn();
  const level = kg.add_node("Level", { name: "N00", elevation: 0.0 });
  const ct = kg.add_node("ColumnType", {
    family_name: "Generic Column",
    type_name: "200x200",
    kind: "structural",
  });
  const col = kg.add_node("Column", {
    level_ref: level,
    type_ref: ct,
    position: [1.0, 2.0],
    height: 3.0,
    kind: "structural",
  });
  assert.equal(kg.get_node(ct)["kind"], "structural");
  assert.deepStrictEqual(kg.get_node(col)["position"], [1.0, 2.0]);
  assert.equal(kg.get_node(col)["height"], 3.0);
});

test("ModelLine and DetailLine node types accepted", () => {
  // Phase 13: lines added to the KG so the agent can address them.
  const kg = new ProjectKG("p");
  kg.advance_turn();
  const ml = kg.add_node("ModelLine", {
    p1: [0.0, 0.0, 0.0],
    p2: [3.0, 0.0, 0.0],
    length: 3.0,
  });
  const dl = kg.add_node("DetailLine", {
    p1: [1.0, 1.0, 0.0],
    p2: [2.0, 1.0, 0.0],
    length: 1.0,
  });
  assert.equal(kg.get_node(ml)["_type"], "ModelLine");
  assert.equal(kg.get_node(dl)["_type"], "DetailLine");
  assert.deepStrictEqual(kg.find_by_type("ModelLine"), [ml]);
  assert.deepStrictEqual(kg.find_by_type("DetailLine"), [dl]);
});

test("_clear_topology resets graph but preserves turn and history", () => {
  const kg = new ProjectKG("p");
  _seed(kg); // turn 1, 2 nodes + 2 create entries (advance does not log)
  kg.advance_turn(); // turn 2
  const pre_turn = kg.turn;
  const pre_log = [...kg.action_log];

  kg._clear_topology(); // exercising the internal API

  // Topology gone.
  assert.deepStrictEqual(kg.find_by_type("Level"), []);
  assert.deepStrictEqual(kg.find_by_type("WallType"), []);
  // Counters reset → first new node of a type starts back at _001.
  const new_level = kg.add_node("Level", { name: "fresh", elevation: 0.0 });
  assert.equal(new_level, "level_001");
  // Timeline preserved.
  assert.equal(kg.turn, pre_turn);
  // Pre-existing log entries are still there (the new add_node appended one).
  assert.deepStrictEqual(kg.action_log.slice(0, pre_log.length), pre_log);
});

test("_clear_topology preserve_counters keeps them", () => {
  const kg = new ProjectKG("p");
  // Allocate 3 walls so counters['Wall'] = 3.
  kg.add_node("Level", { name: "L1", elevation: 0.0 });
  kg.add_node("WallType", { name: "T1", total_thickness: 0.2 });
  for (let i = 0; i < 3; i++) {
    kg.add_node("Wall", {
      type_ref: "walltype_001",
      level_ref: "level_001",
      p1: [0, 0],
      p2: [1, 0],
      length: 1.0,
      height: 2.7,
    });
  }
  assert.equal(kg._counters["Wall"], 3);

  kg._clear_topology(true);
  // Counter intact.
  assert.equal(kg._counters["Wall"], 3);
  // Re-add prerequisites then a wall — next id is wall_004, not wall_001.
  kg.add_node("Level", { name: "L1", elevation: 0.0 });
  kg.add_node("WallType", { name: "T1", total_thickness: 0.2 });
  const new_wall = kg.add_node("Wall", {
    type_ref: "walltype_001",
    level_ref: "level_001",
    p1: [0, 0],
    p2: [1, 0],
    length: 1.0,
    height: 2.7,
  });
  assert.equal(new_wall, "wall_004");
});

test("add_node _emit_log=false suppresses create entry", () => {
  const kg = new ProjectKG("p");
  kg.advance_turn();
  const pre_log_len = kg.action_log.length;

  // Silent: node added, but no log entry appended. (_emit_log is the 4th
  // positional arg; llm_id stays null as the Python default.)
  const nid = kg.add_node(
    "Level",
    { name: "Silent", elevation: 0.0 },
    null,
    false
  );
  assert.ok(kg.has_node(nid));
  assert.equal(kg.action_log.length, pre_log_len); // no `create` event

  // Default: log appended.
  kg.add_node("Level", { name: "Loud", elevation: 1.0 });
  assert.equal(kg.action_log.length, pre_log_len + 1);
  assert.equal(kg.action_log[kg.action_log.length - 1]["action"], "create");
});

test("snapshot_revit_id_map returns mapping including deleted", () => {
  const kg = new ProjectKG("p");
  kg.advance_turn();
  const a = kg.add_node("Level", { name: "A", elevation: 0.0 });
  const b = kg.add_node("Level", { name: "B", elevation: 1.0 });
  kg.set_revit_id(a, 100);
  kg.set_revit_id(b, 200);
  // Soft-delete b — still bound, still findable.
  kg.soft_delete(b);

  const mapping = kg.snapshot_revit_id_map();
  assert.deepStrictEqual(mapping, { 100: a, 200: b });
});

test("snapshot skips nodes without revit binding", () => {
  const kg = new ProjectKG("p");
  kg.add_node("Level", { name: "Unbound", elevation: 0.0 });
  const a = kg.add_node("Level", { name: "Bound", elevation: 1.0 });
  kg.set_revit_id(a, 555);

  const mapping = kg.snapshot_revit_id_map();
  assert.deepStrictEqual(mapping, { 555: a });
});

test("FamilyType requires category attr", () => {
  const kg = new ProjectKG("p");
  // Valid : with category.
  const nid = kg.add_node("FamilyType", {
    family_name: "Porte simple",
    type_name: "0915 x 2134 mm",
    category: "Doors",
  });
  assert.equal(kg.get_node(nid)["category"], "Doors");

  // Missing category → ValueError mentions the missing attr.
  raises(
    ValueError,
    () =>
      kg.add_node("FamilyType", {
        family_name: "Bare",
        type_name: "T1",
      }),
    /category/
  );
});

test("remove_edge drops typed edge idempotently", () => {
  const kg = new ProjectKG("p");
  const a = kg.add_node("Level", { name: "A", elevation: 0.0 });
  const b = kg.add_node("WallType", { name: "T", total_thickness: 0.2 });
  const wall = kg.add_node("Wall", {
    type_ref: b,
    level_ref: a,
    p1: [0, 0],
    p2: [1, 0],
    length: 1.0,
    height: 2.7,
  });
  kg.add_edge(wall, b, "is_type");
  assert.ok(kg._g.has_edge(wall, b, "is_type"));

  assert.equal(kg.remove_edge(wall, b, "is_type"), true);
  assert.ok(!kg._g.has_edge(wall, b, "is_type"));
  // Idempotent — second call returns false without raising.
  assert.equal(kg.remove_edge(wall, b, "is_type"), false);
});

test("Door/Window schema accepts required attrs", () => {
  const kg = new ProjectKG("p");
  const door = kg.add_node("Door", {
    type_ref: "family_type_001",
    host_wall_ref: "wall_001",
    position: [1.0, 0.0],
    sill_height: 0.0,
    head_height: 2.1,
  });
  assert.equal(kg.get_node(door)["_type"], "Door");

  const win = kg.add_node("Window", {
    type_ref: "family_type_002",
    host_wall_ref: "wall_001",
    position: [3.0, 0.0],
    sill_height: 0.9,
    head_height: 2.4,
  });
  assert.equal(kg.get_node(win)["_type"], "Window");

  // Door without `position` is refused.
  raises(
    ValueError,
    () =>
      kg.add_node("Door", {
        type_ref: "family_type_001",
        host_wall_ref: "wall_001",
        sill_height: 0.0,
        head_height: 2.1,
      }),
    /position/
  );
});
