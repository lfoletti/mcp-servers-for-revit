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

Étape 5 (spec §10.5) — **fait** :

- **`KgDocumentWatcher.cs`** — souscrit (lazy/idempotent, depuis les
  handlers KG) à `DocumentChanged` / `DocumentOpened` /
  `DocumentSynchronizingWithCentral`. Maintient un **epoch monotone** +
  l'identité document, exposés par la commande `kg_doc_state` (sans Tx) :
  le serveur sonde, garde son cache si inchangé (« cache longue durée »,
  §5), recharge depuis l'ES sinon. Filtre clé : un `DocumentChanged` dont
  toutes les Tx sont `KgExtensibleStorage.WriteTransactionName` (nos
  propres écritures ES) **n'incrémente pas** l'epoch (sinon perte du cache
  à chaque op). Capture aussi les ids supprimés/ajoutés/modifiés (fenêtre
  bornée, par epoch) = **base de `kg_detect_drift`** (Stage 2).
- **`KgDocStateEventHandler.cs`** — moule `*EventHandler`, sans Tx.

**Différé (§2 / Stage 2, hors périmètre v1).** Basculer `deleted_at_turn`
du node lié + maintenir la `Map<ElementId,llm_id>` sur
`GetDeletedElementIds()` : c'est le refactor identité/liaison §2. Étape 5
ne fait que **câbler le signal** (et l'expose) ; `kg_detect_drift`
consommera le drift plus tard.

**Statut : étapes 3 & 5 implémentées (build Revit requis pour vérifier —
pas de SDK Revit dans cet env, comme toutes les commandes C#).**
