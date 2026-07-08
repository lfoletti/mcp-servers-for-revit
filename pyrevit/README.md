# planbook — PyRevit

**planbook** automatise la création des plans et vues liés au modèle Revit.
C'est une fonction-parent qui orchestre plusieurs **sous-fonctions**, chacune
générant une famille de vues/feuilles. Port Python/PyRevit consolidé du
prototype C# (`tools/enlarged-plans/`).

## Structure

```
pyrevit/
  run_planbook.py          # point d'entrée actionnable PyRevit
  planbook/
    __init__.py            # ombrelle : run_planbook(doc, only, config, log)
    enlarged_plans.py      # sous-fonction : 1 feuille "Enlarged Plan" / pièce
    README.md              # (ce fichier renvoie ici pour le détail)
```

Chaque sous-fonction expose le même patron : **`run(doc, cfg=None, log=None)`**,
qui suppose une Transaction ouverte (gérée par `planbook`) et retourne le nombre
de feuilles créées. `run_planbook` ouvre **une seule Transaction** et enchaîne
les sous-fonctions activées.

## Lancer (PyRevit)

1. Ouvrir le modèle (pièces numérotées = numéros de feuille).
2. Exécuter `run_planbook.py` (ou le placer dans un `.pushbutton/` d'extension).
3. Config par sous-fonction dans `DEFAULT_CONFIG` du module, surchargeable :

```python
run_planbook(doc, only=["enlarged_plans"],
             config={"enlarged_plans": {"onExisting": "duplicate"}})
```

## Sous-fonctions

| Sous-fonction | État | Rôle |
|---|---|---|
| `enlarged_plans` | ✅ | Une feuille "Enlarged Plan" par pièce. |
| `facade_plans` / `facade_elevations` | ⭘ à faire | Plans & élévations de façade. |
| `sections` | ⭘ à faire | Coupes placées et cadrées. |
| `furniture` / `flooring` / `ceiling` | ⭘ à faire | Plans thématiques. |
| `dimensions` / `tags` | ⭘ à faire | Annotations auto. |

Ajouter une sous-fonction = créer `planbook/<nom>.py` avec `run(doc, cfg, log)`,
puis l'enregistrer dans `SUBFUNCTIONS` (`planbook/__init__.py`).

---

## `enlarged_plans` — le process, en fonctions

`run()` orchestre ; chaque étape est une fonction unitaire documentée :

| Fonction | Rôle |
|---|---|
| `build_context` | Résout cartouche, VFT FloorPlan, niveaux, phases, filtres de phase, catégories, n° de feuilles / noms de vues existants. |
| `target_rooms` | Pièces placées (`Area>0`, `Location`) dont le `Number` matche `numberRegex`. |
| `resolve_scale_and_margin` | Échelle du ladder **+ auto-tune de marge** (réduit la marge jusqu'au plancher pour rattraper une échelle plus fine). |
| `room_outer_loop` | **Contour** de la pièce reconstruit en polyligne fermée (segments *Finish* non contigus). |
| `offset_out` | Offset du contour vers l'extérieur (marge). |
| `apply_view_config` | Config **complète** figée sur une vue créée de zéro : discipline / phase / filtre / plage **+ V/G** (catégories **et** sous-catégories masquées, DWG importés). |
| `hide_foreign_elevation_marks` | **Filtre définitif** : ne garde une marque d'élévation que si le **préfixe numérique de sa vue == `Number` de la pièce** (409 → vues « 409 - … »). Les autres (pièces voisines) sont masquées. |
| `_apply_crop` | Crop rectangle bbox+marge → **forme = contour** (fallback rectangle) ; crop (ré)activé **en dernier** ; `CropBoxVisible` piloté par `cropBoxVisible` (0 = contour non affiché). |
| `create_sheet_and_view` | Une feuille A3 + vue + viewport pour un (pièce, niveau). |

### Décisions / pièges capturés

- **Numéro de pièce = numéro de feuille** (source de vérité).
- **Échelle = f(dépassement)** : ladder `[25,35,50]`, auto-tune de marge (0,5→0,2)
  reproduit 11/11 les échelles faites main.
- **Crop = contour, pas bbox** : segments *Finish* non contigus → polyligne.
- **Config de vue = TOUS les paramètres** : sans la sous-catégorie
  `Lignes > <Séparation de pièce>`, les « traits de construction » réapparaissent.
  Liste obtenue par **diff** vue fraîche vs vue de référence.
- **DWG importés** : la référence les masque **par élément** (invisible au diff
  catégorie) → on masque toutes les catégories `.dwg/.dxf/.dgn`.
- **`CropBoxVisible = 0`** : le contour du crop ne s'affiche pas (spec Rolex).
- **Crop actif en dernier** : `SetCropShape` désactive le crop (bug 401 sinon).
- **Marques/annotations de vues** — filtre **définitif** : on n'affiche une
  marque d'élévation que si le **préfixe numérique de la vue == `Number` de la
  pièce** (ex. pièce 409 → vues « 409 - … »). Tout le reste (marqueurs des
  pièces voisines + leurs vues, cat *Vues*) est masqué. Règle exacte, sans
  géométrie ni dépendance au crop.
- **Escalier / multi-niveaux** : `levelByNumber` → **une feuille par niveau**.

### À réajuster par projet

`titleBlockFamily`, `drawableMm`/`viewportCenterMm` (mesurés A3 Rolex),
`viewConfig.hiddenCategories`, `localByNumber`/`levelByNumber`, `titleBlockFields`.

### Limites connues

- Crop **contour** peut retomber en bbox sur une pièce très concave (fallback auto).
- Les **annotations propres** de la référence (tags mobilier, cotes) ne sont pas
  reproduites (view-specific) — hors périmètre.
