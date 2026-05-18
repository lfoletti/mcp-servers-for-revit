# `commandset/Commands/KnowledgeGraph/` — commandes C# ES (v1)

Commandes Revit qui exposent l'ExtensibleStorage au serveur MCP. À écrire
sur le **moule exact** de `commandset/Commands/Architecture/CreateLevelCommand.cs`
(commande → `ExternalEvent` → API Revit). Spec :
`../../../DESIGN-internalize-es.md` §4, §8, §9.

Implémenté (étapes 3 & 5 du plan, spec §10.3/§10.5) :

- **`kg_doc_state`** (`KgDocStateCommand.cs`, étape 5) — renvoie l'epoch
  document monotone + l'identité (+ drift récent, base Stage 2). **Sans**
  `Transaction`. Signal d'invalidation du cache serveur (§5) — handler &
  watcher dans `../../Services/KnowledgeGraph/`.
- **`kg_blob_read`** (`KgBlobReadCommand.cs`) — lit la `DataStorage`
  globale (graphe vivant + chunks de log). **Sans** `Transaction`
  (lecture ES n'en exige pas). `DataStorage` absente ⇒ `exists:false`
  (le transport TS mappe sur `null`, pas d'erreur — risque « Purge
  Unused »). recreate-if-missing porté par `kg_blob_write`.
- **`kg_blob_write`** (`KgBlobWriteCommand.cs`) — écrit l'enregistrement
  complet **dans une `Transaction` Revit** → atomicité Stage 2 gratuite ;
  recreate-if-missing la `DataStorage`. Le découpage 16 Mo/chunk est
  garanti **côté TS** (`server/src/kg/persist.ts`) ; ici on stocke tel
  quel (C# = coffre à blob « bête »).

Logique ES centralisée dans
`../../Services/KnowledgeGraph/KgExtensibleStorage.cs` (schéma GUID
constant, find-or-create de l'unique `DataStorage` globale, get/set
Entity). DTOs : `../../Models/KnowledgeGraph/KgBlobModels.cs` (clés JSON
figées snake_case = `KgBlobRecord` TS). Une seule `DataStorage` globale,
pas d'Entity par élément (spec §0.3). Enregistrés dans
`../../../command.json`.

**Statut : étapes 3 & 5 implémentées. Build Revit requis pour vérifier
(pas de SDK Revit dans cet env — comme toutes les commandes C#).**
Le câblage du *signal* §5 est fait (`kg_doc_state` + `KgDocumentWatcher`) ;
la consommation du drift (`deleted_at_turn`, `Map<ElementId,llm_id>`) est
le refactor §2 / `kg_detect_drift` Stage 2 — différé, hors périmètre v1.
