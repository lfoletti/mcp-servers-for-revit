# `commandset/Services/KnowledgeGraph/` — handlers C# (v1)

`ExternalEvent` handlers des commandes ES + abonnements aux événements
document. Spec : `../../../DESIGN-internalize-es.md` §4, §5, §6.

Étape 3 (spec §10.3) — **fait** :

- **`KgExtensibleStorage.cs`** — source unique des spécificités ES
  (schéma GUID **constant à vie**, find-or-create de l'unique
  `DataStorage` globale, `Read` sans Tx / `Write` en `Transaction`).
- **`KgBlobReadEventHandler.cs` / `KgBlobWriteEventHandler.cs`** — moule
  des `*EventHandler.cs` existants (`../Architecture/CreateLevelEventHandler.cs`) :
  `IExternalEventHandler`+`IWaitableExternalEventHandler`, `ManualResetEvent`,
  `AIResult<T>`. Tournent sur le thread API Revit (obligatoire même en
  lecture).

Étape 5 (spec §10.5) — **à faire** :

- **`DocumentChanged`** — sur `GetDeletedElementIds()` : basculer
  `deleted_at_turn` du node lié + retirer l'entrée de la
  `Map<ElementId,llm_id>` (un id recyclé ne doit pas re-résoudre vers le
  tombstone). Sur `GetAddedElementIds()` : élément neuf (clé absente de la
  Map) ⇒ non lié. C'est aussi la base de `kg_detect_drift` (Stage 2).
- **`DocumentOpened` / `DocumentSynchronizingWithCentral`** — signal
  d'invalidation/reload du cache serveur (cohérence cache↔`.rvt`, §5 ;
  fréquence accrue en worksharing, §6).

**Statut : étape 3 implémentée (build Revit requis pour vérifier — pas
de SDK Revit dans cet env, comme toutes les commandes C#). Handlers
document `DocumentChanged`/`Opened`/`Sync` = étape 5, non implémentés.**
