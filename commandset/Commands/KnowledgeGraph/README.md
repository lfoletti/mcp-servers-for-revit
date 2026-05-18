# `commandset/Commands/KnowledgeGraph/` — commandes C# ES (v1)

Commandes Revit qui exposent l'ExtensibleStorage au serveur MCP. À écrire
sur le **moule exact** de `commandset/Commands/Architecture/CreateLevelCommand.cs`
(commande → `ExternalEvent` → API Revit). Spec :
`../../../DESIGN-internalize-es.md` §4, §8, §9.

Implémenté (étape 3 du plan, spec §10.3) :

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

**Statut : implémenté (étape 3). Build Revit requis pour vérifier
(pas de SDK Revit dans cet env — comme toutes les commandes C#).**
Le handler `DocumentChanged` (liaison/drift, étape 5) vit dans
`../../Services/KnowledgeGraph/` — encore à faire.
