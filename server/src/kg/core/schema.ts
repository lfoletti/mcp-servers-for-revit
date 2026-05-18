/**
 * schema.ts — port des constantes de module de `project_kg.py`.
 *
 * `NODE_TYPES` déclare, par type de nœud, les sets d'attributs
 * `required` / `optional`. Clé optionnelle `rebuilt_by_rescan` (bool,
 * **absente ⇒ true**) : `kg_sync.full_rescan` reconstruit le KG depuis le
 * modèle Revit ; un type marqué `false` (état de session / détection
 * pure-Python, non dérivable de Revit : `DxfImportContext`, `Stair`
 * option A) est **préservé** au lieu d'être détruit. Co-localiser la
 * non-wipeabilité avec la définition du type est volontaire (cf. JOURNAL
 * upstream : un Refresh KG cassait `validate_import_3d`). Quiconque ajoute
 * un type KG-only voit ce champ et doit trancher.
 *
 * Référence figée : `kg_bridge/vendor/project_kg.py` (lignes 31-244).
 */

export interface NodeTypeSpec {
  required: Set<string>;
  optional: Set<string>;
  /** Absent ⇒ true. `false` = type KG-only, non reconstruit par le rescan. */
  rebuilt_by_rescan?: boolean;
}

export const NODE_TYPES: Record<string, NodeTypeSpec> = {
  Level: {
    required: new Set(["name", "elevation"]),
    optional: new Set(),
  },
  Wall: {
    required: new Set(["type_ref", "level_ref", "p1", "p2", "length", "height"]),
    optional: new Set(),
  },
  // Hosted opening on a wall. `position` is `[x, y]` in metres in the level
  // plane (z = level_elevation + sill_height, derived). `sill_height` /
  // `head_height` come from INSTANCE_SILL_HEIGHT_PARAM / INSTANCE_HEAD_HEIGHT_PARAM.
  Door: {
    required: new Set([
      "type_ref",
      "host_wall_ref",
      "position",
      "sill_height",
      "head_height",
    ]),
    optional: new Set(),
  },
  Window: {
    required: new Set([
      "type_ref",
      "host_wall_ref",
      "position",
      "sill_height",
      "head_height",
    ]),
    optional: new Set(),
  },
  Room: {
    required: new Set(["name", "level_ref"]),
    optional: new Set(["area", "boundary_walls", "use_subcategory"]),
  },
  WallType: {
    required: new Set(["name", "total_thickness"]),
    optional: new Set(["layers_summary"]),
  },
  // Floor (sol / dalle) — surface horizontale au level `level_ref`.
  // `boundary` : polyligne fermée (1er sommet ré-connecté au dernier) en m
  // dans le plan du level. `area_m2` : shoelace côté KG ou HOST_AREA_COMPUTED.
  Floor: {
    required: new Set(["type_ref", "level_ref", "boundary", "area_m2"]),
    // `holes` : liste de polylignes fermées (cages d'escalier, patios, atria)
    // en m. Index 0 Revit = outer boundary, holes indices > 0. Absent/[] →
    // dalle pleine.
    optional: new Set(["holes"]),
  },
  // FloorType — parallèle à WallType ; différencié pour que `catalog_list_*`
  // ne mélange pas les catalogues côté LLM. `total_thickness` en mètres.
  FloorType: {
    required: new Set(["name", "total_thickness"]),
    optional: new Set(["layers_summary"]),
  },
  // DxfImportContext — singleton-ish (1/projet) matérialisant l'état de
  // l'import DXF en cours. Persisté pour reprendre les décisions du tour
  // précédent. État de session — non dérivable du modèle Revit.
  DxfImportContext: {
    required: new Set(["directory"]),
    optional: new Set([
      "source",
      "files",
      "section_lines",
      "level_reconciliation",
      "linked_views",
    ]),
    rebuilt_by_rescan: false,
  },
  // Architectural OR structural column (distinguished by `kind`).
  // `position` = `[x, y]` en m ; placement vertical = base level + top
  // offset = `height`.
  Column: {
    required: new Set(["level_ref", "type_ref", "position", "height", "kind"]),
    optional: new Set(),
  },
  // FamilySymbol de famille de poteau, distinct des family types génériques.
  // `kind` reflète les host categories.
  ColumnType: {
    required: new Set(["family_name", "type_name", "kind"]),
    optional: new Set(),
  },
  // FamilySymbol générique utilisé par Door/Window (et toute famille hostée
  // future). Le discriminant `category` est requis pour que
  // `catalog_list_door_types` / `_window_types` filtrent sans proliférer les
  // types de nœuds par catégorie. Calqué sur `ColumnType` (qui garde son
  // type à cause du discriminant `kind` non généralisable).
  FamilyType: {
    required: new Set(["family_name", "type_name", "category"]),
    optional: new Set(["dimensions"]),
  },
  // Stair — escalier détecté depuis DXFs plan + coupe (option A, V0) avec
  // extension V0-bis pour la modélisation Revit (option B, StairsEditScope).
  // Capture : attrs "cage globale" (toujours post-détection), attrs
  // "géométrie modélisable" (runs/landings/stairs_type_ref si détection
  // 2 volées OK et avant stairs_create_in_revit), `revit_id` (set par
  // stairs_create_in_revit après StairsEditScope.Commit()).
  Stair: {
    required: new Set([
      "footprint", // list[[x,y], ...] en m, repère plan DXF
      "level_from_ref", // ref Level (bas)
      "level_to_ref", // ref Level (haut)
      "n_treads_estimated", // int
      "riser_height_mm", // float (hauteur de marche moyenne)
    ]),
    optional: new Set([
      "run_width_m",
      "direction",
      "shape",
      "source_dxf_plan",
      "source_dxf_section",
      "hosted_in_hole",
      "detection_confidence",
      "runs", // géométrie des volées (option B)
      "landings", // paliers intermédiaires (option B)
      "stairs_type_ref", // ref StairsType (FamilySymbol Revit)
    ]),
    // Détection pure-Python DXF (option A V0) — non reconstruit par le
    // rescan Revit. Préservé même si modélisé Revit (option B).
    rebuilt_by_rescan: false,
  },
  // StairsType — un Stairs FamilySymbol Revit (parallèle à WallType/Floor
  // Type/ColumnType). `tread_depth_m`/`riser_height_m` pilotent la création
  // des Runs (Revit : n_risers = round(line.length / tread_depth)).
  StairsType: {
    required: new Set(["name", "tread_depth_m", "riser_height_m"]),
    optional: new Set(),
  },
  // 3D model lines (`Autodesk.Revit.DB.ModelCurve`). Ancres géométriques.
  // V0 : Line droite seulement (arcs/splines skippés au full_rescan).
  ModelLine: {
    required: new Set(["p1", "p2", "length"]),
    optional: new Set(),
  },
  // View-bound 2D detail lines (`Autodesk.Revit.DB.DetailCurve`). Stockées
  // sans leur view binding en V0.
  DetailLine: {
    required: new Set(["p1", "p2", "length"]),
    optional: new Set(),
  },
};

/**
 * Types non reconstruits par `kg_sync.full_rescan` (clé `rebuilt_by_rescan`,
 * absente ⇒ true). Dérivé du schéma → ajouter un type KG-only avec
 * `rebuilt_by_rescan: false` l'inscrit automatiquement.
 */
export const SESSION_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.entries(NODE_TYPES)
    .filter(([, s]) => !(s.rebuilt_by_rescan ?? true))
    .map(([t]) => t)
);

/**
 * Types d'arêtes autorisés — sert de clé du `MultiDiGraph`, donc au plus une
 * arête de chaque type entre un couple `(src, dst)` donné.
 */
export const EDGE_TYPES: ReadonlySet<string> = new Set([
  "at_level", // Wall/Door/Window/Room -> Level
  "is_type", // Wall -> WallType, Door/Window -> FamilyType
  "hosts", // Wall -> Door/Window
  "bounded_by", // Room -> Wall (one per boundary wall)
  "connects_at", // Wall -> Wall (corner/T/cross via attrs)
  "derived_from", // Element -> Element (lineage)
]);

// Noms d'attributs de cycle de vie — centralisés pour cohérence appelants.
export const CREATED_AT = "created_at_turn";
export const MODIFIED_AT = "modified_at_turn"; // number[]
export const DELETED_AT = "deleted_at_turn"; // number | null

// Attr framework-managed posé par `kg_sync.bind()`. Set via `set_revit_id()`,
// pas via add/modify (contourne la validation de schéma).
export const REVIT_ID = "_revit_id"; // number (long) ou absent

// Provenance des nodes créables par plusieurs voies. Posé par
// `_create_type_variant_internal` & co pour marquer "créé via API" vs
// "importé d'un rescan Revit". Utilisé par `openings_purge_unused_variants`.
export const ORIGIN = "_origin"; // "api" ou absent

export const RESERVED_ATTRS: ReadonlySet<string> = new Set([
  "_type",
  CREATED_AT,
  MODIFIED_AT,
  DELETED_AT,
  REVIT_ID,
  ORIGIN,
]);
