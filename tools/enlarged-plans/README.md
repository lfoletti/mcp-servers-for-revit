# Enlarged Plans — pipeline de génération

Génère les feuilles **Enlarged Plan** (une par pièce, num de feuille = `Room.Number`)
à partir du modèle : crop = bbox pièce + marge, échelle choisie pour tenir dans le
format, cartouche prérempli, vue de plan créée et placée.

## Fichiers

- **`specs.json`** — toute la config (aucun réglage codé en dur dans le script).
- **`generate.cs`** — le corps de script fourni à `revit_execute`. Lit `specs.json`.

## Lancer

Via l'outil MCP `revit_execute` : `code` = contenu de `generate.cs`,
`parameters = [<chemin specs.json>, <mode>, <filtre>]`.

| mode | transactionMode | effet |
|------|-----------------|-------|
| `dry-run` | `none` | lecture seule : rapporte pièce / crop / échelle / dépassement |
| `apply`   | `auto` | crée vue + feuille + viewport, préremplit le cartouche |

`filtre` = un numéro (`"409"`) pour une seule pièce, ou `""` pour toutes celles
qui matchent `numberRegex`.

Toujours lancer un **`dry-run`** d'abord pour vérifier les échelles.

## Logique

1. Pièces placées dont `Number` matche `numberRegex` (source de vérité = le numéro,
   aligné sur la numérotation des feuilles).
2. `crop = bbox(room) ± marge`. Marge par défaut `marginM` (0,5), plafond
   par pièce via `marginByNumber`.
3. **Échelle + auto-tune de la marge** (`marginAutoTune`) : on prend la plus fine
   de `scaleLadder` qui tient (`crop_papier + annotationAllowanceMm ≤ drawableMm`,
   réserve W/H séparée). Si la marge par défaut fait **basculer d'un cran**, on
   réduit la marge jusqu'au plancher `marginMinM` (0,2) pour récupérer l'échelle
   plus fine — en gardant la **plus grande marge possible** qui la tient ; marge
   marquée `(auto)`. Si même à `marginMinM` l'échelle grossière reste inévitable,
   on **garde la marge par défaut** (0,5).
4. Vue **créée de zéro** (`ViewPlan.Create`) puis **config figée** appliquée
   (`viewConfig` : discipline / phase / filtre de phase / plage de vue) — **aucune
   dépendance à une vue prototype existante** (marche from-scratch). Puis `Scale`,
   `DetailLevel`, `viewFields` (`ROLEX-ETAPES`, `Utilisations de la vue`…),
   annotation crop.
5. Crop : box rectangulaire = bbox ± marge ; si `cropFollowsRoom`, la **forme**
   du crop suit le **contour de la pièce** offset de la marge (polyligne fermée
   reconstruite depuis les segments *Finish*, non contigus). Fallback rectangle.
6. Feuille `A3 horizontal`, `SheetNumber`/`Name` templatés, `.Category` posé,
   cartouche prérempli (`"today"` → date du jour). `onExisting` :
   `skip` | `duplicate` (feuille `-D` à côté de l'existante) ; overridable par
   `parameters[3]`.
7. Viewport centré (`viewportCenterMm`) ; plusieurs niveaux (Stairs) → viewports
   décalés de `multiViewportOffsetMm`.

## Notes / limites

- `onExisting: "skip"` par défaut : les 11 feuilles existantes ne sont pas touchées.
  Passer `"replace"` **ne supprime pas** l'existant en v1 (garde-fou) — pour
  régénérer un local, supprimer d'abord sa feuille + sa vue à la main.
- Crop **contour** : reconstruit en polyligne puis offset via
  `CurveLoop.CreateViaOffset`. Sur certaines pièces (contour non reconstructible
  ou offset auto-intersectant), fallback **bbox rectangulaire** automatique
  (observé sur 402 / 407). Jamais de dépendance à une vue tierce.
- **Config de vue** entièrement dans `viewConfig` (discipline / phase / filtre /
  plage) — reverse-engineered une fois des vues existantes. À réajuster si le
  standard de bureau change. Aucune vue prototype requise.
- Marge par défaut 0,5 m ; `411` mis à 0,25 m dans les specs pour rester en 1:25
  (sinon le pipeline bascule en 1:35, déterministe).
- `drawableMm` (375×270) et `viewportCenterMm` mesurés sur les feuilles A3 Rolex —
  à réajuster si le cartouche change.
