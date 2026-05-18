# `commandset/Commands/KnowledgeGraph/` — commandes C# ES (v1)

Commandes Revit qui exposent l'ExtensibleStorage au serveur MCP. À écrire
sur le **moule exact** de `commandset/Commands/Architecture/CreateLevelCommand.cs`
(commande → `ExternalEvent` → API Revit). Spec :
`../../../DESIGN-internalize-es.md` §4, §8, §9.

À implémenter (étape 3 du plan, spec §10) :

- **`kg_blob_read`** — lit la `DataStorage` globale (graphe vivant +
  chunks de log). **Sans** `Transaction` (lecture ES n'en exige pas).
  `recreate-if-missing` : `DataStorage` absente ⇒ renvoyer vide, pas
  d'erreur (risque « Purge Unused »).
- **`kg_blob_write`** — écrit le(s) blob(s). **Dans une `Transaction`
  Revit** → atomicité Stage 2 gratuite. Écriture chunkée du log
  (plafond 16 Mo/string).

Une seule `DataStorage` globale, pas d'Entity par élément (spec §0.3).
Le handler `DocumentChanged` (liaison/drift) vit dans
`../../Services/KnowledgeGraph/`.

**Statut : non implémenté.**
