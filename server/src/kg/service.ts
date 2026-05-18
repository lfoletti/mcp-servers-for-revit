/**
 * service.ts — KG en-process v1. Remplace le sidecar Python
 * (`kg_bridge/kg_sidecar.py` + `bridge.ts`, supprimés) : porte **1:1** la
 * surface des 13 méthodes du sidecar sur `core/` (ProjectKG, étape 1) +
 * `persist.ts` (contrat blob, étape 2) + un `KgSnapshotStore` réel
 * (transport socket → commandes C# ES, étape 3). DESIGN-internalize-es.md
 * §9, §10.4.
 *
 * Iso-comportement voulu vs `kg_sidecar.py` : mêmes noms de méthode, mêmes
 * params, **mêmes formes de résultat** (y compris les projections compactes
 * et le modèle « 1 op MCP == 1 turn ») — pour que le re-bench étape 6 reste
 * comparable au PoC gelé, et que le diff des `kg_*.ts` soit mécanique.
 *
 * Cache (§5) : un `ProjectKG` par project_id en mémoire (= cache du blob
 * ES), comme le `_INSTANCES` du sidecar (qui persistait sur disque ; ici
 * vers l'ES via le store). Survit au restart serveur par *reload* depuis
 * l'ES, pas par la RAM. Les `call()` sont sérialisés (le snapshot/rollback
 * de `transaction()` n'est pas réentrant ; le sidecar lisait stdin en
 * série).
 *
 * Risque connu, hérité du PoC (parité voulue) : mutation appliquée en
 * mémoire PUIS persistée. Si `saveProjectKG` (socket/Revit) échoue, la
 * mémoire est en avance sur l'ES — résolu au prochain reload (invalidation
 * `DocumentChanged` = étape 5). Même forme de risque que le `persist()`
 * disque du sidecar.
 */
import {
  CREATED_AT,
  DELETED_AT,
  EDGE_TYPES,
  MODIFIED_AT,
  NODE_TYPES,
  ProjectKG,
  SESSION_NODE_TYPES,
} from "./core/index.js";
import {
  KgSnapshotStore,
  loadProjectKG,
  saveProjectKG,
} from "./persist.js";
import { defaultKgStore } from "./transport.js";

type Dict = Record<string, any>;

// ----- wrappers de résultat MCP (déplacés tels quels de bridge.ts) --------

/** Enveloppe d'outil MCP uniforme (forme existante du repo). */
export function kgResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

export function kgError(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

// ----- projections (port 1:1 des helpers du sidecar) ----------------------

const ID_CAP = 10;

function idsCompact(ids: string[]): Dict {
  return {
    count: ids.length,
    sample_ids: ids.slice(0, ID_CAP),
    truncated: ids.length > ID_CAP,
  };
}

/**
 * Projection node pour les résultats de `query`. Port **fidèle** du
 * `_node_view` du sidecar — y compris le fait que la clé `id` reste DANS
 * `attrs` (le sidecar ne pop que `_type` + les 3 attrs de cycle de vie).
 * Ne pas « corriger » : iso-comportement = re-bench comparable.
 */
function nodeView(n: Dict): Dict {
  const a: Dict = { ...n };
  const type = a["_type"] ?? null;
  delete a["_type"];
  const created = a[CREATED_AT] ?? null;
  delete a[CREATED_AT];
  const modified = a[MODIFIED_AT] ?? [];
  delete a[MODIFIED_AT];
  const deleted = a[DELETED_AT] ?? null;
  delete a[DELETED_AT];
  return {
    llm_id: n["id"],
    type,
    created_at_turn: created,
    modified_at_turn: modified,
    deleted_at_turn: deleted,
    attrs: a,
  };
}

function stats(kg: ProjectKG): Dict {
  const d = kg.to_dict();
  const byType: Record<string, { live: number; deleted: number }> = {};
  for (const n of d.nodes) {
    const t = (n as Dict)["_type"] ?? "?";
    const slot = (byType[t] ??= { live: 0, deleted: 0 });
    if ((n as Dict)[DELETED_AT] != null) slot.deleted += 1;
    else slot.live += 1;
  }
  return {
    project_id: kg.project_id,
    turn: kg.turn,
    nodes_total: d.nodes.length,
    edges_total: d.edges.length,
    by_type: byType,
    action_log_len: d.action_log.length,
  };
}

function cmp(a: any, op: string, b: any): boolean {
  if (op === "eq" || op === "==") return a === b;
  if (op === "ne" || op === "!=") return a !== b;
  if (op === "in") {
    if (Array.isArray(b)) return b.includes(a);
    if (typeof b === "string") return b.includes(String(a));
    return false;
  }
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  switch (op) {
    case "lt":
    case "<":
      return x < y;
    case "le":
    case "<=":
      return x <= y;
    case "gt":
    case ">":
      return x > y;
    case "ge":
    case ">=":
      return x >= y;
    default:
      return false;
  }
}

function matches(node: Dict, where: Dict[]): boolean {
  for (const pred of where) {
    if (!cmp(node[pred["attr"]], pred["op"] ?? "eq", pred["value"])) {
      return false;
    }
  }
  return true;
}

/** Ajout d'un item (node + edges typées optionnelles), SANS transaction —
 *  l'appelant possède la Tx (unit et bulk partagent ce chemin, comme le
 *  `_add_one` du sidecar / la bulk-variant policy upstream). */
function addOne(kg: ProjectKG, spec: Dict): string {
  const newId = kg.add_node(
    spec["node_type"],
    spec["attrs"] ?? {},
    spec["llm_id"] ?? null
  );
  for (const e of spec["edges"] ?? []) {
    const etype = e["type"];
    if (e["to"] !== undefined) kg.add_edge(newId, e["to"], etype);
    else if (e["from"] !== undefined) kg.add_edge(e["from"], newId, etype);
    else throw new Error(`edge needs 'to' or 'from': ${JSON.stringify(e)}`);
  }
  return newId;
}

// ----- le service ---------------------------------------------------------

export class KgService {
  private store: KgSnapshotStore | null;
  private instances = new Map<string, ProjectKG>();
  /** Sérialise tous les `call()` (parité stdin-série du sidecar + le
   *  snapshot/rollback de `transaction()` n'est pas réentrant). */
  private queue: Promise<unknown> = Promise.resolve();

  /** `store` injectable pour les tests (InMemoryBlobTransport) ; en prod,
   *  résolu **lazy** sur le store socket (aucun socket à l'import). */
  constructor(store?: KgSnapshotStore) {
    this.store = store ?? null;
  }

  private getStore(): KgSnapshotStore {
    return (this.store ??= defaultKgStore());
  }

  /** Cache → reload depuis l'ES → neuf. `persist_path=null` : le
   *  `persist()` interne de `transaction()` est un no-op (on persiste via
   *  le store, pas un fichier). Pendant du `_kg()` du sidecar. */
  private async getKg(projectId?: string): Promise<ProjectKG> {
    const pid = projectId || "default";
    const cached = this.instances.get(pid);
    if (cached) return cached;
    const loaded = await loadProjectKG(this.getStore(), pid, null);
    const kg = loaded ?? new ProjectKG(pid);
    this.instances.set(pid, kg);
    return kg;
  }

  /** Dispatch sérialisé, signature identique à l'ancien `kgBridge.call`. */
  call(method: string, params: Dict = {}): Promise<any> {
    const run = this.queue.then(() => this.dispatch(method, params ?? {}));
    // La file ne doit jamais se bloquer sur une erreur d'appel précédent.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private dispatch(method: string, p: Dict): Promise<any> {
    switch (method) {
      case "health":
        return this.mHealth();
      case "schema":
        return this.mSchema();
      case "add_element":
        return this.mAddElement(p);
      case "add_many":
        return this.mAddMany(p);
      case "modify_element":
        return this.mModifyElement(p);
      case "modify_many":
        return this.mModifyMany(p);
      case "modify_where":
        return this.mModifyWhere(p);
      case "soft_delete":
        return this.mSoftDelete(p);
      case "query":
        return this.mQuery(p);
      case "diff_since":
        return this.mDiffSince(p);
      case "stats":
        return this.mStats(p);
      case "transaction_demo":
        return this.mTransactionDemo(p);
      case "reset":
        return this.mReset(p);
      default:
        return Promise.reject(new Error(`unknown method: ${method}`));
    }
  }

  // -- méthodes (port 1:1 des `m_*` du sidecar) ----------------------------

  private async mHealth(): Promise<Dict> {
    return {
      ok: true,
      kg: "claude-in-revit ProjectKG (TS port, internalized in .rvt ExtensibleStorage)",
      storage: "revit-extensible-storage",
      node_types: Object.keys(NODE_TYPES).sort(),
      edge_types: [...EDGE_TYPES].sort(),
    };
  }

  private async mSchema(): Promise<Dict> {
    const node_types: Dict = {};
    for (const [t, spec] of Object.entries(NODE_TYPES)) {
      node_types[t] = {
        required: [...spec.required].sort(),
        optional: [...spec.optional].sort(),
        session_only: SESSION_NODE_TYPES.has(t),
      };
    }
    return { node_types, edge_types: [...EDGE_TYPES].sort() };
  }

  private async mAddElement(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const nodeType = p["node_type"];
    const attrs = p["attrs"] ?? {};
    const llmId = p["llm_id"] ?? null;
    const edges = p["edges"] ?? [];
    let newId = "";
    kg.transaction(() => {
      kg.advance_turn();
      newId = kg.add_node(nodeType, attrs, llmId);
      for (const e of edges) {
        const etype = e["type"];
        if (e["to"] !== undefined) kg.add_edge(newId, e["to"], etype);
        else if (e["from"] !== undefined)
          kg.add_edge(e["from"], newId, etype);
        else
          throw new Error(`edge needs 'to' or 'from': ${JSON.stringify(e)}`);
      }
    });
    await saveProjectKG(this.getStore(), kg);
    return { llm_id: newId, turn: kg.turn, edges_added: edges.length };
  }

  private async mModifyElement(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const llmId = p["llm_id"];
    kg.transaction(() => {
      kg.advance_turn();
      kg.modify_node(llmId, p["updates"]);
    });
    await saveProjectKG(this.getStore(), kg);
    const node = kg.get_node(llmId);
    return {
      llm_id: llmId,
      turn: kg.turn,
      modified_at_turn: node[MODIFIED_AT] ?? [],
    };
  }

  private async mAddMany(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const items: Dict[] = p["items"];
    const newIds: string[] = [];
    kg.transaction(() => {
      kg.advance_turn();
      for (const spec of items) newIds.push(addOne(kg, spec));
    });
    await saveProjectKG(this.getStore(), kg);
    return { ...idsCompact(newIds), turn: kg.turn };
  }

  private async mModifyMany(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const items: Dict[] = p["items"];
    const ids: string[] = [];
    kg.transaction(() => {
      kg.advance_turn();
      for (const it of items) {
        kg.modify_node(it["llm_id"], it["updates"]);
        ids.push(it["llm_id"]);
      }
    });
    await saveProjectKG(this.getStore(), kg);
    return { ...idsCompact(ids), turn: kg.turn };
  }

  private async mModifyWhere(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const nodeType = p["node_type"];
    const where: Dict[] = p["where"] ?? [];
    const matched = kg
      .find_by_type(nodeType)
      .filter((nid) => matches(kg.get_node(nid), where));
    kg.transaction(() => {
      kg.advance_turn();
      for (const nid of matched) kg.modify_node(nid, p["updates"]);
    });
    await saveProjectKG(this.getStore(), kg);
    return {
      node_type: nodeType,
      matched: matched.length,
      modified: matched.length,
      turn: kg.turn,
      sample_ids: matched.slice(0, ID_CAP),
      truncated: matched.length > ID_CAP,
    };
  }

  private async mSoftDelete(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const llmId = p["llm_id"];
    kg.transaction(() => {
      kg.advance_turn();
      kg.soft_delete(llmId);
    });
    await saveProjectKG(this.getStore(), kg);
    const node = kg.get_node(llmId);
    return {
      llm_id: llmId,
      turn: kg.turn,
      deleted_at_turn: node[DELETED_AT] ?? null,
      note: "soft delete: node retained, queryable with include_deleted=true",
    };
  }

  private async mQuery(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const nodeType = p["node_type"] ?? null;
    const llmId = p["llm_id"] ?? null;
    const includeDeleted = Boolean(p["include_deleted"] ?? false);
    const includeEdges = Boolean(p["include_edges"] ?? true);
    const compact = Boolean(p["compact"] ?? false);

    const d = kg.to_dict();
    const nodes: Dict[] = [];
    for (const n of d.nodes as Dict[]) {
      if (llmId !== null && n["id"] !== llmId) continue;
      if (nodeType !== null && n["_type"] !== nodeType) continue;
      if (!includeDeleted && n[DELETED_AT] != null) continue;
      nodes.push(nodeView(n));
    }

    if (compact) {
      const byType: Record<string, number> = {};
      for (const nv of nodes)
        byType[nv["type"]] = (byType[nv["type"]] ?? 0) + 1;
      const idSet = new Set(nodes.map((nv) => nv["llm_id"]));
      return {
        count: nodes.length,
        by_type: byType,
        ids: nodes.map((nv) => nv["llm_id"]),
        edges_count: (d.edges as Dict[]).filter(
          (e) => idSet.has(e["src"]) || idSet.has(e["dst"])
        ).length,
      };
    }

    const result: Dict = { count: nodes.length, nodes };
    if (includeEdges) {
      const idSet = new Set(nodes.map((nv) => nv["llm_id"]));
      result["edges"] = (d.edges as Dict[])
        .filter((e) => idSet.has(e["src"]) || idSet.has(e["dst"]))
        .map((e) => ({
          src: e["src"],
          dst: e["dst"],
          type: e["_type"] ?? e["key"],
        }));
    }
    return result;
  }

  private async mDiffSince(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const since = Number(p["since_turn"]);
    const diff = kg.diff_since(since);
    return {
      since_turn: since,
      current_turn: kg.turn,
      action_count: diff.length,
      actions: diff,
      note:
        "action-grained history -- a flat key/value store cannot answer " +
        "'what changed since turn N'",
    };
  }

  private async mStats(p: Dict): Promise<Dict> {
    return stats(await this.getKg(p["project_id"]));
  }

  private async mTransactionDemo(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const before = stats(kg);
    const ops: Dict[] = p["ops"] ?? [
      { node_type: "Level", attrs: { name: "Demo N0", elevation: 0.0 } },
      { node_type: "Level", attrs: { name: "Demo N1", elevation: 3.0 } },
      // Volontairement invalide : type inconnu → ValueError en milieu de lot.
      { node_type: "Frobnicator", attrs: { name: "boom" } },
    ];
    let error: string | null = null;
    try {
      kg.transaction(() => {
        kg.advance_turn();
        for (const op of ops)
          kg.add_node(op["node_type"], op["attrs"] ?? {});
      });
    } catch (exc: any) {
      error = `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`;
    }
    // Rollback interne ⇒ état inchangé ⇒ rien à persister (le sidecar ne
    // persistait pas non plus la démo échouée).
    const after = stats(kg);
    const rolledBack =
      before["nodes_total"] === after["nodes_total"] &&
      before["turn"] === after["turn"] &&
      before["action_log_len"] === after["action_log_len"];
    return {
      attempted_ops: ops,
      error,
      before,
      after,
      rolled_back_cleanly: rolledBack,
      note:
        "all-or-nothing: no node, no turn bump, no log entry survived " +
        "the failed batch",
    };
  }

  private async mReset(p: Dict): Promise<Dict> {
    const pid = (p["project_id"] || "default") as string;
    const existedInCache = this.instances.has(pid);
    this.instances.delete(pid);
    // L'ES n'a pas de « delete DataStorage » dans le contrat ; on écrase
    // par un graphe vide (recreate-if-missing ⇒ vide == reset). Démo only.
    const before = await loadProjectKG(this.getStore(), pid, null);
    const fresh = new ProjectKG(pid);
    await saveProjectKG(this.getStore(), fresh);
    this.instances.set(pid, fresh);
    return { project_id: pid, removed: before !== null || existedInCache };
  }
}

/** Singleton partagé par tous les outils `kg_*` (comme l'ex-`kgBridge`).
 *  Store résolu lazy ⇒ import sans effet de bord (pas de socket au boot). */
export const kgService = new KgService();
