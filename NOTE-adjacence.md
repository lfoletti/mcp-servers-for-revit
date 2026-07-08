# NOTE — Adjacence des pièces + lignes de séparation dans le KG (session dédiée)

_Rédigé le 2026-07-08. À traiter dans une session Claude Code dédiée, sur ce repo. La branche courante `note/execute-arbitraire` porte déjà des modifs sur `EdgeTypes.cs`, `NodeTypeRegistry.cs`, `RevitElementReader.cs`, `KgV2DocumentWatcher.cs` — à réconcilier avant implémentation._

## Objectif

Doter le KG d'une **adjacence pièce-à-pièce fiable** et projeter les **lignes de séparation**, pour casser la topologie en étoile (tout pend de `Level` via `at_level`) et rendre possibles les requêtes spatiales / design. **Déterministe, sans LLM.**

## Constat (validé sur modèle vivant — B24-4203 CORSAGE, 08.07.2026)

- KG actuel : uniquement des arêtes **F1 verticales** → étoile (`Level N0` betweenness **0.465**, degré **356**). Aucune adjacence, aucune contenance FF&E.
- **Export seul** : 8 paires (murs uniquement), plusieurs pièces dégénérées (`area=0`) → inexploitable.
- **Sonde live** (`GetBoundarySegments` + `GetRoomAtPoint`, read-only) : **13 pièces réelles, 16 adjacences, 58 murs + 21 lignes de séparation**. Les 12 pièces du N0 forment **une seule composante connexe**.

→ L'adjacence n'est fiable **que** sur le modèle vivant, **lignes de séparation comprises** — impossible à déduire du snapshot exporté.

## Décisions de schéma

### Nouveau node type `RoomSeparationLine`
- **Pourquoi :** `bounded_by` ne pointe aujourd'hui que vers des murs (le lecteur filtre les segments non-mur) ; les séparations complètent la frontière. Élément-courbe, comme `ModelLine` / `DetailLine` déjà déclarés.
- **Attrs :** `p1`, `p2`, `length`, `level_ref`.
- **Régime : Projected** (par-élément, peu coûteux).

### `bounded_by` étendu
- `Room → RoomSeparationLine` (en plus de `Room → Wall`). Revit-owned, **Projected**.

### Nouvelle arête `adjacent_to` (Room ↔ Room)
- **Directe et exacte**, issue du test segment/`GetRoomAtPoint`. **Pas** reconstruite des nodes partagés : un mur borne 1:n → cela génèrerait des faux positifs (pièces aux deux bouts d'un long mur).
- **Attrs :** `boundary_type ∈ {wall, separation, mixed}` · `via = [llm_id des nodes-frontière médiateurs]` (homogène, jamais un union node/string) · `computed_at_turn`.
- **Direction canonique** : `src = min(llm_id)` → pas de doublon.
- **Régime : Derived** (à la demande).
- **À NE PAS FAIRE :** (a) `glue` en attribut hétérogène (node-id | string) — casse la traversée typée, ne gère pas le cas `mixed`/multi (observé), pend au delete. (b) `Room —is_adj→ médiateur —is_adj→ Room` — surcharge sémantique (une pièce est *bornée par* un mur, pas *adjacente*) **et** sur-génération (mur 1:n). La réification via un node `Interface` n'est justifiée que si l'adjacence doit porter des attributs riches (feu/acoustique/ouverture partagée) — **hors scope v1**.

## Taxonomie des régimes de mise à jour (à formaliser)

Trois classes, marquées **au niveau du type** (comme `EdgeTypes.F1`/`F2` et `NodeTypeSpec.RebuiltByRescan`), **jamais dans le nom** (le nom porte le sens ; sinon un changement de régime imposerait un renommage + migration).

| Régime | Sens | Fraîcheur | Membres |
|---|---|---|---|
| **Projected** | repatché par `DocumentChanged` | toujours à jour | `at_level`, `is_type`, `hosts`, `bounded_by`, `has_material` ; node `RoomSeparationLine` |
| **Derived** | recalculé par un tool batch, pas à chaque transaction | à jour **après un run** → périmable | `adjacent_to` |
| **Authored** | écrit par l'agent/utilisateur | responsabilité de l'auteur | `replaced_by`, `tagged`, `violates_rule`, `implements_intent`, `contains` |

**Implémentation :**
- `EdgeTypes` : ajouter un ensemble `Derived` (ou une map `type → régime`) à côté de `F1`/`F2`. `adjacent_to` ∈ Derived ; `bounded_by` reste Projected.
- **Fraîcheur (seule classe Derived) :** stamp `computed_at_turn = K` (KG-level `adjacency_computed_at_turn` + sur chaque arête). Réutiliser `kg_diff_since(K)` / `kg_detect_drift` : si une `Room`/`Wall`/`RoomSeparationLine` a été modifiée au tour > K → adjacence **potentiellement périmée**, à signaler. Pas de nouvelle mécanique.
- **Introspection :** exposer la classe (+ `computed_at_turn` pour Derived) via `kg_session_info` (ou un `kg_schema`) → l'agent sait à la lecture si `adjacent_to` est live ou instantané. Prolonge l'esprit « audit honnête ».

## Le tool `kg_compute_adjacency`

Nouvelle commande C# (`commandset-kg/Commands` + handler `Services` + enregistrement `command-registry` + tool MCP côté serveur TS). **Déterministe, zéro LLM, idempotent** (upsert complet = replace, rejouable sans doublon).

**Algorithme** (repris de la sonde validée) :
```
turn = kg.AdvanceTurn()
pour chaque Room r (Area>0, Location!=null):
    phase = doc.GetElement(r.CreatedPhaseId) as Phase
    pour chaque segment s de r.GetBoundarySegments(Finish):
        be = doc.GetElement(s.ElementId); isSep = be.Category == OST_RoomSeparationLines
        si isSep: assurer node RoomSeparationLine(be) + bounded_by(r → sep)   # Projected
        voisin = GetRoomAtPoint(mid(s) ± normal * {0.3,0.8,1.5}ft, phase), != r
        si voisin: pair=(min,max) ; agréger boundary_type ; via += node(be)
    # fin r
pour chaque pair agrégée:
    upsert adjacent_to(a, b, boundary_type, via, computed_at_turn=turn)   # Derived
supprimer les adjacent_to dont la pair n'apparaît plus (replace complet)
```
**Signature MCP :** `kg_compute_adjacency()` → `{ rooms, pairs, separation_lines, computed_at_turn }`. Option future : `scope` par niveau. **Côté Revit : lecture pure** (`GetRoomAtPoint`), aucune transaction Revit ; écriture KG uniquement.

## Points de vigilance

- `GetRoomAtPoint` coûteux (raycast × segments × pièces) → **Derived on-demand**, surtout pas dans `DocumentChanged`.
- Pièces non-enclose / `area=0` ignorées ; **doublons de noms désambiguïsés par ElementId** (deux « BO », deux « Lift SAS »).
- Séparations 1:2 (propre) vs murs 1:n ; deux séparations quasi-jumelles (faces d'un même trait, ex. sep `5634474`+`2878148`) → dédup par **pair canonique**, `via` = ensemble.
- **Multi-version 2020–2026** : `GetBoundarySegments`/`GetRoomAtPoint`/`CreatedPhaseId` stables ; `BoundarySegment.GetCurve()` (2022+) — prévoir le fallback `.Curve` si 2020/2021 visés.
- `via` stocke des **llm_id**, pas des ElementId → robuste au rescan (caveat de persistance ElementId connu).

## Fichiers prévus

- `commandset-kg/Core/NodeTypeRegistry.cs` — + `RoomSeparationLine`
- `commandset-kg/Core/EdgeTypes.cs` — + `adjacent_to`, ensemble/régime `Derived`
- `commandset-kg/Services/RevitElementReader.cs` — projeter `RoomSeparationLine` + `bounded_by`→sep (**pas** `adjacent_to` ici)
- `commandset-kg/Commands/KgComputeAdjacencyCommand.cs` — **nouveau**
- `commandset-kg/Services/KgComputeAdjacencyEventHandler.cs` — **nouveau**
- `command-registry.json` / `revit-mcp-kg-commands.json` — enregistrement
- `server/src/tools/kg_compute_adjacency.ts` (+ build) — **nouveau**

## Chaîne de build/déploiement

Nouvelle classe C# → rebuild serveur Node + DLLs → déploiement *Add-ins* (Revit fermé) → bump `command-registry.json` / `revit-mcp-kg-commands.json` → restart. Multi-version.

## Hors scope v1 (notes séparées)

- **`connects_at`** (Wall↔Wall via `LocationCurve.get_ElementsAtJoin`) — Projected/F1 dans le reader, autre passe.
- **`located_in`** (FF&E → Room) + **projection des instances mobilier/luminaire** comme nodes — nécessaire à l'usage design (aujourd'hui : 0 instance FF&E dans le KG, 102/131 `FamilyType` orphelins), mais chantier plus large.
- Node **`Interface`** réifié (adjacence à attributs riches).

_Référence : sonde live + analyse graphify — `\\Baoi-files01\data\IT\temporaire\Revit_to_rhino\notes\` (`NOTE_KG_architecture_2026-07-08.md`, `NOTE_KG_adjacence_2026-07-08.md`)._
