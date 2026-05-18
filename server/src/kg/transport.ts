/**
 * transport.ts — `KgBlobTransport` réel : pont WebSocket(JSON-RPC) vers les
 * commandes C# `kg_blob_read` / `kg_blob_write` (étape 3) au-dessus du
 * `RevitClientConnection` existant (`utils/SocketClient`,
 * `utils/ConnectionManager`). DESIGN-internalize-es.md §9, §10.4.
 *
 * C'est l'unique réalisation concrète du port posé étape 2 ; tout le reste
 * (`persist.ts`, `service.ts`) reste agnostique du transport. Le sidecar
 * Python (`bridge.ts`) est supprimé : le KG vit désormais dans le `.rvt`.
 */
import {
  BlobKgPersistence,
  KgBlobRecord,
  KgBlobTransport,
  KgSnapshotStore,
  LOG_SCHEMA_VERSION,
} from "./persist.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

/**
 * Déballe un `AIResult<T>` C# renvoyé comme `result` JSON-RPC. La casing du
 * *wrapper* (`Success`/`Message`/`Response`) dépend du sérialiseur du
 * plugin (`JToken.FromObject`, RevitMCPSDK) — on lit donc les deux casings.
 * Les champs *internes* (`exists`, `graph`, `log_chunks`,
 * `log_schema_version`) sont figés par `[JsonProperty]` côté C#
 * (`KgBlobModels.cs`) → déterministes quel que soit le résolveur.
 */
function unwrapAiResult<T>(res: any, op: string): T {
  if (res == null || typeof res !== "object") {
    throw new Error(`${op}: empty Revit response`);
  }
  const success = res.Success ?? res.success;
  const message = res.Message ?? res.message;
  const response = res.Response ?? res.response;
  if (success === false) {
    throw new Error(message || `${op} failed (Revit)`);
  }
  return response as T;
}

interface KgBlobReadPayload {
  exists: boolean;
  graph?: string;
  log_chunks?: string[];
  log_schema_version?: number;
}

/**
 * Réalisation socket du port. `read` ⇒ `kg_blob_read` (sans Tx côté C#) ;
 * `exists:false` ⇒ `null` (DataStorage absente : le contrat persist.ts
 * mappe ça sur « rien de persisté », pas une erreur). `write` ⇒
 * `kg_blob_write` (Tx Revit + recreate-if-missing, atomicité §1).
 */
export class SocketKgBlobTransport implements KgBlobTransport {
  // `projectId` n'est PAS envoyé : une seule DataStorage globale par
  // document Revit actif ; le project_id vit déjà dans `graph`
  // (`data.project_id`) et le garde-fou est côté TS
  // (`assembleProjectKG` `expectProjectId`). DESIGN §4.

  async read(_projectId: string): Promise<KgBlobRecord | null> {
    const res = await withRevitConnection((c) =>
      c.sendCommand("kg_blob_read", {})
    );
    const p = unwrapAiResult<KgBlobReadPayload>(res, "kg_blob_read");
    if (!p || !p.exists) return null;
    return {
      graph: p.graph ?? "",
      log_chunks: p.log_chunks ?? [],
      log_schema_version: p.log_schema_version ?? LOG_SCHEMA_VERSION,
    };
  }

  async write(_projectId: string, record: KgBlobRecord): Promise<void> {
    const res = await withRevitConnection((c) =>
      c.sendCommand("kg_blob_write", {
        graph: record.graph,
        log_chunks: record.log_chunks,
        log_schema_version: record.log_schema_version,
      })
    );
    // Lève si Success===false (échec logique côté C#).
    unwrapAiResult<unknown>(res, "kg_blob_write");
  }
}

/**
 * Store v1 par défaut : `BlobKgPersistence` au-dessus du transport socket.
 * **Lazy** — construit au premier usage, jamais à l'import (la
 * registration des outils importe tout au boot ; aucun socket ne doit
 * s'ouvrir là).
 */
let _defaultStore: KgSnapshotStore | null = null;
export function defaultKgStore(): KgSnapshotStore {
  if (_defaultStore === null) {
    _defaultStore = new BlobKgPersistence(new SocketKgBlobTransport());
  }
  return _defaultStore;
}
