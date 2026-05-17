"""project_kg.py — NetworkX-backed Knowledge Graph of the Revit project state.

V0 scope: typed nodes/edges, lifecycle attrs (created_at_turn / modified_at_turn /
deleted_at_turn), JSON persistence, atomic transactions via snapshot+restore.

Revit binding (kg_sync.py, the @kg_synced decorator that wraps Revit transactions)
is NOT in scope here — the slice exercises mutations against the KG only.
"""
from __future__ import annotations

import copy
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Set

import networkx as nx


# Schema declared as required/optional attribute sets per node type.
# Subset of §4.1 of the design doc — extend here when new types are needed.
#
# Optional per-type key `rebuilt_by_rescan` (bool, **absent ⇒ True**) :
# `kg_sync.full_rescan` reconstruit le KG depuis le modèle Revit ; un
# type marqué `False` (= état de session / détection pure-Python, non
# dérivable de Revit : `DxfImportContext`, `Stair` option A) est
# **préservé** au lieu d'être détruit. Déclarer ici la non-wipeabilité
# co-localise l'invariant avec la définition du type (cf. JOURNAL
# session z : un Refresh KG cassait `validate_import_3d`). Quiconque
# ajoute un type KG-only voit ce champ et doit trancher.
NODE_TYPES: Dict[str, Dict[str, Any]] = {
    "Level": {
        "required": {"name", "elevation"},
        "optional": set(),
    },
    "Wall": {
        "required": {"type_ref", "level_ref", "p1", "p2", "length", "height"},
        "optional": set(),
    },
    # Hosted opening on a wall. `position` is `[x, y]` in metres in the
    # level plane (z = level_elevation + sill_height, derived). `sill_height`
    # and `head_height` come from the BuiltInParameter
    # `INSTANCE_SILL_HEIGHT_PARAM` / `INSTANCE_HEAD_HEIGHT_PARAM`.
    "Door": {
        "required": {"type_ref", "host_wall_ref", "position", "sill_height", "head_height"},
        "optional": set(),
    },
    "Window": {
        "required": {"type_ref", "host_wall_ref", "position", "sill_height", "head_height"},
        "optional": set(),
    },
    "Room": {
        "required": {"name", "level_ref"},
        "optional": {"area", "boundary_walls", "use_subcategory"},
    },
    "WallType": {
        "required": {"name", "total_thickness"},
        "optional": {"layers_summary"},
    },
    # Floor (sol / dalle) — surface horizontale au niveau `level_ref`.
    # `boundary` est une polyligne fermée (le 1er sommet est implicitement
    # ré-connecté au dernier) en mètres dans le plan du level. `area_m2`
    # est calculée (shoelace côté KG) ou lue depuis Revit
    # (`HOST_AREA_COMPUTED`).
    "Floor": {
        "required": {"type_ref", "level_ref", "boundary", "area_m2"},
        # `holes` : liste de polylignes fermées (trous : cages d'escalier,
        # patios, atria) en mètres dans le plan du level. Index 0 du Floor
        # Revit-side = outer boundary, holes indices > 0. Si absent ou [],
        # dalle pleine (cas P7). cf. `dwg_section_reader.FloorHole` +
        # JOURNAL session w Phase D.
        "optional": {"holes"},
    },
    # FloorType — un FloorType Revit. `total_thickness` est en mètres,
    # parallèle à WallType. Différencié de WallType pour que
    # `catalog_list_*` ne mélange pas les catalogues côté LLM.
    "FloorType": {
        "required": {"name", "total_thickness"},
        "optional": {"layers_summary"},
    },
    # DxfImportContext — singleton-ish (1 par projet KG max) qui matérialise
    # l'état de l'import DXF en cours (Phase 1 de UC1 §JOURNAL 2026-05-13).
    # Persisté pour que la session conversationnelle puisse reprendre les
    # décisions du tour précédent (section_lines pointées par l'user,
    # niveaux reconciliés, liens CAD posés, etc.) sans tout recommencer.
    "DxfImportContext": {
        "required": {"directory"},
        "optional": {
            "source",                 # str — "revit_aia", "archicad", ...
            "files",                  # list of {path, kind: plan|section, source_layer_set}
            "section_lines",          # list of {plan_p1, plan_p2, view_dir, coupe_path, name, confirmed_by_user, scale_verified, drift_pct}
            "level_reconciliation",   # dict {coupe_levels, project_levels, matches, missing, extra, mismatches}
            "linked_views",           # list of {file_path, link_revit_id, view_revit_id}
        },
        # État de session d'import — non dérivable du modèle Revit.
        "rebuilt_by_rescan": False,
    },
    # Architectural OR structural column (distinguished by `kind`).
    # `position` is `[x, y]` in metres in the level plane; vertical
    # placement is handled by the base level + a top offset = `height`.
    "Column": {
        "required": {"level_ref", "type_ref", "position", "height", "kind"},
        "optional": set(),
    },
    # FamilySymbol of a column family, distinguished from generic family
    # types so the agent doesn't confuse "Generic Column 200x200" with a
    # door family. `kind` mirrors the host categories.
    "ColumnType": {
        "required": {"family_name", "type_name", "kind"},
        "optional": set(),
    },
    # Generic FamilySymbol used by Door/Window instances (and any future
    # hosted family type we add — furniture, equipment, etc.). The
    # `category` discriminator is required so `catalog_list_door_types`
    # / `catalog_list_window_types` can filter without us having to
    # proliferate node types per category. Mirrors the choice for
    # `ColumnType` (which keeps its own type because of the
    # `kind: architectural | structural` discriminator that doesn't
    # generalise to other hosted families).
    "FamilyType": {
        "required": {"family_name", "type_name", "category"},
        "optional": {"dimensions"},
    },
    # Stair — escalier détecté depuis DXFs plan + coupe (option A, V0)
    # avec extension V0-bis pour la modélisation Revit (option B,
    # StairsEditScope, cf. JOURNAL session y note d'intention).
    #
    # Le node capture :
    #   - les attributs "cage globale" (footprint, niveaux, nb marches
    #     estimé, hauteur de marche, direction) — toujours présents
    #     post-détection.
    #   - les attributs "géométrie modélisable" (runs, landings,
    #     stairs_type_ref) — présents si la détection 2 volées a réussi
    #     ET avant l'appel à stairs_create_in_revit. Sinon absents.
    #   - `revit_id` — set par stairs_create_in_revit après succès du
    #     StairsEditScope.Commit().
    #
    # Si la cage est dans un trou de dalle existant, `hosted_in_hole`
    # réfère `Floor.holes[i]` correspondant (Stair contained_in hole).
    "Stair": {
        "required": {
            "footprint",          # list[[x,y], ...] en m, repère plan DXF
            "level_from_ref",     # ref Level (bas)
            "level_to_ref",       # ref Level (haut)
            "n_treads_estimated", # int
            "riser_height_mm",    # float (hauteur de marche moyenne)
        },
        "optional": {
            "run_width_m",        # largeur d'une volée (estim. cage_w/2 pour U)
            "direction",          # "HAUT" | "BAS" | None — d'après MTEXT IDEN
            "shape",              # "straight" | "L" | "U" | "unknown"
            "source_dxf_plan",    # path relatif
            "source_dxf_section", # path relatif coupe utilisée
            "hosted_in_hole",     # {"floor_ref": "floor_001", "hole_index": 0} | None
            "detection_confidence", # float [0,1]
            # V0-bis (option B — création Revit via StairsEditScope).
            # `runs` : géométrie des volées individuelles. Chaque entrée :
            #   {"p1": [x,y,z], "p2": [x,y,z], "n_treads": int,
            #    "run_width_m": float, "justification": "Center"|"Left"|"Right"}
            # Z (z_p1, z_p2) en mètres relatifs à level_from.elevation.
            # `n_treads` = nb de risers de cette volée (somme sur toutes les
            # volées = nb total entre level_from et level_to).
            "runs",
            # `landings` : paliers intermédiaires. Chaque entrée :
            #   {"footprint": [[x,y], ...], "base_elevation_m": float}
            # base_elevation_m = absolu (= level_from.elevation + h).
            # Le tool create traduira en relatif (à stairs base) au moment
            # de l'appel StairsLanding.CreateSketchedLanding.
            "landings",
            "stairs_type_ref",    # ref StairsType (FamilySymbol Revit)
        },
        # Détection pure-Python DXF (option A V0) — non reconstruit par
        # le rescan Revit (pas de passe Stair dans full_rescan, et option
        # A est KG-only). Préservé même si modélisé Revit (option B) tant
        # que full_rescan n'a pas de passe Stair.
        "rebuilt_by_rescan": False,
    },
    # StairsType — un Stairs FamilySymbol Revit (parallèle à WallType,
    # FloorType, ColumnType). `tread_depth_m` et `riser_height_m` sont
    # les paramètres clefs qui pilotent la création de Runs : Revit calcule
    # `n_risers = round(line.length / tread_depth)` automatiquement. Donc
    # le tool create_in_revit doit choisir un StairsType cohérent avec le
    # `riser_height_mm` détecté en coupe.
    "StairsType": {
        "required": {"name", "tread_depth_m", "riser_height_m"},
        "optional": set(),
    },
    # 3D model lines (`Autodesk.Revit.DB.ModelCurve`). Useful as
    # geometric anchors — "trace des murs sur ces lignes", "mesure
    # cette ligne". V0 supports straight Line geometry only; arcs and
    # splines are skipped during full_rescan.
    "ModelLine": {
        "required": {"p1", "p2", "length"},
        "optional": set(),
    },
    # View-bound 2D detail lines (`Autodesk.Revit.DB.DetailCurve`).
    # Stored without their view binding in V0 — the agent sees their
    # endpoints but doesn't know which plan / section they live in.
    # When `View` becomes a KG node type, we'll attach the link.
    "DetailLine": {
        "required": {"p1", "p2", "length"},
        "optional": set(),
    },
}

# Types non reconstruits par `kg_sync.full_rescan` (cf. clé
# `rebuilt_by_rescan`, absent ⇒ True). Dérivé du schéma → ajouter un
# type KG-only avec `rebuilt_by_rescan: False` l'inscrit automatiquement,
# aucun second endroit à maintenir.
SESSION_NODE_TYPES: frozenset = frozenset(
    t for t, s in NODE_TYPES.items()
    if not s.get("rebuilt_by_rescan", True)
)

# Allowed edge types — used as the MultiDiGraph key, so at most one edge of
# each type between a given (src, dst) pair.
EDGE_TYPES: Set[str] = {
    "at_level",       # Wall/Door/Window/Room -> Level
    "is_type",        # Wall -> WallType, Door/Window -> FamilyType
    "hosts",          # Wall -> Door/Window
    "bounded_by",     # Room -> Wall (one per boundary wall)
    "connects_at",    # Wall -> Wall (corner/T/cross via attrs)
    "derived_from",   # Element -> Element (lineage)
}

# Lifecycle attribute names — centralised so callers stay consistent.
CREATED_AT = "created_at_turn"
MODIFIED_AT = "modified_at_turn"  # list[int]
DELETED_AT = "deleted_at_turn"    # int or None

# Framework-managed attr posed by `kg_sync.bind()` after a Revit element is
# created or rescanned. Set directly via `set_revit_id()`, not through
# `add_node`/`modify_node` (bypasses schema validation).
REVIT_ID = "_revit_id"            # int (long) or absent

# Provenance des FamilyType (et plus généralement des nodes qui peuvent être
# créés via plusieurs voies). Posé par `_create_type_variant_internal` (et
# similaires) pour marquer un node comme « créé via API » par opposition à
# « importé d'un rescan Revit ». Utilisé par `openings_purge_unused_variants`
# pour distinguer les variants éligibles à la purge des types du template
# Revit que l'utilisateur ne veut pas voir disparaître.
ORIGIN = "_origin"                # str ("api") or absent

_RESERVED_ATTRS: Set[str] = {"_type", CREATED_AT, MODIFIED_AT, DELETED_AT, REVIT_ID, ORIGIN}


class ProjectKG:
    """Typed graph of Revit elements with action-grained history.

    A single MultiDiGraph carries every project element. Nodes have a `_type`
    attribute (one of NODE_TYPES) plus lifecycle attrs. Mutations should go
    through `transaction()`, which snapshots state on entry and restores it
    on exception.
    """

    def __init__(self, project_id: str, persist_path: Optional[Path] = None) -> None:
        self.project_id = project_id
        self.persist_path = persist_path
        self._g: nx.MultiDiGraph = nx.MultiDiGraph()
        self._turn: int = 0
        self._action_log: List[Dict[str, Any]] = []
        self._counters: Dict[str, int] = {}

    # ----- Turn counter -------------------------------------------------

    @property
    def turn(self) -> int:
        return self._turn

    def advance_turn(self) -> int:
        self._turn += 1
        return self._turn

    # ----- llm_id allocation -------------------------------------------

    def _next_llm_id(self, node_type: str) -> str:
        self._counters[node_type] = self._counters.get(node_type, 0) + 1
        return "{}_{:03d}".format(node_type.lower(), self._counters[node_type])

    # ----- Node operations ---------------------------------------------

    def add_node(
        self,
        node_type: str,
        attrs: Dict[str, Any],
        llm_id: Optional[str] = None,
        _emit_log: bool = True,
    ) -> str:
        """Add a typed node to the graph.

        Args:
            node_type: One of `NODE_TYPES`.
            attrs: Required + optional attrs for that type.
            llm_id: Explicit id to assign. If `None`, allocate via the typed
                counter. Used by `kg_sync.full_rescan` to *reuse* an existing
                id from a `revit_id → llm_id` snapshot, so that ids stay
                stable across rescans (UX: post-rescan, `wall_001` keeps
                pointing to the same physical wall).
            _emit_log: When `False`, the create action is not appended to the
                action log. Used by `kg_sync.full_rescan` to suppress N
                `create` entries during the rebuild — a single `rescan`
                event is logged at the end instead. Internal flag, leave at
                default for tool code.
        """
        if node_type not in NODE_TYPES:
            raise ValueError("Unknown node type: {}".format(node_type))
        spec = NODE_TYPES[node_type]
        keys = set(attrs)
        missing = spec["required"] - keys
        if missing:
            raise ValueError(
                "Missing required attrs for {}: {}".format(node_type, sorted(missing))
            )
        unknown = keys - spec["required"] - spec["optional"]
        if unknown:
            raise ValueError(
                "Unknown attrs for {}: {}".format(node_type, sorted(unknown))
            )

        if llm_id is None:
            llm_id = self._next_llm_id(node_type)
        if llm_id in self._g:
            raise ValueError("llm_id already in graph: {}".format(llm_id))

        full_attrs: Dict[str, Any] = dict(attrs)
        full_attrs["_type"] = node_type
        full_attrs[CREATED_AT] = self._turn
        full_attrs[MODIFIED_AT] = []
        full_attrs[DELETED_AT] = None

        self._g.add_node(llm_id, **full_attrs)
        if _emit_log:
            self._log("create", llm_id, node_type=node_type, attrs=dict(attrs))
        return llm_id

    def modify_node(self, llm_id: str, updates: Dict[str, Any]) -> None:
        if llm_id not in self._g:
            raise KeyError(llm_id)
        node = self._g.nodes[llm_id]
        if node.get(DELETED_AT) is not None:
            raise ValueError("Node {} is soft-deleted".format(llm_id))

        node_type = node["_type"]
        spec = NODE_TYPES[node_type]
        update_keys = set(updates)
        unknown = update_keys - spec["required"] - spec["optional"]
        if unknown:
            raise ValueError(
                "Unknown attrs for {}: {}".format(node_type, sorted(unknown))
            )

        before = {k: node.get(k) for k in update_keys}
        node.update(updates)
        node[MODIFIED_AT] = list(node.get(MODIFIED_AT, [])) + [self._turn]
        self._log("modify", llm_id, before=before, after=dict(updates))

    def soft_delete(self, llm_id: str) -> None:
        if llm_id not in self._g:
            raise KeyError(llm_id)
        node = self._g.nodes[llm_id]
        if node.get(DELETED_AT) is not None:
            return
        node[DELETED_AT] = self._turn
        self._log("delete", llm_id)

    # ----- Edge operations ---------------------------------------------

    def add_edge(
        self,
        src: str,
        dst: str,
        edge_type: str,
        **attrs: Any,
    ) -> None:
        if edge_type not in EDGE_TYPES:
            raise ValueError("Unknown edge type: {}".format(edge_type))
        if src not in self._g or dst not in self._g:
            raise KeyError(
                "Edge endpoints must exist: {} -> {}".format(src, dst)
            )
        self._g.add_edge(src, dst, key=edge_type, _type=edge_type, **attrs)

    def remove_edge(self, src: str, dst: str, edge_type: str) -> bool:
        """Drop the typed edge `src --(edge_type)-> dst`, returning whether
        it existed. Used by tools that re-route a single edge (e.g.
        `openings_set_type` swaps `is_type` from old to new FamilyType).
        Idempotent — no error if the edge is already absent."""
        if not self._g.has_edge(src, dst, key=edge_type):
            return False
        self._g.remove_edge(src, dst, key=edge_type)
        return True

    # ----- Revit binding -----------------------------------------------

    def set_revit_id(self, llm_id: str, revit_id: int) -> None:
        """Stamp a Revit ElementId.Value on a KG node.

        Bypasses node-type schema validation: `_revit_id` is framework-managed,
        not declared per node type. Persisted as part of `to_dict()`/`from_dict()`
        roundtrip — see kg_sync.py for the trade-off note (Revit doc discourages
        persisting ElementId between sessions; we rely on full_rescan at
        session start to reconcile).
        """
        if llm_id not in self._g:
            raise KeyError(llm_id)
        self._g.nodes[llm_id][REVIT_ID] = int(revit_id)

    def get_revit_id(self, llm_id: str) -> Optional[int]:
        """Return the bound Revit ElementId.Value, or None if unbound."""
        if llm_id not in self._g:
            raise KeyError(llm_id)
        return self._g.nodes[llm_id].get(REVIT_ID)

    # ----- Origin tagging (provenance) ----------------------------------

    def set_origin(self, llm_id: str, origin: str) -> None:
        """Tag a node's provenance (e.g. `"api"` for variants created
        via `openings_create_type_variant` or auto-découple). Bypasses
        node-type schema validation — `_origin` is framework-managed,
        reserved like `_revit_id`.
        """
        if llm_id not in self._g:
            raise KeyError(llm_id)
        self._g.nodes[llm_id][ORIGIN] = str(origin)

    def get_origin(self, llm_id: str) -> Optional[str]:
        """Return the node's `_origin` tag, or `None` if untagged."""
        if llm_id not in self._g:
            raise KeyError(llm_id)
        return self._g.nodes[llm_id].get(ORIGIN)

    def find_by_revit_id(self, revit_id: int) -> Optional[str]:
        """Reverse lookup: return the llm_id bound to a Revit ElementId.Value."""
        target = int(revit_id)
        for nid, attrs in self._g.nodes(data=True):
            if attrs.get(REVIT_ID) == target:
                return nid
        return None

    def snapshot_revit_id_map(self) -> Dict[int, str]:
        """Return `{revit_id: llm_id}` for every node currently bound.

        Used by `kg_sync.full_rescan` to preserve llm_ids across the
        topology clear: ids are re-assigned by matching on `_revit_id`,
        so an element whose Revit ElementId survived the rescan keeps
        the same `wall_007` (etc.) instead of being renumbered. Includes
        soft-deleted nodes so an undo→rescan round-trip recovers the
        original id.
        """
        out: Dict[int, str] = {}
        for nid, attrs in self._g.nodes(data=True):
            rid = attrs.get(REVIT_ID)
            if rid is not None:
                out[int(rid)] = nid
        return out

    def snapshot_revit_id_map_typed(self) -> Dict[int, "tuple"]:
        """`{revit_id: (llm_id, _type)}` — variante type-aware de
        `snapshot_revit_id_map`.

        Requise par `full_rescan` pour ne **réutiliser un llm_id que si
        le type du nœud d'origine == type rebuildé**. Sans ça, un
        ElementId recyclé par Revit (un FamilySymbol supprimé dont l'id
        est réattribué à un ModelLine) ferait hériter au nouveau nœud
        ModelLine l'ancien `column_type_NNN` → `get_revit_id` pointe
        vers le mauvais élément (crash Phase 2d, JOURNAL session z).
        """
        out: Dict[int, tuple] = {}
        for nid, attrs in self._g.nodes(data=True):
            rid = attrs.get(REVIT_ID)
            if rid is not None:
                out[int(rid)] = (nid, attrs.get("_type"))
        return out

    # ----- Topology reset (used by kg_sync.full_rescan) -----------------

    def _clear_topology(self, preserve_counters: bool = False) -> None:
        """Drop all nodes, edges, and (optionally) llm_id counters.

        Keeps `turn`, `action_log`, `project_id`, and `persist_path` intact —
        the hybrid `full_rescan` semantics (decided 2026-05-11): node graph is
        rebuilt from Revit, but the conversational timeline (turn counter +
        history) stays continuous so `diff_since()` keeps working across a
        mid-session refresh.

        Args:
            preserve_counters: When `True`, the `_counters` dict is left
                intact. Used by `kg_sync.full_rescan` so newly-allocated
                llm_ids continue past the highest pre-rescan id (no
                renumbering, no collision with preserved ids reused from
                the `revit_id → llm_id` snapshot). Default `False`
                preserves the original semantics (counters reset to 0).

        Callers should append a single `rescan` entry to the action log so
        the timeline reflects the boundary.
        """
        self._g = nx.MultiDiGraph()
        if not preserve_counters:
            self._counters = {}

    # ----- Queries ------------------------------------------------------

    def has_node(self, llm_id: str) -> bool:
        return llm_id in self._g

    def get_node(self, llm_id: str) -> Dict[str, Any]:
        if llm_id not in self._g:
            raise KeyError(llm_id)
        return dict(self._g.nodes[llm_id])

    def find_by_type(
        self,
        node_type: str,
        include_deleted: bool = False,
    ) -> List[str]:
        out: List[str] = []
        for nid, attrs in self._g.nodes(data=True):
            if attrs.get("_type") != node_type:
                continue
            if not include_deleted and attrs.get(DELETED_AT) is not None:
                continue
            out.append(nid)
        return out

    def find_by_name(
        self,
        name: str,
        node_type: Optional[str] = None,
        include_deleted: bool = False,
    ) -> List[str]:
        """Match nodes whose `name` attribute equals `name` (case-sensitive)."""
        out: List[str] = []
        for nid, attrs in self._g.nodes(data=True):
            if node_type is not None and attrs.get("_type") != node_type:
                continue
            if not include_deleted and attrs.get(DELETED_AT) is not None:
                continue
            if attrs.get("name") == name:
                out.append(nid)
        return out

    def count_by_type(
        self,
        node_type: str,
        include_deleted: bool = False,
    ) -> int:
        return len(self.find_by_type(node_type, include_deleted))

    # ----- Action log ---------------------------------------------------

    def _log(self, action: str, target: str, **details: Any) -> None:
        self._action_log.append({
            "turn": self._turn,
            "action": action,
            "target": target,
            "details": details,
        })

    @property
    def action_log(self) -> List[Dict[str, Any]]:
        return list(self._action_log)

    def diff_since(self, since_turn: int) -> List[Dict[str, Any]]:
        return [a for a in self._action_log if a["turn"] >= since_turn]

    # ----- Serialization -----------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        return {
            "project_id": self.project_id,
            "turn": self._turn,
            "counters": dict(self._counters),
            "nodes": [
                {"id": nid, **dict(attrs)}
                for nid, attrs in self._g.nodes(data=True)
            ],
            "edges": [
                {"src": u, "dst": v, "key": k, **dict(attrs)}
                for u, v, k, attrs in self._g.edges(keys=True, data=True)
            ],
            "action_log": list(self._action_log),
        }

    @classmethod
    def from_dict(
        cls,
        data: Dict[str, Any],
        persist_path: Optional[Path] = None,
    ) -> "ProjectKG":
        kg = cls(project_id=data["project_id"], persist_path=persist_path)
        kg._turn = int(data.get("turn", 0))
        kg._counters = dict(data.get("counters", {}))
        for n in data.get("nodes", []):
            attrs = dict(n)
            nid = attrs.pop("id")
            kg._g.add_node(nid, **attrs)
        for e in data.get("edges", []):
            attrs = dict(e)
            u = attrs.pop("src")
            v = attrs.pop("dst")
            k = attrs.pop("key")
            kg._g.add_edge(u, v, key=k, **attrs)
        kg._action_log = list(data.get("action_log", []))
        return kg

    def persist(self) -> None:
        if self.persist_path is None:
            return
        self.persist_path.parent.mkdir(parents=True, exist_ok=True)
        with self.persist_path.open("w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2, sort_keys=True)

    @classmethod
    def load(cls, persist_path: Path) -> "ProjectKG":
        with persist_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return cls.from_dict(data, persist_path=persist_path)

    # ----- Transactions -------------------------------------------------

    @contextmanager
    def transaction(self) -> Iterator["ProjectKG"]:
        """Atomic mutation block. Restores prior state on any exception.

        Persists to disk on success.
        """
        snapshot = copy.deepcopy(self.to_dict())
        try:
            yield self
        except BaseException:
            restored = ProjectKG.from_dict(snapshot, persist_path=self.persist_path)
            self._g = restored._g
            self._turn = restored._turn
            self._counters = restored._counters
            self._action_log = restored._action_log
            raise
        else:
            self.persist()
