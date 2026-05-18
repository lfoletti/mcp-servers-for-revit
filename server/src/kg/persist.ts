/**
 * persist.ts — contrat de persistance du KG v1, AU-DESSUS de `core/`.
 *
 * Remplace l'écriture disque `<project_id>.kg.json` du PoC : en v1 le
 * graphe est internalisé dans le `.rvt` via ExtensibleStorage. Ce module
 * réalise le *contrat* lecture/écriture du blob, **agnostique du
 * transport** : il dépend d'un petit port `KgBlobTransport` (read/write de
 * l'enregistrement brut, taillé 1:1 sur les futures commandes C#
 * `kg_blob_read` / `kg_blob_write`). Le câblage WebSocket→C# est l'étape 3
 * du plan, le rebranchement des `kg_*.ts` l'étape 4 (DESIGN-internalize-es
 * .md §9, §10) — aucun n'apparaît ici.
 *
 * Décisions actées (DESIGN-internalize-es.md §0, §4) réalisées ici :
 *  - graphe vivant et `action_log` = DEUX conteneurs distincts dans une
 *    seule `DataStorage` globale (mitigation du plafond 16 Mo/string ES,
 *    §3) → `KgBlobRecord = { graph (string ES), log_chunks (Array<string>
 *    ES), log_schema_version (int ES) }` ;
 *  - le log est append-only, chunké et compactable — chaque chunk reste
 *    sous une borne très en-deçà des 16 Mo, et `diff_since()` n'a besoin
 *    que d'une fenêtre récente (§4) → compaction par chunk entier ;
 *  - une seule `DataStorage`, pas d'Entity par élément (§4, décision 3).
 *
 * Cohérence cache (§5) : ce module fait un read-modify-write de
 * l'enregistrement complet à chaque opération mutante — c'est le design
 * « toujours cohérent, 1 a/r par op » explicitement accepté §5. Le cache
 * longue-durée des écritures-outils est l'étape 5 du plan, PAS ici
 * (séparation des responsabilités : `persist.ts` = correction d'abord).
 *
 * STATUT : contrat implémenté + vérifiable (transport en mémoire fourni).
 * Étapes 1 (port `core/`, figé `beacfb6`) verte ; étapes 3–5 à venir.
 */
import { ProjectKG } from "./core/index.js";
import type { ProjectKGDict } from "./core/index.js";

// `ActionLogEntry` n'est pas exporté par `core/` (interne à project-kg.ts,
// étape 1 FIGÉE — on ne touche pas core/). On dérive le type de l'élément
// depuis la surface publique `ProjectKGDict` : zéro modif de core/.
type ActionLogEntry = ProjectKGDict["action_log"][number];

/** Tout ce qui est sérialisé dans `LiveGraphBlob.data` (≡ `to_dict()`
 *  SANS `action_log`, qui vit séparément — cf. `LogChunks`). */
type GraphData = Omit<ProjectKGDict, "action_log">;

// ----- Versions de schéma -------------------------------------------------

/** Version du blob "graphe vivant". v1 = première version diffusée ; un
 *  blob d'un schéma *plus récent* que celui supporté est refusé (forward-
 *  incompat explicite) plutôt que parsé de travers. */
export const GRAPH_SCHEMA_VERSION = 1;
/** Version du conteneur `action_log` chunké (indépendante du graphe :
 *  les deux conteneurs évoluent séparément, cf. §4). */
export const LOG_SCHEMA_VERSION = 1;

// ----- Bornes de chunking (ES : 16 Mo/string, §3) -------------------------

/**
 * Cible d'octets par chunk de log. Très en-deçà du plafond ES 16 Mo/string
 * (≥16× de marge) : laisse de la place à l'expansion UTF-16 côté .NET/ES,
 * borne `JSON.stringify` du chunk, et garde la compaction granulaire (un
 * chunk élagué = ~1 Mo récupéré). Surchargeable via `BlobKgPersistence`.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 1_000_000;

/** Garde-fou dur : un *unique* log entry dont le chunk sérialisé dépasse
 *  ceci ne peut PAS tenir en ES — on échoue fort plutôt que d'écrire un
 *  blob que Revit rejettera. 15 Mio, juste sous le plafond 16 Mo. */
export const HARD_CHUNK_LIMIT_BYTES = 15 * 1024 * 1024;

// ----- Blobs (le format persisté) -----------------------------------------

/** Blob "graphe vivant" : nodes, edges, counters, turn, tombstones,
 *  types KG-only, et la Map de liaison ElementId -> llm_id.
 *  Sérialisé en JSON versionné. */
export interface LiveGraphBlob {
  schema_version: number;
  /** `ProjectKG.to_dict()` SANS `action_log` (séparé, voir LogChunks). */
  data: GraphData;
  /** Liaison transitoire ElementId(Revit) -> llm_id (clé primaire KG).
   *  Remplace `_revit_id` + `full_rescan` (spec §2).
   *
   *  TRANSITION §2 : tant que `core/` (étape 1, figée) porte encore la
   *  liaison comme attr node `_revit_id` (round-trippé par to_dict/
   *  from_dict), ce champ est une **projection dérivée** persistée pour la
   *  forward-compat — `assembleProjectKG` ne la ré-applique PAS (from_dict
   *  restaure `_revit_id` depuis les attrs node). Quand le refactor §2
   *  retirera la liaison des nodes, ce champ devient *autoritaire* et
   *  assemble la ré-appliquera. Les clés sortent en `string` (clés JSON) ;
   *  re-`pyInt`-coercées le jour où elles deviennent autoritaires. */
  revit_binding: Record<number, string>;
}

/** `action_log` append-only, découpé en chunks pour rester sous la
 *  limite 16 Mo/string et permettre rotation/compaction. */
export interface LogChunks {
  schema_version: number;
  /** Chunks ordonnés ; chaque chunk = `JSON.stringify(string[])` où chaque
   *  élément est UN log entry opaque sérialisé. `diff_since()` n'a besoin
   *  que d'une fenêtre récente — les chunks anciens sont
   *  compactables/élaguables (par chunk entier, jamais scindé). */
  chunks: string[];
}

/**
 * Enregistrement brut de la `DataStorage` globale, taillé 1:1 sur l'Entity
 * ES (§3, §4) : `kg_blob_read` renvoie ceci (ou `null` si la DataStorage
 * est absente — recreate-if-missing côté C#), `kg_blob_write` l'écrit en
 * entier dans une `Transaction` Revit (atomicité Stage 2 « gratuite », §1).
 */
export interface KgBlobRecord {
  /** Champ string ES : `LiveGraphBlob` sérialisé. `""` ⇒ pas encore de
   *  graphe persisté (log seul écrit). */
  graph: string;
  /** Champ Array<string> ES : les chunks de `action_log`. */
  log_chunks: string[];
  /** Champ int ES : `LogChunks.schema_version` (hors des chunks pour que
   *  ceux-ci restent du pur payload d'entries). */
  log_schema_version: number;
}

// ----- Port de transport (le seam étapes 3–4) -----------------------------

/**
 * Port minimal de transport. **Seule** chose que l'étape 3/4 devra fournir
 * (un client WebSocket vers l'add-in C#). `persist.ts` ne dépend QUE de
 * cette interface → strictement agnostique du transport.
 */
export interface KgBlobTransport {
  /** Lit l'enregistrement (≡ `kg_blob_read`, sans Tx). `null` ⇒
   *  `DataStorage` absente : premier usage, ou purgée
   *  (« Purge Unused ») → recreate-if-missing côté C#. */
  read(projectId: string): Promise<KgBlobRecord | null>;
  /** Écrit l'enregistrement complet (≡ `kg_blob_write` : une `Transaction`
   *  Revit, écriture chunkée). Atomique du point de vue de l'appelant. */
  write(projectId: string, record: KgBlobRecord): Promise<void>;
}

// ----- Contrat de persistance (l'interface donnée, inchangée) -------------

/**
 * Contrat de persistance. L'implémentation v1 (`BlobKgPersistence`) le
 * réalise au-dessus d'un `KgBlobTransport`. Tout est async : la persistance
 * traverse une frontière process (cf. cohérence cache, §5).
 */
export interface KgPersistence {
  /** Charge le graphe vivant. `null` si la `DataStorage` est absente
   *  (premier usage, ou purgée → recreate-if-missing côté C#). */
  loadGraph(projectId: string): Promise<LiveGraphBlob | null>;

  /** Écrit le graphe vivant. Côté C# : dans une `Transaction` Revit
   *  (atomicité Stage 2, spec §1). Ne touche PAS au log. */
  saveGraph(projectId: string, blob: LiveGraphBlob): Promise<void>;

  /** Charge les chunks de log (vide si absent). */
  loadLog(projectId: string): Promise<LogChunks>;

  /** Ajoute des entrées de log (append ; peut créer un nouveau chunk). */
  appendLog(projectId: string, entries: string[]): Promise<void>;

  /** Compacte/élague les vieux chunks (politique de rétention : par chunk
   *  entier — un chunk dont TOUTES les entries ont `turn < keepFromTurn`
   *  est élagué ; un chunk à cheval est conservé entier — `diff_since()`
   *  ne lit qu'une fenêtre récente). */
  compactLog(projectId: string, keepFromTurn: number): Promise<void>;
}

/**
 * Extension : lecture/écriture *atomique de l'enregistrement entier*. C'est
 * la primitive naturelle de `kg_blob_read`/`kg_blob_write` (une seule Tx
 * Revit) et le chemin de `persist()`/`transaction()` (snapshot complet).
 * `KgPersistence` (minimal) reste l'interface du contrat ; ceci s'y ajoute.
 */
export interface KgSnapshotStore extends KgPersistence {
  loadSnapshot(
    projectId: string
  ): Promise<{ graph: LiveGraphBlob | null; log: LogChunks }>;
  saveSnapshot(
    projectId: string,
    snapshot: { graph: LiveGraphBlob; log: LogChunks }
  ): Promise<void>;
}

/** Erreur de persistance : blob corrompu, schéma trop récent, entry log
 *  trop grosse pour ES, etc. Distincte des `ValueError`/`KeyError` de
 *  `core/` (faute de persistance, pas de validation de schéma KG). */
export class KgPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KgPersistenceError";
  }
}

// ----- Helpers chunk <-> entries (format de chunk = source unique) --------

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** Empaquette des entries opaques en UN chunk : `JSON.stringify(string[])`.
 *  Format stable et réversible (cf. `unpackChunk`). */
export function packChunk(entries: string[]): string {
  return JSON.stringify(entries);
}

/** Dépaquette un chunk en ses entries. Lève si le chunk est corrompu
 *  (n'importe quoi d'autre qu'un tableau de strings). */
export function unpackChunk(chunk: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunk);
  } catch (e) {
    throw new KgPersistenceError(
      `chunk de log corrompu (JSON invalide): ${(e as Error).message}`
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((x) => typeof x === "string")
  ) {
    throw new KgPersistenceError(
      "chunk de log corrompu (attendu: tableau de strings)"
    );
  }
  return parsed as string[];
}

/** Aplatit tous les chunks en la liste ordonnée des entries. */
export function readEntriesFromChunks(chunks: string[]): string[] {
  return chunks.flatMap(unpackChunk);
}

/**
 * Append *stable* : conserve les anciens chunks octet-pour-octet (immuables
 * → cache/diff futurs, intention §4), ne rouvre que le dernier chunk
 * partiel, déborde en nouveaux chunks dès qu'un chunk dépasserait
 * `maxBytes`. Une entry isolée dépassant `HARD_CHUNK_LIMIT_BYTES` ne tient
 * pas en ES → on échoue fort.
 */
function appendEntriesToChunks(
  chunks: string[],
  entries: string[],
  maxBytes: number
): string[] {
  if (entries.length === 0) return chunks.slice();

  const out = chunks.slice();
  // Rouvrir le dernier chunk (partiellement rempli) si présent.
  let reopenedIndex = out.length > 0 ? out.length - 1 : -1;
  let buf: string[] =
    reopenedIndex >= 0 ? unpackChunk(out[reopenedIndex]) : [];

  const flush = (): void => {
    const packed = packChunk(buf);
    if (reopenedIndex >= 0) {
      out[reopenedIndex] = packed;
      reopenedIndex = -1;
    } else {
      out.push(packed);
    }
    buf = [];
  };

  for (const e of entries) {
    // Si ajouter `e` ferait dépasser un chunk déjà non-vide, on scelle
    // d'abord le chunk courant, puis on ouvre un chunk neuf pour `e`.
    if (buf.length > 0 && byteLen(packChunk([...buf, e])) > maxBytes) {
      flush();
    }
    buf.push(e);
    if (byteLen(packChunk(buf)) > HARD_CHUNK_LIMIT_BYTES) {
      throw new KgPersistenceError(
        `log entry trop volumineuse pour ExtensibleStorage ` +
          `(chunk > ${HARD_CHUNK_LIMIT_BYTES} octets, plafond ES 16 Mo)`
      );
    }
  }
  flush();
  return out;
}

// ----- Sérialisation des entries de log (frontière persist <-> bridge) ----
//
// À la frontière `KgPersistence` les entries sont des `string` *opaques*.
// La sérialisation concrète (JSON d'`ActionLogEntry`) est connue ICI (la
// bridge core<->blob) et nulle part ailleurs — source unique, cohérente
// avec le `turnOf` par défaut (`JSON.parse(e).turn`).

function serializeLogEntry(e: ActionLogEntry): string {
  return JSON.stringify(e);
}
function deserializeLogEntry(s: string): ActionLogEntry {
  return JSON.parse(s) as ActionLogEntry;
}

// ----- Pont core/ <-> blob ------------------------------------------------

/**
 * `ProjectKG` -> `{ LiveGraphBlob, LogChunks }`. Le cœur de l'étape 2 :
 * comment `to_dict()` se découpe en les DEUX conteneurs (§4).
 */
export function splitProjectKG(
  kg: ProjectKG,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES
): { graph: LiveGraphBlob; log: LogChunks } {
  const dict = kg.to_dict();
  const { action_log, ...graphData } = dict;
  const graph: LiveGraphBlob = {
    schema_version: GRAPH_SCHEMA_VERSION,
    data: graphData,
    revit_binding: kg.snapshot_revit_id_map(),
  };
  const log: LogChunks = {
    schema_version: LOG_SCHEMA_VERSION,
    chunks: appendEntriesToChunks(
      [],
      action_log.map(serializeLogEntry),
      maxChunkBytes
    ),
  };
  return { graph, log };
}

/**
 * `{ LiveGraphBlob, LogChunks }` -> `ProjectKG`. `from_dict` restaure le
 * graphe (y compris `_revit_id` depuis les attrs node, cf. note §2 sur
 * `revit_binding`). `expectProjectId` : garde-fou optionnel (blob chargé
 * sous la mauvaise clé).
 */
export function assembleProjectKG(
  graph: LiveGraphBlob,
  log: LogChunks,
  persistPath: string | null = null,
  expectProjectId?: string
): ProjectKG {
  if (graph.schema_version > GRAPH_SCHEMA_VERSION) {
    throw new KgPersistenceError(
      `blob graphe schema_version=${graph.schema_version} > ` +
        `supporté ${GRAPH_SCHEMA_VERSION} (forward-incompat)`
    );
  }
  if (log.schema_version > LOG_SCHEMA_VERSION) {
    throw new KgPersistenceError(
      `blob log schema_version=${log.schema_version} > ` +
        `supporté ${LOG_SCHEMA_VERSION} (forward-incompat)`
    );
  }
  const data = graph.data;
  if (
    expectProjectId !== undefined &&
    data.project_id !== expectProjectId
  ) {
    throw new KgPersistenceError(
      `project_id du blob (${data.project_id}) != attendu ` +
        `(${expectProjectId})`
    );
  }
  const action_log = readEntriesFromChunks(log.chunks).map(
    deserializeLogEntry
  );
  return ProjectKG.from_dict({ ...data, action_log }, persistPath);
}

// ----- Implémentation du contrat sur un transport -------------------------

export interface BlobKgPersistenceOptions {
  /** Borne d'octets par chunk de log (défaut `DEFAULT_MAX_CHUNK_BYTES`). */
  maxChunkBytes?: number;
  /** Extrait le `turn` d'une entry opaque (pour `compactLog`). Défaut :
   *  `JSON.parse(e).turn` — cohérent avec `serializeLogEntry`. Injectable
   *  pour découpler `persist.ts` du schéma exact d'`ActionLogEntry`. */
  turnOf?: (entry: string) => number;
}

/**
 * `KgPersistence` (+ snapshot) réalisé au-dessus d'un `KgBlobTransport`.
 * Toute opération mutante = read-modify-write de l'enregistrement complet
 * (correction d'abord ; design « toujours cohérent » accepté §5 ; le cache
 * d'écritures est l'étape 5, hors de ce module).
 */
export class BlobKgPersistence implements KgSnapshotStore {
  private readonly maxChunkBytes: number;
  private readonly turnOf: (entry: string) => number;

  constructor(
    private readonly transport: KgBlobTransport,
    opts: BlobKgPersistenceOptions = {}
  ) {
    this.maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this.turnOf =
      opts.turnOf ?? ((e) => (JSON.parse(e) as ActionLogEntry).turn);
  }

  // -- parsing / sérialisation du blob graphe ------------------------------

  private parseGraph(raw: string): LiveGraphBlob | null {
    if (raw === "") return null;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new KgPersistenceError(
        `blob graphe corrompu (JSON invalide): ${(e as Error).message}`
      );
    }
    if (typeof obj !== "object" || obj === null) {
      throw new KgPersistenceError("blob graphe corrompu (pas un objet)");
    }
    const o = obj as Record<string, unknown>;
    if (typeof o.schema_version !== "number") {
      throw new KgPersistenceError(
        "blob graphe corrompu (schema_version manquant/invalide)"
      );
    }
    if (o.schema_version > GRAPH_SCHEMA_VERSION) {
      throw new KgPersistenceError(
        `blob graphe schema_version=${o.schema_version} > ` +
          `supporté ${GRAPH_SCHEMA_VERSION} (forward-incompat)`
      );
    }
    return {
      schema_version: o.schema_version,
      data: o.data as GraphData,
      // Résilience : un blob ancien sans le champ → liaison vide.
      revit_binding:
        (o.revit_binding as Record<number, string> | undefined) ?? {},
    };
  }

  private serializeGraph(blob: LiveGraphBlob): string {
    return JSON.stringify(blob);
  }

  /** Lit l'enregistrement ; `null` si la DataStorage est absente. */
  private async readRecord(
    projectId: string
  ): Promise<KgBlobRecord | null> {
    return this.transport.read(projectId);
  }

  /** Enregistrement vide (DataStorage tout juste (re)créée). */
  private emptyRecord(): KgBlobRecord {
    return {
      graph: "",
      log_chunks: [],
      log_schema_version: LOG_SCHEMA_VERSION,
    };
  }

  // -- KgPersistence -------------------------------------------------------

  async loadGraph(projectId: string): Promise<LiveGraphBlob | null> {
    const rec = await this.readRecord(projectId);
    if (rec === null) return null;
    return this.parseGraph(rec.graph);
  }

  async saveGraph(
    projectId: string,
    blob: LiveGraphBlob
  ): Promise<void> {
    const rec = (await this.readRecord(projectId)) ?? this.emptyRecord();
    rec.graph = this.serializeGraph(blob);
    await this.transport.write(projectId, rec);
  }

  async loadLog(projectId: string): Promise<LogChunks> {
    const rec = await this.readRecord(projectId);
    if (rec === null) {
      return { schema_version: LOG_SCHEMA_VERSION, chunks: [] };
    }
    if (rec.log_schema_version > LOG_SCHEMA_VERSION) {
      throw new KgPersistenceError(
        `blob log schema_version=${rec.log_schema_version} > ` +
          `supporté ${LOG_SCHEMA_VERSION} (forward-incompat)`
      );
    }
    return {
      schema_version: rec.log_schema_version,
      chunks: rec.log_chunks.slice(),
    };
  }

  async appendLog(
    projectId: string,
    entries: string[]
  ): Promise<void> {
    if (entries.length === 0) return;
    const rec = (await this.readRecord(projectId)) ?? this.emptyRecord();
    rec.log_chunks = appendEntriesToChunks(
      rec.log_chunks,
      entries,
      this.maxChunkBytes
    );
    await this.transport.write(projectId, rec);
  }

  async compactLog(
    projectId: string,
    keepFromTurn: number
  ): Promise<void> {
    const rec = await this.readRecord(projectId);
    if (rec === null || rec.log_chunks.length === 0) return;
    // Politique : élaguer un chunk SSI toutes ses entries ont
    // `turn < keepFromTurn`. Les turns ne font qu'avancer et les entries
    // sont append-ordonnées → les chunks périmés forment un préfixe ; on
    // calcule néanmoins par max(turn) du chunk (robuste si la
    // monotonicité venait à casser), jamais en scindant un chunk.
    const kept = rec.log_chunks.filter((chunk) => {
      const turns = unpackChunk(chunk).map(this.turnOf);
      if (turns.length === 0) return false; // chunk vide → élaguable
      return Math.max(...turns) >= keepFromTurn;
    });
    if (kept.length === rec.log_chunks.length) return; // rien à faire
    rec.log_chunks = kept;
    await this.transport.write(projectId, rec);
  }

  // -- KgSnapshotStore (primitive atomique kg_blob_read/write) -------------

  async loadSnapshot(
    projectId: string
  ): Promise<{ graph: LiveGraphBlob | null; log: LogChunks }> {
    const rec = await this.readRecord(projectId);
    if (rec === null) {
      return {
        graph: null,
        log: { schema_version: LOG_SCHEMA_VERSION, chunks: [] },
      };
    }
    if (rec.log_schema_version > LOG_SCHEMA_VERSION) {
      throw new KgPersistenceError(
        `blob log schema_version=${rec.log_schema_version} > ` +
          `supporté ${LOG_SCHEMA_VERSION} (forward-incompat)`
      );
    }
    return {
      graph: this.parseGraph(rec.graph),
      log: {
        schema_version: rec.log_schema_version,
        chunks: rec.log_chunks.slice(),
      },
    };
  }

  async saveSnapshot(
    projectId: string,
    snapshot: { graph: LiveGraphBlob; log: LogChunks }
  ): Promise<void> {
    // Un SEUL write transport = une seule Tx Revit côté C# (atomicité §1).
    await this.transport.write(projectId, {
      graph: this.serializeGraph(snapshot.graph),
      log_chunks: snapshot.log.chunks.slice(),
      log_schema_version: snapshot.log.schema_version,
    });
  }
}

// ----- Façade core/ <-> persistance (ce qu'appellera l'étape 4) -----------

/**
 * Persiste un `ProjectKG` entier, atomiquement (≡ `ProjectKG.persist()` du
 * PoC, mais vers ES au lieu du `.json`). Un seul write → une Tx Revit.
 */
export async function saveProjectKG(
  store: KgSnapshotStore,
  kg: ProjectKG,
  maxChunkBytes: number = DEFAULT_MAX_CHUNK_BYTES
): Promise<void> {
  const { graph, log } = splitProjectKG(kg, maxChunkBytes);
  await store.saveSnapshot(kg.project_id, { graph, log });
}

/**
 * Recharge un `ProjectKG` depuis ES. `null` ⇒ rien de persisté (DataStorage
 * absente / pas encore de graphe) : l'appelant crée un `new ProjectKG`.
 * (≡ `ProjectKG.load()` du PoC, depuis ES.)
 */
export async function loadProjectKG(
  store: KgSnapshotStore,
  projectId: string,
  persistPath: string | null = null
): Promise<ProjectKG | null> {
  const { graph, log } = await store.loadSnapshot(projectId);
  if (graph === null) return null;
  return assembleProjectKG(graph, log, persistPath, projectId);
}

// ----- Transport en mémoire (vérif. agnostique du transport) --------------

/**
 * `KgBlobTransport` en mémoire, zéro dépendance. Permet d'exercer/tester
 * TOUT le contrat *maintenant*, avant que les commandes C# (étape 3)
 * n'existent — c'est la preuve concrète que l'implémentation est bien
 * agnostique du transport. Clone profond en lecture ET en écriture :
 * isole l'appelant exactement comme une vraie frontière process
 * (sérialisation sur le fil) — pas d'alias mémoire qui masquerait un bug.
 */
export class InMemoryBlobTransport implements KgBlobTransport {
  private store = new Map<string, KgBlobRecord>();

  async read(projectId: string): Promise<KgBlobRecord | null> {
    const rec = this.store.get(projectId);
    return rec === undefined ? null : structuredClone(rec);
  }

  async write(projectId: string, record: KgBlobRecord): Promise<void> {
    this.store.set(projectId, structuredClone(record));
  }

  /** Test/debug : la DataStorage existe-t-elle pour ce projet ? */
  has(projectId: string): boolean {
    return this.store.has(projectId);
  }

  /** Test/debug : simule un « Purge Unused » / fermeture du `.rvt`. */
  purge(projectId: string): void {
    this.store.delete(projectId);
  }
}

// ----- Sentinelle (défaut tant qu'aucun transport n'est câblé) ------------

/**
 * Défaut « aucun transport câblé » : échoue fort et explicitement tant que
 * l'étape 3/4 n'a pas injecté un vrai `KgBlobTransport` (ou, en test/dev,
 * un `InMemoryBlobTransport`). Le contrat lui-même EST implémenté
 * (`BlobKgPersistence`) ; ceci ne couvre que l'absence de transport.
 */
export class NotImplementedPersistence implements KgPersistence {
  private fail(): never {
    throw new KgPersistenceError(
      "Aucun KgBlobTransport câblé — injecter BlobKgPersistence(transport) " +
        "(WebSocket→C# étape 3/4, ou InMemoryBlobTransport en test). " +
        "DESIGN-internalize-es.md §10."
    );
  }
  loadGraph(): Promise<LiveGraphBlob | null> { return this.fail(); }
  saveGraph(): Promise<void> { return this.fail(); }
  loadLog(): Promise<LogChunks> { return this.fail(); }
  appendLog(): Promise<void> { return this.fail(); }
  compactLog(): Promise<void> { return this.fail(); }
}
