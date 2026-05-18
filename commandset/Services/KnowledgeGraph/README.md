# `commandset/Services/KnowledgeGraph/` — handlers C# (v1)

`ExternalEvent` handlers des commandes ES + abonnements aux événements
document. Spec : `../../../DESIGN-internalize-es.md` §4, §5, §6.

À implémenter (étapes 3 & 5 du plan, spec §10) :

- **Handlers** des commandes `kg_blob_read` / `kg_blob_write` (moule des
  `*EventHandler.cs` existants, ex.
  `../Architecture/CreateLevelEventHandler.cs`).
- **`DocumentChanged`** — sur `GetDeletedElementIds()` : basculer
  `deleted_at_turn` du node lié + retirer l'entrée de la
  `Map<ElementId,llm_id>` (un id recyclé ne doit pas re-résoudre vers le
  tombstone). Sur `GetAddedElementIds()` : élément neuf (clé absente de la
  Map) ⇒ non lié. C'est aussi la base de `kg_detect_drift` (Stage 2).
- **`DocumentOpened` / `DocumentSynchronizingWithCentral`** — signal
  d'invalidation/reload du cache serveur (cohérence cache↔`.rvt`, §5 ;
  fréquence accrue en worksharing, §6).

**Statut : non implémenté.**
