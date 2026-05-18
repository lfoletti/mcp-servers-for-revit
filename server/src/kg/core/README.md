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
- **Graphe** : adjacence maison (`graph.ts`, zéro dépendance) ; ordre
  d'insertion préservé (sémantique de `find_by_type`).
- **Transactions** : `structuredClone(to_dict())` pour le snapshot/restore.

## Modules

| Fichier | Rôle |
|---|---|
| `project-kg.ts` | `ProjectKG` (port 1:1 ; API en noms Python pour minimiser la dérive) |
| `graph.ts` | `MultiDiGraph` maison — sous-ensemble networkx réellement utilisé |
| `schema.ts` | `NODE_TYPES` / `SESSION_NODE_TYPES` / `EDGE_TYPES` + constantes |
| `errors.ts` | `ValueError` / `KeyError` (pendants des exceptions Python) |
| `pyjson.ts` | `pyJsonDump` ≡ `json.dump(sort_keys, indent=2)` + `pyInt`/`pyStr` |
| `index.ts` | barrel — surface consommée par les `kg_*.ts` (étape 4) |

**Statut : porté, suite verte (25/25 iso-comportement vs le Python).**
Étape 1 du plan (spec §10) **terminée**. Reste pièges documentés inline :
ordre `find_by_type` (`graph.ts`), rollback `transaction()` (`project-kg.ts`),
sérialisation + delta connue `1.0`→`1` (`pyjson.ts`).
