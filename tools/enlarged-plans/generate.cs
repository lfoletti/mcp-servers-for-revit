// =====================================================================
// Enlarged Plans generator — feuilles 401-411 depuis les rooms.
//
// Ce fichier est le CORPS d'une methode : il est fourni tel quel comme
// `code` a l'outil MCP revit_execute (pas de using/class/namespace ici,
// ils sont injectes par l'hote). Variables en scope : uiapp, uidoc,
// document, app, parameters (object[]), Print(object).
//
// Appel :
//   revit_execute(code = <ce fichier>,
//                 parameters = [ <chemin specs.json>, <mode>, <filtre?> ],
//                 transactionMode = "none" pour dry-run, "auto" pour apply)
//   mode   : "dry-run" (lecture seule, rapport) | "apply" (cree)
//   filtre : numero de piece unique (ex "409") ou "" pour toutes.
//
// La config vit dans specs.json — ne rien coder en dur ici.
// =====================================================================

var doc = document;
const double FT = 0.3048, MM = 304.8;

string specsPath = (parameters != null && parameters.Length > 0) ? parameters[0] as string : null;
string mode      = (parameters != null && parameters.Length > 1) ? (parameters[1] as string ?? "dry-run") : "dry-run";
string filter    = (parameters != null && parameters.Length > 2) ? (parameters[2] as string ?? "") : "";
string onExistingOv = (parameters != null && parameters.Length > 3) ? (parameters[3] as string) : null;
bool apply = string.Equals(mode, "apply", System.StringComparison.OrdinalIgnoreCase);

if (string.IsNullOrEmpty(specsPath)) { Print("ERREUR: parameters[0] = chemin de specs.json manquant"); return "err"; }
if (!System.IO.File.Exists(specsPath)) { Print("ERREUR: specs introuvable: " + specsPath); return "err"; }

var S = Newtonsoft.Json.Linq.JObject.Parse(System.IO.File.ReadAllText(specsPath));
string GetS(string k, string d) { var v = S[k]; return v != null ? (string)v : d; }
double GetD(string k, double d) { var v = S[k]; return v != null ? (double)v : d; }

string tbFamily = GetS("titleBlockFamily", null);
string vftName  = GetS("floorPlanViewFamilyType", null);
string category = GetS("category", null);
var numRe = new System.Text.RegularExpressions.Regex(GetS("numberRegex", "^40[0-9]$"));
double marginM = GetD("marginM", 0.5);
double marginMinM = GetD("marginMinM", 0.2);
bool autoTune = S["marginAutoTune"] != null ? (bool)S["marginAutoTune"] : true;
var ladder = ((Newtonsoft.Json.Linq.JArray)S["scaleLadder"]).Select(x => (int)x).ToList();
double drawW = (double)S["drawableMm"]["w"], drawH = (double)S["drawableMm"]["h"];
double annoW = (double)S["annotationAllowanceMm"]["w"], annoH = (double)S["annotationAllowanceMm"]["h"];
double cX = (double)S["viewportCenterMm"]["x"], cY = (double)S["viewportCenterMm"]["y"];
double multiOff = GetD("multiViewportOffsetMm", 190);
string detailStr = GetS("detailLevel", "Fine");
string onExisting = !string.IsNullOrEmpty(onExistingOv) ? onExistingOv : GetS("onExisting", "skip");
string duplicateSuffix = GetS("duplicateSuffix", "-D");
string viewTpl  = GetS("viewNameTemplate", "{num} - {local} - Enlarged Plan");
string sheetTpl = GetS("sheetNameTemplate", "{local} - Enlarged Plan");
var fields  = (Newtonsoft.Json.Linq.JObject)S["titleBlockFields"] ?? new Newtonsoft.Json.Linq.JObject();
var viewFields = (Newtonsoft.Json.Linq.JObject)S["viewFields"] ?? new Newtonsoft.Json.Linq.JObject();
var localBy = (Newtonsoft.Json.Linq.JObject)S["localByNumber"] ?? new Newtonsoft.Json.Linq.JObject();
var marginBy= (Newtonsoft.Json.Linq.JObject)S["marginByNumber"] ?? new Newtonsoft.Json.Linq.JObject();
var levelBy = (Newtonsoft.Json.Linq.JObject)S["levelByNumber"] ?? new Newtonsoft.Json.Linq.JObject();
bool cropFollowsRoom = S["cropFollowsRoom"] != null ? (bool)S["cropFollowsRoom"] : false;
var viewCfg = (Newtonsoft.Json.Linq.JObject)S["viewConfig"] ?? new Newtonsoft.Json.Linq.JObject();

ViewDetailLevel detail = detailStr == "Fine" ? ViewDetailLevel.Fine
                       : detailStr == "Coarse" ? ViewDetailLevel.Coarse : ViewDetailLevel.Medium;

// --- resolution des types ---
ElementId tbId = null; FamilySymbol tbSym = null;
foreach (var e in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks).WhereElementIsElementType().Cast<FamilySymbol>())
    if (e.FamilyName == tbFamily) { tbId = e.Id; tbSym = e; break; }
ElementId vftId = null;
foreach (var e in new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>())
    if (e.ViewFamily == ViewFamily.FloorPlan && e.Name == vftName) { vftId = e.Id; break; }

var levelByName = new System.Collections.Generic.Dictionary<string, Level>();
foreach (var e in new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>()) levelByName[e.Name] = e;
var sheetNums = new System.Collections.Generic.HashSet<string>();
foreach (var e in new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()) sheetNums.Add(e.SheetNumber);
var viewNames = new System.Collections.Generic.HashSet<string>();
foreach (var e in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
    if (!e.IsTemplate) viewNames.Add(e.Name);
var phaseByName = new System.Collections.Generic.Dictionary<string, ElementId>();
foreach (Phase ph in doc.Phases) phaseByName[ph.Name] = ph.Id;
var phaseFilterByName = new System.Collections.Generic.Dictionary<string, ElementId>();
foreach (var e in new FilteredElementCollector(doc).OfClass(typeof(PhaseFilter)).Cast<PhaseFilter>()) phaseFilterByName[e.Name] = e.Id;

// --- rooms cibles ---
var rooms = new System.Collections.Generic.List<Autodesk.Revit.DB.Architecture.Room>();
foreach (var e in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).WhereElementIsNotElementType())
{
    var r = e as Autodesk.Revit.DB.Architecture.Room; if (r == null) continue;
    var n = r.Number ?? ""; if (!numRe.IsMatch(n)) continue;
    if (!(r.Location != null && r.Area > 0)) continue;
    if (filter != "" && n != filter) continue;
    rooms.Add(r);
}
rooms.Sort((a, b) => string.CompareOrdinal(a.Number, b.Number));

Print("=== Enlarged Plans — " + (apply ? "APPLY" : "DRY-RUN") + " — " + rooms.Count + " piece(s) — drawable " + drawW + "x" + drawH + "mm ===");
if (tbId == null)  Print("!! cartouche introuvable: " + tbFamily);
if (vftId == null) Print("!! VFT FloorPlan introuvable: " + vftName);

// échelle : plus fine du ladder qui rentre (crop papier + annotation <= aire dessinable)
// échelle la plus fine du ladder qui tient pour une marge donnée (tout en mètres)
int ScaleFor(double bbWm, double bbHm, double margin)
{
    double cw = bbWm + 2 * margin, ch = bbHm + 2 * margin;
    foreach (var s in ladder)
        if (cw * 1000.0 / s + annoW <= drawW && ch * 1000.0 / s + annoH <= drawH) return s;
    return ladder[ladder.Count - 1]; // le plus grossier, meme si depassement
}
// plus grande marge (<= cap) qui tient encore à l'échelle s ; arrondie au cm inférieur
double MaxMarginFor(double bbWm, double bbHm, int s, double cap)
{
    double wLim = ((drawW - annoW) * s / 1000.0 - bbWm) / 2.0;
    double hLim = ((drawH - annoH) * s / 1000.0 - bbHm) / 2.0;
    double mm = System.Math.Min(wLim, hLim);
    if (mm > cap) mm = cap;
    return System.Math.Floor(mm * 100.0) / 100.0;
}

// aire de la bounding-box d'un CurveLoop (tessellation, gère arcs)
double BBoxAreaOf(CurveLoop loop)
{
    if (loop == null) return -1;
    double minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
    foreach (Curve c in loop)
        foreach (var p in c.Tessellate())
        { if (p.X < minx) minx = p.X; if (p.Y < miny) miny = p.Y; if (p.X > maxx) maxx = p.X; if (p.Y > maxy) maxy = p.Y; }
    return (maxx - minx) * (maxy - miny);
}
// contour extérieur de la pièce (boucle de plus grande bbox). Les segments
// Finish ne sont pas contigus bout-à-bout -> on reconstruit une polyligne
// fermée à partir des points tessellés (dédupliqués au-dessus de la
// tolérance de courbe courte), robuste aux arcs et micro-gaps.
CurveLoop RoomOuterLoop(Autodesk.Revit.DB.Architecture.Room room)
{
    double dedup = System.Math.Max(0.01, doc.Application.ShortCurveTolerance * 1.5);
    System.Collections.Generic.IList<System.Collections.Generic.IList<BoundarySegment>> loops;
    try { loops = room.GetBoundarySegments(new SpatialElementBoundaryOptions()); } catch { return null; }
    if (loops == null) return null;
    CurveLoop best = null; double bestA = -1;
    foreach (var lp in loops)
    {
        var pts = new System.Collections.Generic.List<XYZ>();
        foreach (var seg in lp)
        {
            Curve c = null; try { c = seg.GetCurve(); } catch { }
            if (c == null) continue;
            foreach (var p in c.Tessellate())
                if (pts.Count == 0 || pts[pts.Count - 1].DistanceTo(p) > dedup) pts.Add(p);
        }
        while (pts.Count > 1 && pts[0].DistanceTo(pts[pts.Count - 1]) < dedup) pts.RemoveAt(pts.Count - 1);
        if (pts.Count < 3) continue;
        var cl = new CurveLoop();
        for (int i = 0; i < pts.Count; i++)
        {
            var a = pts[i]; var b = pts[(i + 1) % pts.Count];
            if (a.DistanceTo(b) <= dedup) continue;
            try { cl.Append(Line.CreateBound(a, b)); } catch { }
        }
        if (cl.NumberOfCurves() < 3 || cl.IsOpen()) continue;
        double area = BBoxAreaOf(cl);
        if (area > bestA) { bestA = area; best = cl; }
    }
    return best;
}
// offset vers l'extérieur (celui dont la bbox grandit)
CurveLoop OffsetOut(CurveLoop loop, double dist)
{
    if (loop == null || dist <= 0) return null;
    double orig = BBoxAreaOf(loop);
    CurveLoop a = null, b = null;
    try { a = CurveLoop.CreateViaOffset(loop, dist, XYZ.BasisZ); } catch { }
    try { b = CurveLoop.CreateViaOffset(loop, -dist, XYZ.BasisZ); } catch { }
    double aa = BBoxAreaOf(a), bbA = BBoxAreaOf(b);
    if (a != null && aa >= orig && (b == null || aa >= bbA)) return a;
    if (b != null && bbA > orig) return b;
    return a ?? b;
}

// applique la config figée (discipline / phase / filtre / plage) à une vue
// CRÉÉE de zéro — pas de dépendance à une vue prototype existante.
void ApplyViewConfig(ViewPlan vp)
{
    var disc = (string)viewCfg["discipline"];
    if (!string.IsNullOrEmpty(disc))
        try { vp.Discipline = disc == "Structural" ? ViewDiscipline.Structural
            : disc == "Mechanical" ? ViewDiscipline.Mechanical : disc == "Electrical" ? ViewDiscipline.Electrical
            : disc == "Plumbing" ? ViewDiscipline.Plumbing : disc == "Coordination" ? ViewDiscipline.Coordination
            : ViewDiscipline.Architectural; } catch { }
    var phName = (string)viewCfg["phase"];
    if (!string.IsNullOrEmpty(phName) && phaseByName.ContainsKey(phName))
        try { vp.get_Parameter(BuiltInParameter.VIEW_PHASE).Set(phaseByName[phName]); } catch { }
    var pfName = (string)viewCfg["phaseFilter"];
    if (!string.IsNullOrEmpty(pfName) && phaseFilterByName.ContainsKey(pfName))
        try { vp.get_Parameter(BuiltInParameter.VIEW_PHASE_FILTER).Set(phaseFilterByName[pfName]); } catch { }
    var vro = viewCfg["viewRangeM"];
    if (vro != null && vp.GenLevel != null)
        try {
            var vr = vp.GetViewRange(); var lid = vp.GenLevel.Id;
            System.Action<PlanViewPlane, string> setp = (pl, key) => { if (vro[key] != null) { vr.SetLevelId(pl, lid); vr.SetOffset(pl, (double)vro[key] / FT); } };
            setp(PlanViewPlane.TopClipPlane, "top"); setp(PlanViewPlane.CutPlane, "cut");
            setp(PlanViewPlane.BottomClipPlane, "bottom"); setp(PlanViewPlane.ViewDepthPlane, "depth");
            vp.SetViewRange(vr);
        } catch { }
}

if (apply && tbSym != null && !tbSym.IsActive) tbSym.Activate();

int made = 0;
foreach (var room in rooms)
{
    string num = room.Number;
    string local = localBy[num] != null ? (string)localBy[num] : room.Name;
    double capMargin = marginBy[num] != null ? (double)marginBy[num] : marginM;

    var bb = room.get_BoundingBox(null);
    if (bb == null) { Print("[" + num + "] SKIP: pas de bbox"); continue; }
    double bbWm = (bb.Max.X - bb.Min.X) * FT, bbHm = (bb.Max.Y - bb.Min.Y) * FT;

    // échelle à la marge par défaut ; si une marge plus faible (>= plancher)
    // rattrape une échelle plus fine, on la prend en gardant la plus grande
    // marge possible. Sinon on garde la marge par défaut (cap).
    int scale = ScaleFor(bbWm, bbHm, capMargin);
    double mg = capMargin; bool tuned = false;
    if (autoTune)
    {
        int scaleMin = ScaleFor(bbWm, bbHm, marginMinM);
        if (scaleMin < scale)
        {
            double mm = MaxMarginFor(bbWm, bbHm, scaleMin, capMargin);
            if (mm >= marginMinM) { mg = mm; scale = scaleMin; tuned = true; }
        }
    }
    double mgFt = mg / FT;
    double cwm = bbWm + 2 * mg, chm = bbHm + 2 * mg;
    double pw = cwm * 1000.0 / scale, ph = chm * 1000.0 / scale;
    bool overflow = (pw + annoW > drawW) || (ph + annoH > drawH);

    string vname = viewTpl.Replace("{num}", num).Replace("{local}", local);
    string sname = sheetTpl.Replace("{num}", num).Replace("{local}", local);

    Print("[" + num + "] " + local
        + "  bbox " + System.Math.Round(bbWm, 2) + "x" + System.Math.Round(bbHm, 2) + "m"
        + "  marge " + mg + (tuned ? "(auto)" : "")
        + "  crop " + System.Math.Round(cwm, 2) + "x" + System.Math.Round(chm, 2) + "m"
        + "  -> 1:" + scale + "  papier " + System.Math.Round(pw) + "x" + System.Math.Round(ph) + "mm"
        + (overflow ? "  /!\\ DEPASSEMENT" : ""));

    bool exists = sheetNums.Contains(num);
    if (exists && onExisting == "skip") { Print("    feuille " + num + " existe -> skip"); continue; }
    if (!apply) continue;
    if (tbId == null || vftId == null) { Print("    SKIP apply: cartouche/VFT manquant"); continue; }

    string sheetNo = num;
    if (exists)
    {
        if (onExisting == "duplicate")
        {
            sheetNo = num + duplicateSuffix; int d = 1;
            while (sheetNums.Contains(sheetNo)) sheetNo = num + duplicateSuffix + (++d);
        }
        else { Print("    feuille " + num + " existe -> skip (onExisting=" + onExisting + ")"); continue; }
    }

    // niveaux (override specs sinon niveau de la piece)
    var lvlNames = new System.Collections.Generic.List<string>();
    if (levelBy[num] != null) foreach (var t in (Newtonsoft.Json.Linq.JArray)levelBy[num]) lvlNames.Add((string)t);
    if (lvlNames.Count == 0) { var lv = room.Level; if (lv != null) lvlNames.Add(lv.Name); }

    var sheet = ViewSheet.Create(doc, tbId);
    try { sheet.SheetNumber = sheetNo; } catch { Print("    n° " + sheetNo + " refuse, garde " + sheet.SheetNumber); }
    sheetNums.Add(sheet.SheetNumber);
    sheet.Name = sname;

    var pc = sheet.LookupParameter(".Category");
    if (pc != null && !pc.IsReadOnly && pc.StorageType == StorageType.String) pc.Set(category);
    foreach (var f in fields)
    {
        var val = (string)f.Value; if (string.IsNullOrEmpty(val)) continue;
        if (val == "today") val = System.DateTime.Now.ToString("dd/MM/yy");
        var p = sheet.LookupParameter(f.Key);
        if (p != null && !p.IsReadOnly && p.StorageType == StorageType.String) p.Set(val);
    }

    int vi = 0;
    foreach (var ln in lvlNames)
    {
        if (ln == null || !levelByName.ContainsKey(ln)) { Print("    niveau introuvable: " + ln); continue; }
        var lvl = levelByName[ln];

        // Vue CRÉÉE de zéro puis config figée appliquée (discipline / phase /
        // filtre / plage) — aucune dépendance à une vue existante.
        ViewPlan vplan = ViewPlan.Create(doc, vftId, lvl.Id);
        if (vplan == null) { Print("    creation vue KO (niveau " + ln + ")"); continue; }
        try { vplan.ViewTemplateId = ElementId.InvalidElementId; } catch { }
        ApplyViewConfig(vplan);
        string srcCfg = "create+viewConfig";

        string tn = lvlNames.Count > 1 ? vname + " " + ln : vname;
        string bn = tn; int k = 1; while (viewNames.Contains(tn)) tn = bn + " (" + (++k) + ")";
        vplan.Name = tn; viewNames.Add(tn);

        vplan.Scale = scale;
        try { vplan.DetailLevel = detail; } catch { }

        // variables métier de la vue (ROLEX-ETAPES, Utilisations de la vue, ...)
        foreach (var f in viewFields)
        {
            var vv = (string)f.Value; if (string.IsNullOrEmpty(vv)) continue;
            var vpar = vplan.LookupParameter(f.Key);
            if (vpar != null && !vpar.IsReadOnly && vpar.StorageType == StorageType.String) vpar.Set(vv);
        }

        var cb = new BoundingBoxXYZ();
        cb.Min = new XYZ(bb.Min.X - mgFt, bb.Min.Y - mgFt, lvl.Elevation - 3.3);
        cb.Max = new XYZ(bb.Max.X + mgFt, bb.Max.Y + mgFt, lvl.Elevation + 13.0);
        vplan.CropBoxActive = true; vplan.CropBoxVisible = true; vplan.CropBox = cb;
        var ac = vplan.get_Parameter(BuiltInParameter.VIEWER_ANNOTATION_CROP_ACTIVE);
        if (ac != null && !ac.IsReadOnly) ac.Set(1);

        // crop qui suit le contour de la pièce (offset de la marge), sinon rectangle
        string cropKind = "rectangle (bbox)";
        if (cropFollowsRoom)
        {
            var off = OffsetOut(RoomOuterLoop(room), mgFt);
            if (off != null)
            {
                try { vplan.GetCropRegionShapeManager().SetCropShape(off); cropKind = "contour room +" + mg + "m"; }
                catch (System.Exception ex) { cropKind = "rectangle (contour KO: " + ex.Message + ")"; }
            }
            else cropKind = "rectangle (contour indispo)";
        }

        double px = (cX + vi * multiOff) / MM, py = cY / MM;
        if (Viewport.CanAddViewToSheet(doc, sheet.Id, vplan.Id))
            Viewport.Create(doc, sheet.Id, vplan.Id, new XYZ(px, py, 0));
        else Print("    vue non placable: " + tn);
        Print("    vue '" + tn + "'  1:" + scale + "  config=" + srcCfg + "  crop=" + cropKind);
        vi++;
    }
    made++;
    Print("    -> feuille [" + sheet.SheetNumber + "] '" + sheet.Name + "' + " + vi + " vue(s), .Category=" + category);
}

Print("=== " + (apply ? ("feuilles creees: " + made) : "DRY-RUN — aucune ecriture") + " ===");
return apply ? ("created:" + made) : "dry-run";
