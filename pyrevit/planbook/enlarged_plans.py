# -*- coding: utf-8 -*-
"""
planbook.enlarged_plans — sous-fonction "Enlarged Plans"
========================================================

Sous-fonction de **planbook** (cf. `planbook/__init__.py`). Génère, pour chaque
pièce dont le `Number` matche `DEFAULT_CONFIG["numberRegex"]`, une feuille A3
portant un plan de la pièce :

  * crop qui suit le **contour** de la pièce + marge (fallback bbox) ;
  * **échelle auto** (ladder + auto-tune de la marge pour tenir le format) ;
  * **config de vue complète** figée (discipline / phase / filtre / plage de
    vue + Visibilité-Graphismes : catégories ET sous-catégories masquées,
    DWG importés) -> from-scratch, sans dépendance à une vue existante ;
  * feuille A3, `.Category`, cartouche prérempli, `ROLEX-ETAPES` sur la vue ;
  * **une feuille par niveau** pour les pièces multi-niveaux (escalier) ;
  * **masquage des marques d'élévation des pièces voisines** tombées dans le
    crop (on ne garde que les marqueurs situés DANS la pièce).

Point d'entrée : `run(doc, cfg=None, log=None)` — **suppose une Transaction
ouverte** (gérée par planbook ou l'appelant). Toute la config est dans
`DEFAULT_CONFIG` ; passer un dict `cfg` pour surcharger.
"""

import math
import re

from Autodesk.Revit.DB import (
    FilteredElementCollector, BuiltInCategory, BuiltInParameter, ElementId,
    XYZ, CurveLoop, Line, BoundingBoxXYZ, ViewPlan, ViewSheet, ViewFamilyType,
    ViewFamily, ViewDetailLevel, ViewDiscipline, PlanViewPlane, Viewport, Level,
    FamilySymbol, StorageType, SpatialElementBoundaryOptions, ElevationMarker,
    View, PhaseFilter,
)
from Autodesk.Revit.DB.Architecture import Room
from System.Collections.Generic import List
from System import DateTime

FT = 0.3048          # pied -> mètre
MM = 304.8           # pied -> mm


# =====================================================================
# Config par défaut (calibrée A3 Rolex — à réajuster par projet)
# =====================================================================
DEFAULT_CONFIG = {
    "titleBlockFamily": "oi_Rolex_Cartouche_A3_horizontal",
    "floorPlanViewFamilyType": "Plan d'étage",
    "category": "03 - DERIVED",

    "numberRegex": r"^(40[0-9]|41[01])$",
    "marginM": 0.5,
    "marginMinM": 0.2,
    "marginAutoTune": True,
    "scaleLadder": [25, 35, 50],

    "drawableMm": {"w": 375.0, "h": 270.0},
    "annotationAllowanceMm": {"w": 35.0, "h": 15.0},
    "viewportCenterMm": {"x": 210.0, "y": 160.0},

    "detailLevel": "Fine",
    "cropFollowsRoom": True,
    "cropBoxVisible": False,          # "zone cadrée visible" = 0 (contour non affiché)
    "hideForeignElevationMarks": True,

    "onExisting": "skip",            # skip | duplicate
    "duplicateSuffix": "-D",

    "viewNameTemplate": "{num} - {local} - Enlarged Plan",
    "sheetNameTemplate": "{local} - Enlarged Plan",

    "titleBlockFields": {
        "Dessiné par": "", "Conçu par": "", "Vérifié par": "",
        "Approuvé par": "", "Date de fin de la feuille": "today",
    },
    "viewFields": {
        "ROLEX-ETAPES": "03-DERIVED",
        "Utilisations de la vue": "PRESENTATION",
    },
    "viewConfig": {
        "discipline": "Architectural",
        "phase": "Nouvelle construction",
        "phaseFilter": "All Remaining from Prior Phases + New in Current",
        "viewRangeM": {"top": 2.3, "cut": 1.2, "bottom": -0.5, "depth": -0.5},
        "hideImportedCad": True,
        "hiddenCategories": [
            "Coupes", "Parking", "Zones de définition", "Topographie", "Plantes",
            "Volume", "Eléments", "Espaces analytiques", "Liaisons analytiques",
            "Membres analytiques", "Noeuds analytiques", "Ouvertures analytiques",
            "Panneaux analytiques", "Segments de canalisation analytiques",
            "Segments de gaine analytiques", "Surfaces analytiques",
            "Lignes > <Séparation de pièce>",
            "Pièces > Motif/couleur",
            "Site > Paysage", "Site > Terre-plein", "Site > Limite de propriété",
            "Assemblages structurels > Perçages", "Assemblages structurels > Platines",
            "Assemblages structurels > Ancrages", "Assemblages structurels > Référence",
            "Assemblages structurels > Profils", "Assemblages structurels > Boulons",
            "Assemblages structurels > Goujons", "Assemblages structurels > Autres",
            "Assemblages structurels > Soudures", "Assemblages structurels > Modificateurs",
            "Assemblages structurels > Symbole",
        ],
    },
    "localByNumber": {
        "401": "Welcome & Exhibition Area 1", "402": "Exhibition Area 2",
        "403": "Sales Area 1", "404": "Sales Area 3", "405": "VIP Lounge",
        "406": "Exhibition Area 3", "407": "Lift SAS", "408": "Bar",
        "409": "Sales Area 2", "410": "Stairs", "411": "Dining Exhibition Room",
    },
    "marginByNumber": {},
    "levelByNumber": {"410": ["N0", "N1"]},
}


def _merge(base, override):
    """Fusion superficielle : les clés de `override` remplacent celles de base."""
    out = dict(base)
    if override:
        out.update(override)
    return out


# =====================================================================
# Contexte (résolution du document)
# =====================================================================
def build_context(doc, cfg, log):
    """Résout cartouche, VFT FloorPlan, niveaux, phases, filtres de phase,
    catégories, n° de feuilles / noms de vues existants. Retourne un dict `ctx`
    partagé par les autres fonctions (contient `doc`, `cfg`, `log`)."""
    tb = None
    for e in FilteredElementCollector(doc).OfCategory(
            BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType():
        if e.FamilyName == cfg["titleBlockFamily"]:
            tb = e
            break

    vft = None
    for e in FilteredElementCollector(doc).OfClass(ViewFamilyType):
        if e.ViewFamily == ViewFamily.FloorPlan and e.Name == cfg["floorPlanViewFamilyType"]:
            vft = e.Id
            break

    levels = dict((e.Name, e) for e in FilteredElementCollector(doc).OfClass(Level))
    phases = dict((ph.Name, ph.Id) for ph in doc.Phases)
    phase_filters = dict((e.Name, e.Id) for e in
                         FilteredElementCollector(doc).OfClass(PhaseFilter))
    cats = {}
    for c in doc.Settings.Categories:
        if c is not None and c.Name not in cats:
            cats[c.Name] = c

    sheet_nums = set(e.SheetNumber for e in FilteredElementCollector(doc).OfClass(ViewSheet))
    view_names = set(e.Name for e in FilteredElementCollector(doc).OfClass(View)
                     if not e.IsTemplate)

    return {
        "doc": doc, "cfg": cfg, "log": log,
        "tb": tb, "tb_id": tb.Id if tb else None, "vft": vft,
        "levels": levels, "phases": phases, "phase_filters": phase_filters,
        "cats": cats, "sheet_nums": sheet_nums, "view_names": view_names,
    }


# =====================================================================
# Échelle + auto-tune de la marge (pur, sans doc)
# =====================================================================
def scale_for(bb_w_m, bb_h_m, margin, cfg):
    """Plus fine échelle du ladder qui tient (crop papier + réserve annotation
    <= aire dessinable). Sinon la plus grossière."""
    dw = cfg["drawableMm"]["w"]; dh = cfg["drawableMm"]["h"]
    aw = cfg["annotationAllowanceMm"]["w"]; ah = cfg["annotationAllowanceMm"]["h"]
    cw = bb_w_m + 2 * margin
    ch = bb_h_m + 2 * margin
    for s in cfg["scaleLadder"]:
        if cw * 1000.0 / s + aw <= dw and ch * 1000.0 / s + ah <= dh:
            return s
    return cfg["scaleLadder"][-1]


def max_margin_for(bb_w_m, bb_h_m, scale, cap, cfg):
    """Plus grande marge (<= cap) tenant à l'échelle `scale`, arrondie au cm bas."""
    dw = cfg["drawableMm"]["w"]; dh = cfg["drawableMm"]["h"]
    aw = cfg["annotationAllowanceMm"]["w"]; ah = cfg["annotationAllowanceMm"]["h"]
    w_lim = ((dw - aw) * scale / 1000.0 - bb_w_m) / 2.0
    h_lim = ((dh - ah) * scale / 1000.0 - bb_h_m) / 2.0
    mm = min(w_lim, h_lim, cap)
    return math.floor(mm * 100.0) / 100.0


def resolve_scale_and_margin(bb_w_m, bb_h_m, cap_margin, cfg):
    """(scale, margin) : échelle à la marge par défaut ; si une marge plus
    faible (>= plancher) rattrape une échelle plus fine, on la prend en gardant
    la plus grande marge possible. Sinon on garde la marge par défaut."""
    scale = scale_for(bb_w_m, bb_h_m, cap_margin, cfg)
    margin = cap_margin
    if cfg.get("marginAutoTune"):
        s_min = scale_for(bb_w_m, bb_h_m, cfg["marginMinM"], cfg)
        if s_min < scale:
            mm = max_margin_for(bb_w_m, bb_h_m, s_min, cap_margin, cfg)
            if mm >= cfg["marginMinM"]:
                margin, scale = mm, s_min
    return scale, margin


# =====================================================================
# Crop = contour de la pièce
# =====================================================================
def _bbox_area_of(loop):
    if loop is None:
        return -1
    mnx = mny = 1e18
    mxx = mxy = -1e18
    for c in loop:
        for p in c.Tessellate():
            mnx = min(mnx, p.X); mny = min(mny, p.Y)
            mxx = max(mxx, p.X); mxy = max(mxy, p.Y)
    return (mxx - mnx) * (mxy - mny)


def room_outer_loop(room):
    """Contour extérieur de la pièce (boucle de plus grande bbox), reconstruit
    en polyligne fermée depuis les points tessellés : les segments *Finish* ne
    sont PAS contigus bout-à-bout (`CurveLoop.Append` direct échoue). Dedup
    au-dessus de la tolérance de courbe courte."""
    doc = room.Document
    dedup = max(0.01, doc.Application.ShortCurveTolerance * 1.5)
    try:
        loops = room.GetBoundarySegments(SpatialElementBoundaryOptions())
    except Exception:
        return None
    if loops is None:
        return None
    best = None
    best_a = -1
    for lp in loops:
        pts = []
        for seg in lp:
            try:
                c = seg.GetCurve()
            except Exception:
                c = None
            if c is None:
                continue
            for p in c.Tessellate():
                if not pts or pts[-1].DistanceTo(p) > dedup:
                    pts.append(p)
        while len(pts) > 1 and pts[0].DistanceTo(pts[-1]) < dedup:
            pts.pop()
        if len(pts) < 3:
            continue
        cl = CurveLoop()
        n = len(pts)
        for i in range(n):
            a = pts[i]; b = pts[(i + 1) % n]
            if a.DistanceTo(b) <= dedup:
                continue
            try:
                cl.Append(Line.CreateBound(a, b))
            except Exception:
                pass
        if cl.NumberOfCurves() < 3 or cl.IsOpen():
            continue
        area = _bbox_area_of(cl)
        if area > best_a:
            best_a = area
            best = cl
    return best


def offset_out(loop, dist):
    """Offset du contour vers l'EXTÉRIEUR (celui dont la bbox grandit)."""
    if loop is None or dist <= 0:
        return None
    orig = _bbox_area_of(loop)
    a = b = None
    try:
        a = CurveLoop.CreateViaOffset(loop, dist, XYZ.BasisZ)
    except Exception:
        pass
    try:
        b = CurveLoop.CreateViaOffset(loop, -dist, XYZ.BasisZ)
    except Exception:
        pass
    aa = _bbox_area_of(a); bb = _bbox_area_of(b)
    if a is not None and aa >= orig and (b is None or aa >= bb):
        return a
    if b is not None and bb > orig:
        return b
    return a if a is not None else b


# =====================================================================
# Config de vue complète (from-scratch)
# =====================================================================
def _set_str_param(elem, name, value):
    p = elem.LookupParameter(name)
    if p is not None and not p.IsReadOnly and p.StorageType == StorageType.String:
        p.Set(value)
        return True
    return False


def apply_view_config(view, ctx):
    """Applique la config figée à une vue CRÉÉE de zéro : discipline, phase,
    filtre de phase, plage de vue, ET Visibilité-Graphismes (catégories +
    sous-catégories masquées + DWG importés). Aucune dépendance à une vue tierce.
    """
    doc = ctx["doc"]
    vc = ctx["cfg"].get("viewConfig", {})

    disc = vc.get("discipline")
    if disc:
        try:
            view.Discipline = {
                "Structural": ViewDiscipline.Structural,
                "Mechanical": ViewDiscipline.Mechanical,
                "Electrical": ViewDiscipline.Electrical,
                "Plumbing": ViewDiscipline.Plumbing,
                "Coordination": ViewDiscipline.Coordination,
            }.get(disc, ViewDiscipline.Architectural)
        except Exception:
            pass

    ph = vc.get("phase")
    if ph and ph in ctx["phases"]:
        try:
            view.get_Parameter(BuiltInParameter.VIEW_PHASE).Set(ctx["phases"][ph])
        except Exception:
            pass

    pf = vc.get("phaseFilter")
    if pf and pf in ctx["phase_filters"]:
        try:
            view.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER).Set(ctx["phase_filters"][pf])
        except Exception:
            pass

    vr = vc.get("viewRangeM")
    if vr and view.GenLevel is not None:
        try:
            rng = view.GetViewRange()
            lid = view.GenLevel.Id
            for plane, key in ((PlanViewPlane.TopClipPlane, "top"),
                               (PlanViewPlane.CutPlane, "cut"),
                               (PlanViewPlane.BottomClipPlane, "bottom"),
                               (PlanViewPlane.ViewDepthPlane, "depth")):
                if key in vr:
                    rng.SetLevelId(plane, lid)
                    rng.SetOffset(plane, vr[key] / FT)
            view.SetViewRange(rng)
        except Exception:
            pass

    # Visibilité / Graphismes : catégories et sous-catégories ("Parent > Sub")
    for entry in vc.get("hiddenCategories", []):
        target = None
        if " > " in entry:
            pn, sn = entry.split(" > ", 1)
            parent = ctx["cats"].get(pn)
            if parent is not None and parent.SubCategories is not None:
                for sc in parent.SubCategories:
                    if sc is not None and sc.Name == sn:
                        target = sc
                        break
        else:
            target = ctx["cats"].get(entry)
        if target is not None:
            try:
                if view.CanCategoryBeHidden(target.Id):
                    view.SetCategoryHidden(target.Id, True)
            except Exception:
                pass

    # DWG/DXF/DGN importés : la référence les masque PAR ÉLÉMENT (invisible au
    # diff catégorie) -> on masque toute la catégorie import pour un rendu propre.
    if vc.get("hideImportedCad"):
        for c in doc.Settings.Categories:
            if c is None:
                continue
            ln = c.Name.lower()
            if ln.endswith(".dwg") or ln.endswith(".dxf") or ln.endswith(".dgn"):
                try:
                    if view.CanCategoryBeHidden(c.Id):
                        view.SetCategoryHidden(c.Id, True)
                except Exception:
                    pass


_NUM_PREFIX_RX = re.compile(r"^\s*(\d+)")


def _view_number_prefix(view):
    """Préfixe numérique en tête du nom de vue, ex. '409 - Sales Area 2 - View 1'
    -> '409'. None si le nom ne commence pas par un nombre."""
    m = _NUM_PREFIX_RX.match(view.Name or "")
    return m.group(1) if m else None


def hide_foreign_elevation_marks(view, room, level, ctx):
    """FILTRE DÉFINITIF des marques/annotations de vues : on ne garde une marque
    d'élévation QUE si le **préfixe numérique de sa vue** est égal au `Number`
    de la pièce (ex. pièce 409 -> vues '409 - … View n'). Tout marqueur dont les
    vues ont un autre préfixe (pièces voisines) est masqué (marqueur + ses vues,
    catégorie *Vues*). Règle exacte, sans géométrie."""
    doc = ctx["doc"]
    room_num = room.Number or ""
    ids = List[ElementId]()
    for em in FilteredElementCollector(doc).OfClass(ElevationMarker):
        vids = []
        prefix = None
        for i in range(em.MaximumViewCount):
            vid = em.GetViewId(i)
            if vid is not None and vid != ElementId.InvalidElementId:
                vv = doc.GetElement(vid)
                if vv is not None:
                    vids.append(vid)
                    if prefix is None:
                        prefix = _view_number_prefix(vv)
        if prefix == room_num:
            continue                          # marqueur de la pièce -> garder
        if em.CanBeHidden(view):
            ids.Add(em.Id)
        for vid in vids:                      # + ses vues d'élévation (cat *Vues*)
            ve = doc.GetElement(vid)
            if ve is not None and ve.CanBeHidden(view):
                ids.Add(vid)
    if ids.Count > 0:
        view.HideElements(ids)
    return ids.Count


# =====================================================================
# Création vue + feuille + viewport
# =====================================================================
def _apply_crop(view, room, bb, mg_ft, cfg):
    """Crop : rectangle bbox+marge, puis forme = contour offset si
    `cropFollowsRoom` (fallback rectangle). Crop (ré)activé EN DERNIER
    (`SetCropShape` peut le désactiver). Retourne un libellé du type de crop."""
    crop_visible = bool(cfg.get("cropBoxVisible", False))
    lvl_elev = view.GenLevel.Elevation if view.GenLevel is not None else 0.0
    cb = BoundingBoxXYZ()
    cb.Min = XYZ(bb.Min.X - mg_ft, bb.Min.Y - mg_ft, lvl_elev - 3.3)
    cb.Max = XYZ(bb.Max.X + mg_ft, bb.Max.Y + mg_ft, lvl_elev + 13.0)
    view.CropBoxActive = True
    view.CropBoxVisible = crop_visible
    view.CropBox = cb

    kind = "rectangle (bbox)"
    if cfg.get("cropFollowsRoom"):
        off = offset_out(room_outer_loop(room), mg_ft)
        if off is not None:
            try:
                view.GetCropRegionShapeManager().SetCropShape(off)
                kind = "contour"
            except Exception:
                kind = "rectangle (contour KO)"
        else:
            kind = "rectangle (contour indispo)"

    view.CropBoxActive = True          # ré-assertion après SetCropShape
    view.CropBoxVisible = crop_visible
    ac = view.get_Parameter(BuiltInParameter.VIEWER_ANNOTATION_CROP_ACTIVE)
    if ac is not None and not ac.IsReadOnly:
        ac.Set(1)
    return kind


def create_sheet_and_view(room, level, num, local, scale, margin, ctx,
                          sheet_no, sheet_name, view_name):
    """Crée UNE feuille A3 + sa vue de plan + le viewport, pour un (pièce, niveau).
    Retourne (sheet, view)."""
    doc = ctx["doc"]; cfg = ctx["cfg"]
    bb = room.get_BoundingBox(None)
    mg_ft = margin / FT

    sheet = ViewSheet.Create(doc, ctx["tb_id"])
    try:
        sheet.SheetNumber = sheet_no
    except Exception:
        pass
    ctx["sheet_nums"].add(sheet.SheetNumber)
    sheet.Name = sheet_name
    _set_str_param(sheet, ".Category", cfg["category"])
    for k, v in cfg.get("titleBlockFields", {}).items():
        if not v:
            continue
        if v == "today":
            v = DateTime.Now.ToString("dd/MM/yy")
        _set_str_param(sheet, k, v)

    view = ViewPlan.Create(doc, ctx["vft"], level.Id)
    try:
        view.ViewTemplateId = ElementId.InvalidElementId
    except Exception:
        pass
    apply_view_config(view, ctx)

    vn = view_name
    base = vn
    k = 1
    while vn in ctx["view_names"]:
        k += 1
        vn = "{0} ({1})".format(base, k)
    view.Name = vn
    ctx["view_names"].add(vn)

    view.Scale = scale
    try:
        view.DetailLevel = {"Fine": ViewDetailLevel.Fine,
                            "Coarse": ViewDetailLevel.Coarse}.get(
                                cfg.get("detailLevel"), ViewDetailLevel.Medium)
    except Exception:
        pass
    for k2, v2 in cfg.get("viewFields", {}).items():
        if v2:
            _set_str_param(view, k2, v2)

    crop_kind = _apply_crop(view, room, bb, mg_ft, cfg)

    if cfg.get("hideForeignElevationMarks"):
        hide_foreign_elevation_marks(view, room, level, ctx)

    cx = cfg["viewportCenterMm"]["x"] / MM
    cy = cfg["viewportCenterMm"]["y"] / MM
    if Viewport.CanAddViewToSheet(doc, sheet.Id, view.Id):
        Viewport.Create(doc, sheet.Id, view.Id, XYZ(cx, cy, 0))

    ctx["log"]("  [{0}] '{1}'  1:{2}  marge {3}  crop={4}".format(
        sheet.SheetNumber, sheet_name, scale, margin, crop_kind))
    return sheet, view


# =====================================================================
# Orchestration de la sous-fonction
# =====================================================================
def target_rooms(ctx):
    """Pièces cibles : placées (Area>0, Location) dont le Number matche
    `numberRegex`, triées par numéro."""
    doc = ctx["doc"]
    rx = re.compile(ctx["cfg"]["numberRegex"])
    rooms = []
    for e in FilteredElementCollector(doc).OfCategory(
            BuiltInCategory.OST_Rooms).WhereElementIsNotElementType():
        if not isinstance(e, Room):
            continue
        num = e.Number or ""
        if not rx.match(num):
            continue
        if not (e.Location is not None and e.Area > 0):
            continue
        rooms.append(e)
    rooms.sort(key=lambda r: r.Number)
    return rooms


def run(doc, cfg=None, log=None):
    """Sous-fonction planbook : génère les feuilles Enlarged Plan pour toutes
    les pièces cibles. **Suppose une Transaction ouverte** (gérée par planbook).
    Retourne le nombre de feuilles créées."""
    cfg = _merge(DEFAULT_CONFIG, cfg)
    log = log or (lambda m: None)
    ctx = build_context(doc, cfg, log)

    if ctx["tb_id"] is None:
        log("!! cartouche introuvable: " + cfg["titleBlockFamily"])
        return 0
    if ctx["vft"] is None:
        log("!! VFT FloorPlan introuvable: " + cfg["floorPlanViewFamilyType"])
        return 0
    if ctx["tb"] is not None and not ctx["tb"].IsActive:
        ctx["tb"].Activate()

    made = 0
    for room in target_rooms(ctx):
        num = room.Number
        local = cfg.get("localByNumber", {}).get(num) or room.Name
        cap = cfg.get("marginByNumber", {}).get(num, cfg["marginM"])

        bb = room.get_BoundingBox(None)
        bw = (bb.Max.X - bb.Min.X) * FT
        bh = (bb.Max.Y - bb.Min.Y) * FT
        scale, margin = resolve_scale_and_margin(bw, bh, cap, cfg)

        lvl_names = list(cfg.get("levelByNumber", {}).get(num, []))
        if not lvl_names and room.Level is not None:
            lvl_names = [room.Level.Name]
        multi = len(lvl_names) > 1

        if num in ctx["sheet_nums"] and cfg.get("onExisting") == "skip":
            log("  feuille {0} existe -> skip".format(num))
            continue

        for ln in lvl_names:
            level = ctx["levels"].get(ln)
            if level is None:
                log("  niveau introuvable: " + str(ln))
                continue

            sheet_no = num
            if sheet_no in ctx["sheet_nums"]:
                sheet_no = num + cfg["duplicateSuffix"]
            if multi:
                sheet_no = sheet_no + " " + ln
            base = sheet_no
            d = 2
            while sheet_no in ctx["sheet_nums"]:
                sheet_no = "{0}-{1}".format(base, d)
                d += 1

            sname = cfg["sheetNameTemplate"].format(num=num, local=local)
            vname = cfg["viewNameTemplate"].format(num=num, local=local)
            if multi:
                sname = sname + " " + ln
                vname = vname + " " + ln

            create_sheet_and_view(room, level, num, local, scale, margin,
                                  ctx, sheet_no, sname, vname)
            made += 1
    return made
