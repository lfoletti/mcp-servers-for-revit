# `server/src/kg/core/` — port TS de `ProjectKG`

Cœur du KG v1 : portage **TypeScript** de
`kg_bridge/vendor/project_kg.py` (le sidecar Python est supprimé en v1).

- **Spec** : `../../../../DESIGN-internalize-es.md` (§7, §0).
- **Référence du port (figée)** : `kg_bridge/vendor/project_kg.py` + ses
  **821 tests upstream**. Le port est correct *seulement* si la suite
  portée (`__tests__/`) est verte et iso-comportement.
- **Modèle d'identité** : `llm_id` = clé primaire (compteur
  `_next_llm_id` conservé) ; `ElementId` = liaison seule, via une
  `Map<ElementId, llm_id>` globale (cf. spec §2). **Pas** d'ancre par
  élément.
- **Graphe** : `graphology` (multigraphe) ou adjacence maison ; préserver
  l'ordre d'insertion (sémantique de `find_by_type`).
- **Transactions** : `structuredClone()` pour le snapshot/restore.

**Statut : non encore porté.** Étape 1 du plan d'implémentation (spec §10).
