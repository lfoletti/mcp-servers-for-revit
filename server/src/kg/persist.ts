/**
 * persist.ts — contrat de persistance du KG v1 (squelette, non implémenté).
 *
 * Remplace l'écriture disque `<project_id>.kg.json` du PoC : en v1 le
 * graphe est internalisé dans le `.rvt` via ExtensibleStorage. Ce module
 * définit le *contrat* lecture/écriture du blob, agnostique du transport
 * (l'implémentation passera par le WebSocket vers les commandes C#
 * `kg_blob_read` / `kg_blob_write` — cf. DESIGN-internalize-es.md §4, §9).
 *
 * Décisions actées (DESIGN-internalize-es.md §0) :
 *  - graphe vivant et `action_log` sont DEUX conteneurs distincts
 *    (mitigation du plafond 16 Mo/string ES) ;
 *  - le log est chunké (Array<string>) et compactable ;
 *  - une seule `DataStorage` globale, pas d'Entity par élément.
 *
 * STATUT : interface seule. Aucune logique. Étapes 2–3 du plan (spec §10).
 */

/** Blob "graphe vivant" : nodes, edges, counters, turn, tombstones,
 *  types KG-only, et la Map de liaison ElementId -> llm_id.
 *  Sérialisé en JSON versionné. */
export interface LiveGraphBlob {
  schema_version: number;
  /** `ProjectKG.to_dict()` SANS `action_log` (séparé, voir LogChunks). */
  data: unknown;
  /** Liaison transitoire ElementId(Revit) -> llm_id (clé primaire KG).
   *  Remplace `_revit_id` + `full_rescan` (spec §2). */
  revit_binding: Record<number, string>;
}

/** `action_log` append-only, découpé en chunks pour rester sous la
 *  limite 16 Mo/string et permettre rotation/compaction. */
export interface LogChunks {
  schema_version: number;
  /** Chunks ordonnés ; `diff_since()` n'a besoin que d'une fenêtre
   *  récente — les chunks anciens sont compactables/élaguables. */
  chunks: string[];
}

/**
 * Contrat de persistance. L'implémentation v1 le réalisera au-dessus du
 * canal WebSocket existant (vers l'add-in C#). Tout est async : la
 * persistance traverse une frontière process (cf. cohérence cache, §5).
 */
export interface KgPersistence {
  /** Charge le graphe vivant. `null` si la `DataStorage` est absente
   *  (premier usage, ou purgée → recreate-if-missing côté C#). */
  loadGraph(projectId: string): Promise<LiveGraphBlob | null>;

  /** Écrit le graphe vivant. Côté C# : dans une `Transaction` Revit
   *  (atomicité Stage 2, spec §1). */
  saveGraph(projectId: string, blob: LiveGraphBlob): Promise<void>;

  /** Charge les chunks de log (vide si absent). */
  loadLog(projectId: string): Promise<LogChunks>;

  /** Ajoute des entrées de log (append ; peut créer un nouveau chunk). */
  appendLog(projectId: string, entries: string[]): Promise<void>;

  /** Compacte/élague les vieux chunks (politique de rétention à définir
   *  — `diff_since()` ne lit qu'une fenêtre récente). */
  compactLog(projectId: string, keepFromTurn: number): Promise<void>;
}

/** Sentinelle tant que l'implémentation n'existe pas (étapes 2–3, §10). */
export class NotImplementedPersistence implements KgPersistence {
  private fail(): never {
    throw new Error(
      "KgPersistence non implémenté — squelette v1 (DESIGN-internalize-es.md §10)."
    );
  }
  loadGraph(): Promise<LiveGraphBlob | null> { return this.fail(); }
  saveGraph(): Promise<void> { return this.fail(); }
  loadLog(): Promise<LogChunks> { return this.fail(); }
  appendLog(): Promise<void> { return this.fail(); }
  compactLog(): Promise<void> { return this.fail(); }
}
