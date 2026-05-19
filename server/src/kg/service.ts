/**
 * service.ts — KG en-process v1. Remplace le sidecar Python
 * (`kg_bridge/kg_sidecar.py` + `bridge.ts`, supprimés) : porte **1:1** la
 * surface des 13 méthodes du sidecar sur `core/` (ProjectKG, étape 1) +
 * `persist.ts` (contrat blob, étape 2) + un `KgSnapshotStore` réel
 * (transport socket → commandes C# ES, étape 3). DESIGN-internalize-es.md
 * §9, §10.4.
 *
 * Iso-comportement vs `kg_sidecar.py` pour les lecteurs et la sémantique
 * (projections compactes, « 1 op MCP == 1 turn », snapshot/rollback).
 *
 * **Fusion single/`_many` (décision design, post run-1 étape 6).** Les
 * mutateurs sont **list-native 1..N** (`add_element`/`modify_element`/
 * `soft_delete` prennent une liste ; un lot de 1 = l'ancien « single »),
 * atomiques sur le lot. `add_many`/`modify_many` SUPPRIMÉS (quasi-
 * redondance) ; `modify_where` conservé (sélection par prédicat, besoin
 * distinct). Calque l'API list-native des commandes C# upstream
 * (`create_level(List<…>)`, `delete_element(string[])`). `core/`
 * (25 tests) et `persist.ts` (19) **non touchés** ; le re-bench étape 6
 * compare donc la **surface réellement livrée** vs le PoC gelé (le run 1
 * a déjà isolé le coût substrat). Noms d'outils inchangés.
 *
 * Cache (§5) : un `ProjectKG` par project_id en mémoire (= cache du blob
 * ES), comme le `_INSTANCES` du sidecar (qui persistait sur disque ; ici
 * vers l'ES via le store). Survit au restart serveur par *reload* depuis
 * l'ES, pas par la RAM. Les `call()` sont sérialisés (le snapshot/rollback
 * de `transaction()` n'est pas réentrant ; le sidecar lisait stdin en
 * série).
 *
 * Mutation appliquée en mémoire PUIS persistée (parité PoC voulue). Si
 * `saveProjectKG` (socket/Revit) échoue, le cache RAM serait EN AVANCE
 * sur l'ES. L'invalidation §5 (`DocumentChanged`) ne couvre PAS ce cas
 * (nos propres writes ne bumpent pas l'epoch) : reproduit à froid le
 * 2026-05-19 (JOURNAL) — `kg_query` mentait avec une mutation jamais
 * persistée. **Fix A** : `persistOrEvict()` évince l'entrée de cache du
 * project_id sur échec persist ⇒ le prochain `getKg()` recharge l'ES
 * (= la vérité durable), jamais un cache menteur. (Cause racine du
 * timeout = transport C# entrant, Fix B, hors de ce fichier.)
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
import {
  KgDocStateProvider,
  NoopKgDocStateProvider,
  defaultKgDocStateProvider,
  defaultKgStore,
} from "./transport.js";

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

/**
 * Exécute l'op d'UN élément d'un lot ; en cas d'échec, **enrichit le
 * message** avec l'index et l'identité de l'élément fautif, puis
 * **re-lève le même objet erreur** (type ValueError/KeyError préservé →
 * `transaction()` rollback **total** : l'atomicité du lot est intacte).
 * Sans ça, sur un lot de N un échec remonte un message sans index et
 * l'agent tâtonne en aveugle (défaut relevé au run 2 étape 6). Avec ça :
 * « add_element element[7] (node_type=Wall) failed: Missing required
 * attrs for Wall: ['height'] » → l'agent corrige ciblé.
 */
function atItem<T>(
  opLabel: string,
  i: number,
  ident: string,
  fn: () => T
): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error) {
      e.message =
        `${opLabel} element[${i}]` +
        (ident ? ` (${ident})` : "") +
        ` failed: ${e.message}`;
    }
    throw e;
  }
}

// ----- le service ---------------------------------------------------------

/** Entrée de cache : le `ProjectKG` + l'état document (§5) observé au
 *  moment du (re)chargement. Reload si `docKey`/`epoch` ont bougé. */
interface CacheEntry {
  kg: ProjectKG;
  docKey: string;
  epoch: number;
}

export class KgService {
  private store: KgSnapshotStore | null;
  private docState: KgDocStateProvider | null;
  private readonly storeInjected: boolean;
  private instances = new Map<string, CacheEntry>();
  /** Sérialise tous les `call()` (parité stdin-série du sidecar + le
   *  snapshot/rollback de `transaction()` n'est pas réentrant). */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `store` / `docState` injectables pour les tests (InMemoryBlobTransport,
   * provider factice). En prod (aucun arg) : store + provider socket
   * **lazy** (aucun socket à l'import). Si un store est injecté SANS
   * provider (tests/dev hors Revit), le provider par défaut est `Noop`
   * (epoch/doc constants ⇒ pas d'invalidation : comportement d'avant §5).
   */
  constructor(store?: KgSnapshotStore, docState?: KgDocStateProvider) {
    this.store = store ?? null;
    this.storeInjected = store !== undefined;
    this.docState = docState ?? null;
  }

  private getStore(): KgSnapshotStore {
    return (this.store ??= defaultKgStore());
  }

  private getDocState(): KgDocStateProvider {
    if (this.docState !== null) return this.docState;
    this.docState = this.storeInjected
      ? new NoopKgDocStateProvider()
      : defaultKgDocStateProvider();
    return this.docState;
  }

  /**
   * Cache (= cache du blob ES, §5) → invalidation sur signal → reload.
   * Sonde `kg_doc_state` (coût quasi nul, sans Tx) : `docKey`/`epoch`
   * inchangés ⇒ on garde le cache (« cache longue durée pour les
   * écritures-outils ») ; document ouvert/basculé ou changement hors-bande
   * (humain, Sync) ⇒ on recharge depuis l'ES. Nos propres écritures ES ne
   * bumpent PAS l'epoch (filtre par nom de Tx côté C#,
   * `KgDocumentWatcher`). `persist_path=null` : le `persist()` interne de
   * `transaction()` est un no-op (on persiste via le store).
   */
  private async getKg(projectId?: string): Promise<ProjectKG> {
    const pid = projectId || "default";
    const state = await this.getDocState().getState();
    const cached = this.instances.get(pid);
    if (
      cached &&
      cached.docKey === state.docKey &&
      cached.epoch === state.epoch
    ) {
      return cached.kg;
    }
    const loaded = await loadProjectKG(this.getStore(), pid, null);
    const kg = loaded ?? new ProjectKG(pid);
    this.instances.set(pid, {
      kg,
      docKey: state.docKey,
      epoch: state.epoch,
    });
    return kg;
  }

  /**
   * Persiste le KG ; **Fix A** (cold repro 2026-05-19, cf. JOURNAL). La
   * mutation est déjà commitée dans le `ProjectKG` EN CACHE (transaction
   * synchrone) avant cet appel. Si `saveProjectKG` échoue (typiquement le
   * timeout socket 120 s sur `kg_blob_write` quand le payload whole-blob
   * dépasse la limite de réassemblage entrant C# — cause racine = Fix B,
   * hors de ce fichier), le cache serait EN AVANCE sur l'ES durable et
   * `kg_query` mentirait. On évince donc l'entrée de cache du project_id
   * (même clé résolue que `getKg`) : le prochain `getKg()` rechargera
   * l'ES = la vérité durable (comportement prouvé par la colonne `instF`
   * de la sonde). On re-lève avec un message **sans ambiguïté** : aucun
   * commit en arrière-plan à supposer, ré-émettre en plus petits lots.
   */
  private async persistOrEvict(
    projectId: string | undefined,
    kg: ProjectKG
  ): Promise<void> {
    try {
      await saveProjectKG(this.getStore(), kg);
    } catch (e) {
      const pid = projectId || "default";
      this.instances.delete(pid); // prochain getKg ⇒ reload ES (vérité)
      const base = e instanceof Error ? e.message : String(e);
      throw new Error(
        `${base} — write NOT persisted (durable .rvt ES unchanged). The ` +
          `in-memory KG view for project '${pid}' has been invalidated and ` +
          `will reload from ES on next access. Do NOT assume a background ` +
          `commit and do NOT blind-retry the same payload: re-issue the ` +
          `write in SMALLER batches (the C# socket cannot reassemble a ` +
          `large inbound request).`
      );
    }
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
      case "modify_element":
        return this.mModifyElement(p);
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

  /**
   * Ajout list-native **1..N**, atomique sur le lot, **1 turn** (un lot de
   * 1 = l'ancien `add_element`). Fusion `add_element`+`add_many` :
   * supprime la quasi-redondance, calque l'API list-native des commandes
   * C# upstream (`create_level(List<…>)`). `core/`/`persist.ts` intacts.
   */
  private async mAddElement(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const elements: Dict[] = p["elements"] ?? [];
    const newIds: string[] = [];
    let edgesAdded = 0;
    kg.transaction(() => {
      kg.advance_turn();
      for (let i = 0; i < elements.length; i++) {
        const spec = elements[i];
        const ident = [
          spec["node_type"] ? `node_type=${spec["node_type"]}` : "",
          spec["llm_id"] ? `llm_id=${spec["llm_id"]}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        newIds.push(atItem("add_element", i, ident, () => addOne(kg, spec)));
        edgesAdded += (spec["edges"] ?? []).length;
      }
    });
    await this.persistOrEvict(p["project_id"], kg);
    return {
      ...idsCompact(newIds),
      edges_added: edgesAdded,
      turn: kg.turn,
    };
  }

  /** Modif list-native **1..N** `[{llm_id,updates}]`, atomique, 1 turn
   *  (fusion `modify_element`+`modify_many`). */
  private async mModifyElement(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const edits: Dict[] = p["edits"] ?? [];
    const ids: string[] = [];
    kg.transaction(() => {
      kg.advance_turn();
      for (let i = 0; i < edits.length; i++) {
        const it = edits[i];
        atItem("modify_element", i, `llm_id=${it["llm_id"]}`, () =>
          kg.modify_node(it["llm_id"], it["updates"])
        );
        ids.push(it["llm_id"]);
      }
    });
    await this.persistOrEvict(p["project_id"], kg);
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
    await this.persistOrEvict(p["project_id"], kg);
    return {
      node_type: nodeType,
      matched: matched.length,
      modified: matched.length,
      turn: kg.turn,
      sample_ids: matched.slice(0, ID_CAP),
      truncated: matched.length > ID_CAP,
    };
  }

  /** Soft-delete list-native **1..N** `llm_ids`, atomique, 1 turn
   *  (calque `delete_element(string[])` upstream). */
  private async mSoftDelete(p: Dict): Promise<Dict> {
    const kg = await this.getKg(p["project_id"]);
    const llmIds: string[] = p["llm_ids"] ?? [];
    kg.transaction(() => {
      kg.advance_turn();
      for (let i = 0; i < llmIds.length; i++) {
        const id = llmIds[i];
        atItem("soft_delete", i, `llm_id=${id}`, () => kg.soft_delete(id));
      }
    });
    await this.persistOrEvict(p["project_id"], kg);
    return {
      ...idsCompact(llmIds),
      turn: kg.turn,
      note: "soft delete: nodes retained, queryable with include_deleted=true",
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
    this.instances.delete(pid); // prochain getKg ⇒ reload (graphe vide)
    // L'ES n'a pas de « delete DataStorage » dans le contrat ; on écrase
    // par un graphe vide (recreate-if-missing ⇒ vide == reset). Démo only.
    const before = await loadProjectKG(this.getStore(), pid, null);
    await saveProjectKG(this.getStore(), new ProjectKG(pid));
    return { project_id: pid, removed: before !== null || existedInCache };
  }
}

/** Singleton partagé par tous les outils `kg_*` (comme l'ex-`kgBridge`).
 *  Store résolu lazy ⇒ import sans effet de bord (pas de socket au boot). */
export const kgService = new KgService();
