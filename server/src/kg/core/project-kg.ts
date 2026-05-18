/**
 * project-kg.ts — port TypeScript de `kg_bridge/vendor/project_kg.py`.
 *
 * Graphe typé des éléments Revit avec historique action-grained. Un seul
 * `MultiDiGraph` porte tous les éléments du projet. Les nœuds ont un attr
 * `_type` (∈ `NODE_TYPES`) + les attrs de cycle de vie. Les mutations
 * devraient passer par `transaction()`, qui snapshot l'état à l'entrée et le
 * restaure en cas d'exception.
 *
 * Port v1 (DESIGN-internalize-es.md §0/§7) : le sidecar Python est supprimé,
 * ce module devient le cœur. **Critère** : iso-comportement vs le fichier
 * Python de référence (figé, byte-for-byte vs upstream). La surface publique
 * conserve volontairement les **noms Python** (snake_case, `to_dict`,
 * `from_dict`, `transaction`, props `turn`/`action_log`) pour que le portage
 * 1:1 des 31 tests upstream (`test_project_kg.py`) reste mécanique et que la
 * dérive silencieuse soit minimisée.
 *
 * Pièges traités (spec §7) :
 *  - ordre d'itération `find_by_type` = ordre d'insertion → cf. `graph.ts`.
 *  - rollback `transaction()` : `structuredClone(to_dict())` (≡
 *    `copy.deepcopy`) + `from_dict` (sémantique de restauration exacte).
 *  - sérialisation : `pyJsonDump` ≡ `json.dump(sort_keys=True, indent=2)`
 *    (cf. `pyjson.ts`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { KeyError, ValueError } from "./errors.js";
import { Attrs, MultiDiGraph } from "./graph.js";
import { pyInt, pyJsonDump, pyReprList, pyStr } from "./pyjson.js";
import {
  CREATED_AT,
  DELETED_AT,
  EDGE_TYPES,
  MODIFIED_AT,
  NODE_TYPES,
  ORIGIN,
  REVIT_ID,
} from "./schema.js";

/** `x is not None` Python : seuls `null`/`undefined` comptent comme "None"
 * (0 et "" restent des valeurs — un `deleted_at_turn == 0` = supprimé). */
function isNotNone(x: unknown): boolean {
  return x !== null && x !== undefined;
}

interface ActionLogEntry {
  turn: number;
  action: string;
  target: string;
  details: Record<string, any>;
}

export interface ProjectKGDict {
  project_id: string;
  turn: number;
  counters: Record<string, number>;
  nodes: Array<Record<string, any>>;
  edges: Array<Record<string, any>>;
  action_log: ActionLogEntry[];
}

export class ProjectKG {
  project_id: string;
  persist_path: string | null;
  /** Public comme l'attribut Python `kg._g` (les tests upstream y accèdent). */
  _g: MultiDiGraph;
  /** Public comme `kg._counters` (testé directement upstream). */
  _counters: Record<string, number>;
  private _turn: number;
  private _action_log: ActionLogEntry[];

  constructor(project_id: string, persist_path: string | null = null) {
    this.project_id = project_id;
    this.persist_path = persist_path;
    this._g = new MultiDiGraph();
    this._turn = 0;
    this._action_log = [];
    this._counters = {};
  }

  // ----- Turn counter -------------------------------------------------

  get turn(): number {
    return this._turn;
  }

  advance_turn(): number {
    this._turn += 1;
    return this._turn;
  }

  // ----- llm_id allocation -------------------------------------------

  _next_llm_id(node_type: string): string {
    this._counters[node_type] = (this._counters[node_type] ?? 0) + 1;
    return `${node_type.toLowerCase()}_${String(
      this._counters[node_type]
    ).padStart(3, "0")}`;
  }

  // ----- Node operations ---------------------------------------------

  /**
   * Ajoute un nœud typé au graphe.
   *
   * @param llm_id  Id explicite. Si `null`, alloué via le compteur typé.
   *   Utilisé par `kg_sync.full_rescan` pour *réutiliser* un id existant
   *   (stabilité UX des ids à travers les rescans).
   * @param _emit_log  `false` ⇒ pas d'entrée `create` dans l'action log
   *   (full_rescan loggue un seul `rescan` au lieu de N `create`). Flag
   *   interne, laisser au défaut pour le code outil.
   */
  add_node(
    node_type: string,
    attrs: Attrs,
    llm_id: string | null = null,
    _emit_log: boolean = true
  ): string {
    if (!(node_type in NODE_TYPES)) {
      throw new ValueError(`Unknown node type: ${node_type}`);
    }
    const spec = NODE_TYPES[node_type];
    const keys = new Set(Object.keys(attrs));
    const missing = [...spec.required].filter((k) => !keys.has(k));
    if (missing.length > 0) {
      throw new ValueError(
        `Missing required attrs for ${node_type}: ${pyReprList(
          missing.sort()
        )}`
      );
    }
    const unknown = [...keys].filter(
      (k) => !spec.required.has(k) && !spec.optional.has(k)
    );
    if (unknown.length > 0) {
      throw new ValueError(
        `Unknown attrs for ${node_type}: ${pyReprList(unknown.sort())}`
      );
    }

    if (llm_id === null) {
      llm_id = this._next_llm_id(node_type);
    }
    if (this._g.has_node(llm_id)) {
      throw new ValueError(`llm_id already in graph: ${llm_id}`);
    }

    const full_attrs: Attrs = { ...attrs };
    full_attrs["_type"] = node_type;
    full_attrs[CREATED_AT] = this._turn;
    full_attrs[MODIFIED_AT] = [];
    full_attrs[DELETED_AT] = null;

    this._g.add_node(llm_id, full_attrs);
    if (_emit_log) {
      this._log("create", llm_id, { node_type, attrs: { ...attrs } });
    }
    return llm_id;
  }

  modify_node(llm_id: string, updates: Attrs): void {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    const node = this._g.node(llm_id);
    if (isNotNone(node[DELETED_AT])) {
      throw new ValueError(`Node ${llm_id} is soft-deleted`);
    }

    const node_type = node["_type"];
    const spec = NODE_TYPES[node_type];
    const update_keys = Object.keys(updates);
    const unknown = update_keys.filter(
      (k) => !spec.required.has(k) && !spec.optional.has(k)
    );
    if (unknown.length > 0) {
      throw new ValueError(
        `Unknown attrs for ${node_type}: ${pyReprList(unknown.sort())}`
      );
    }

    const before: Attrs = {};
    for (const k of update_keys) before[k] = k in node ? node[k] : null;
    Object.assign(node, updates);
    const prev = Array.isArray(node[MODIFIED_AT]) ? node[MODIFIED_AT] : [];
    node[MODIFIED_AT] = [...prev, this._turn];
    this._log("modify", llm_id, { before, after: { ...updates } });
  }

  soft_delete(llm_id: string): void {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    const node = this._g.node(llm_id);
    if (isNotNone(node[DELETED_AT])) return;
    node[DELETED_AT] = this._turn;
    this._log("delete", llm_id, {});
  }

  // ----- Edge operations ---------------------------------------------

  add_edge(
    src: string,
    dst: string,
    edge_type: string,
    attrs: Attrs = {}
  ): void {
    if (!EDGE_TYPES.has(edge_type)) {
      throw new ValueError(`Unknown edge type: ${edge_type}`);
    }
    if (!this._g.has_node(src) || !this._g.has_node(dst)) {
      throw new KeyError(`Edge endpoints must exist: ${src} -> ${dst}`);
    }
    this._g.add_edge(src, dst, edge_type, { _type: edge_type, ...attrs });
  }

  /**
   * Retire l'arête typée `src --(edge_type)-> dst`, renvoie si elle
   * existait. Idempotent — pas d'erreur si l'arête est déjà absente.
   */
  remove_edge(src: string, dst: string, edge_type: string): boolean {
    if (!this._g.has_edge(src, dst, edge_type)) return false;
    this._g.remove_edge(src, dst, edge_type);
    return true;
  }

  // ----- Revit binding -----------------------------------------------

  /**
   * Pose un `ElementId.Value` Revit sur un nœud KG. Contourne la validation
   * de schéma : `_revit_id` est framework-managed. Persisté dans le
   * round-trip `to_dict()`/`from_dict()`.
   */
  set_revit_id(llm_id: string, revit_id: number): void {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    this._g.node(llm_id)[REVIT_ID] = pyInt(revit_id);
  }

  /** `ElementId.Value` lié, ou `null` si non lié. */
  get_revit_id(llm_id: string): number | null {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    const v = this._g.node(llm_id)[REVIT_ID];
    return v ?? null;
  }

  // ----- Origin tagging (provenance) ----------------------------------

  set_origin(llm_id: string, origin: string): void {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    this._g.node(llm_id)[ORIGIN] = pyStr(origin);
  }

  get_origin(llm_id: string): string | null {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    const v = this._g.node(llm_id)[ORIGIN];
    return v ?? null;
  }

  /** Reverse lookup : llm_id lié à un `ElementId.Value`, ou `null`. */
  find_by_revit_id(revit_id: number): string | null {
    const target = pyInt(revit_id);
    for (const [nid, attrs] of this._g.nodes_data()) {
      if (attrs[REVIT_ID] === target) return nid;
    }
    return null;
  }

  /**
   * `{revit_id: llm_id}` pour chaque nœud lié. Inclut les soft-deleted
   * (un undo→rescan récupère l'id d'origine).
   */
  snapshot_revit_id_map(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const [nid, attrs] of this._g.nodes_data()) {
      const rid = attrs[REVIT_ID];
      if (isNotNone(rid)) out[pyInt(rid)] = nid;
    }
    return out;
  }

  /**
   * `{revit_id: [llm_id, _type]}` — variante type-aware. Requise par
   * `full_rescan` pour ne réutiliser un llm_id que si le type d'origine
   * == type rebuildé (un `ElementId` recyclé par Revit ferait sinon hériter
   * le mauvais id → crash documenté upstream).
   */
  snapshot_revit_id_map_typed(): Record<number, [string, string | undefined]> {
    const out: Record<number, [string, string | undefined]> = {};
    for (const [nid, attrs] of this._g.nodes_data()) {
      const rid = attrs[REVIT_ID];
      if (isNotNone(rid)) out[pyInt(rid)] = [nid, attrs["_type"]];
    }
    return out;
  }

  // ----- Topology reset (used by kg_sync.full_rescan) -----------------

  /**
   * Drop nodes/edges (+ optionnellement les compteurs llm_id). Garde
   * `turn`, `action_log`, `project_id`, `persist_path` (sémantique hybride
   * full_rescan : graphe rebuildé, timeline conversationnelle continue).
   *
   * @param preserve_counters `true` ⇒ `_counters` intact (les nouveaux ids
   *   continuent au-delà du plus haut id pré-rescan, pas de renumérotation).
   */
  _clear_topology(preserve_counters: boolean = false): void {
    this._g = new MultiDiGraph();
    if (!preserve_counters) this._counters = {};
  }

  // ----- Queries ------------------------------------------------------

  has_node(llm_id: string): boolean {
    return this._g.has_node(llm_id);
  }

  get_node(llm_id: string): Attrs {
    if (!this._g.has_node(llm_id)) throw new KeyError(llm_id);
    return { ...this._g.node(llm_id) };
  }

  find_by_type(
    node_type: string,
    include_deleted: boolean = false
  ): string[] {
    const out: string[] = [];
    for (const [nid, attrs] of this._g.nodes_data()) {
      if (attrs["_type"] !== node_type) continue;
      if (!include_deleted && isNotNone(attrs[DELETED_AT])) continue;
      out.push(nid);
    }
    return out;
  }

  /** Nœuds dont l'attr `name` == `name` (sensible à la casse). */
  find_by_name(
    name: string,
    node_type: string | null = null,
    include_deleted: boolean = false
  ): string[] {
    const out: string[] = [];
    for (const [nid, attrs] of this._g.nodes_data()) {
      if (node_type !== null && attrs["_type"] !== node_type) continue;
      if (!include_deleted && isNotNone(attrs[DELETED_AT])) continue;
      if (attrs["name"] === name) out.push(nid);
    }
    return out;
  }

  count_by_type(
    node_type: string,
    include_deleted: boolean = false
  ): number {
    return this.find_by_type(node_type, include_deleted).length;
  }

  // ----- Action log ---------------------------------------------------

  private _log(
    action: string,
    target: string,
    details: Record<string, any> = {}
  ): void {
    this._action_log.push({
      turn: this._turn,
      action,
      target,
      details,
    });
  }

  get action_log(): ActionLogEntry[] {
    return [...this._action_log];
  }

  diff_since(since_turn: number): ActionLogEntry[] {
    return this._action_log.filter((a) => a.turn >= since_turn);
  }

  // ----- Serialization -----------------------------------------------

  to_dict(): ProjectKGDict {
    return {
      project_id: this.project_id,
      turn: this._turn,
      counters: { ...this._counters },
      nodes: [...this._g.nodes_data()].map(([nid, attrs]) => ({
        id: nid,
        ...attrs,
      })),
      edges: [...this._g.edges_data()].map(([u, v, k, attrs]) => ({
        src: u,
        dst: v,
        key: k,
        ...attrs,
      })),
      action_log: [...this._action_log],
    };
  }

  static from_dict(
    data: Partial<ProjectKGDict> & { project_id: string },
    persist_path: string | null = null
  ): ProjectKG {
    const kg = new ProjectKG(data.project_id, persist_path);
    kg._turn = pyInt(data.turn ?? 0);
    kg._counters = { ...(data.counters ?? {}) };
    for (const n of data.nodes ?? []) {
      const attrs = { ...n };
      const nid = attrs["id"];
      delete attrs["id"];
      kg._g.add_node(nid, attrs);
    }
    for (const e of data.edges ?? []) {
      const attrs = { ...e };
      const u = attrs["src"];
      const v = attrs["dst"];
      const k = attrs["key"];
      delete attrs["src"];
      delete attrs["dst"];
      delete attrs["key"];
      kg._g.add_edge(u, v, k, attrs);
    }
    kg._action_log = [...(data.action_log ?? [])];
    return kg;
  }

  persist(): void {
    if (this.persist_path === null) return;
    mkdirSync(dirname(this.persist_path), { recursive: true });
    writeFileSync(this.persist_path, pyJsonDump(this.to_dict()), {
      encoding: "utf-8",
    });
  }

  static load(persist_path: string): ProjectKG {
    const data = JSON.parse(readFileSync(persist_path, { encoding: "utf-8" }));
    return ProjectKG.from_dict(data, persist_path);
  }

  // ----- Transactions -------------------------------------------------

  /**
   * Bloc de mutation atomique. Restaure l'état antérieur sur toute
   * exception, persiste sur succès.
   *
   * Port du contextmanager Python : `with kg.transaction() as t:` ⇒
   * `kg.transaction((t) => { ... })`. `structuredClone(to_dict())` ≡
   * `copy.deepcopy(to_dict())` ; restauration via `from_dict` (réassigne
   * `_g/_turn/_counters/_action_log` comme le `except` Python). `persist()`
   * seulement après succès (≡ branche `else`).
   */
  transaction<T>(fn: (kg: ProjectKG) => T): T {
    const snapshot = structuredClone(this.to_dict());
    try {
      const result = fn(this);
      this.persist();
      return result;
    } catch (e) {
      const restored = ProjectKG.from_dict(snapshot, this.persist_path);
      this._g = restored._g;
      this._turn = restored._turn;
      this._counters = restored._counters;
      this._action_log = restored._action_log;
      throw e;
    }
  }
}
