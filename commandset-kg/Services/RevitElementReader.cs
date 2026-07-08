using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using RevitMCPKgCommandSet.Core;

namespace RevitMCPKgCommandSet.Services
{
    public sealed class RevitElementReader : IElementReader
    {
        private const double FeetToMetres = 0.3048;
        private const double SqFeetToSqMetres = FeetToMetres * FeetToMetres;
        // Revit stores lengths in feet internally; * 0.3048 yields the classic
        // double-precision tail (2.7499999999999996, 5.99999999999998, ...).
        // Round at the source so every downstream consumer — projection,
        // drift detect/resolve, kg_v2_query dump — sees clean values. 6
        // decimals in metres = 1 µm precision, well below BIM tolerance.
        private const int MetresRoundDecimals = 6;
        private static double RoundM(double m) => Math.Round(m, MetresRoundDecimals);

        private readonly Document _doc;

        public RevitElementReader(Document doc)
        {
            _doc = doc ?? throw new ArgumentNullException(nameof(doc));
        }

        public string ResolveNodeType(long elementId)
        {
            var el = GetElement(elementId);
            return ResolveTypeOf(el);
        }

        public Dictionary<string, object> ReadAttrs(long elementId)
        {
            var el = GetElement(elementId);
            if (el == null) return null;
            switch (el)
            {
                case Level lvl: return ReadLevelAttrs(lvl);
                case WallType wt: return ReadWallTypeAttrs(wt);
                case FloorType ft: return ReadFloorTypeAttrs(ft);
                case Wall w: return ReadWallAttrs(w);
                case Floor fl: return ReadFloorAttrs(fl);
                case Room room: return ReadRoomAttrs(room);
                case Material mat: return ReadMaterialAttrs(mat);
                case FamilyInstance fi:
                    if (IsOpening(fi)) return ReadOpeningAttrs(fi);
                    if (IsFacadeElement(fi)) return ReadFacadeElementAttrs(fi);
                    return null;
                case FamilySymbol fs: return IsModelFamilySymbol(fs) ? ReadFamilyTypeAttrs(fs) : null;
                default: return null;
            }
        }

        public IEnumerable<long> EnumerateAllElementIds()
        {
            // Mirrors KgV2DocumentWatcher.BootstrapDocument's scan classes
            // (Level, WallType, FamilySymbol-of-openings, Wall,
            // FamilyInstance-of-openings, Room) so drift detection covers
            // exactly the node-type surface the projection knows about.
            var ids = new List<long>();

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(Level))
                .WhereElementIsNotElementType()
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(WallType))
                .WhereElementIsElementType()
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .Where(IsModelFamilySymbol)
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(Wall))
                .WhereElementIsNotElementType()
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(FamilyInstance))
                .Cast<FamilyInstance>()
                .Where(IsOpening)
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(FamilyInstance))
                .Cast<FamilyInstance>()
                .Where(IsFacadeElement)
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(FloorType))
                .WhereElementIsElementType()
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfClass(typeof(Floor))
                .WhereElementIsNotElementType()
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            ids.AddRange(new FilteredElementCollector(_doc)
                .OfCategory(BuiltInCategory.OST_Rooms)
                .WhereElementIsNotElementType()
                .Select(e => SafeIdValue(e.Id))
                .Where(v => v > 0));

            // Only materials referenced by a projected type's compound structure
            // (WallType + FloorType) — mirrors what ScanMaterials projects, so
            // drift stays exact (no orphan palette materials counted as missing).
            ids.AddRange(ReferencedMaterialIds());

            return ids;
        }

        // Distinct Material ElementIds referenced by any projected type's
        // compound structure (WallType + FloorType). The single source of truth
        // for both drift coverage (EnumerateAllElementIds) and bootstrap
        // projection (ScanMaterials), so no orphan palette material is counted.
        public HashSet<long> ReferencedMaterialIds()
        {
            var seen = new HashSet<long>();
            foreach (var hoa in new FilteredElementCollector(_doc)
                         .OfClass(typeof(WallType)).Cast<HostObjAttributes>())
                foreach (var mid in CompoundStructureMaterialIds(hoa))
                    seen.Add(mid);
            foreach (var hoa in new FilteredElementCollector(_doc)
                         .OfClass(typeof(FloorType)).Cast<HostObjAttributes>())
                foreach (var mid in CompoundStructureMaterialIds(hoa))
                    seen.Add(mid);
            foreach (var fs in new FilteredElementCollector(_doc)
                         .OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
            {
                if (!IsModelFamilySymbol(fs)) continue;
                foreach (var mid in FamilySymbolMaterialIds(fs))
                    seen.Add(mid);
            }
            return seen;
        }

        // Distinct layer materials of any compound-structure host type
        // (WallType, FloorType — both derive from HostObjAttributes).
        private IEnumerable<long> CompoundStructureMaterialIds(HostObjAttributes hoa)
        {
            CompoundStructure cs = null;
            try { cs = hoa.GetCompoundStructure(); } catch { }
            if (cs == null) yield break;

            var seen = new HashSet<long>();
            foreach (var layer in cs.GetLayers())
            {
                var mid = SafeIdValue(layer.MaterialId);
                if (mid > 0 && seen.Add(mid)) yield return mid;
            }
        }

        public IEnumerable<EdgeSpec> ReadEdges(long elementId)
        {
            var el = GetElement(elementId);
            if (el == null) yield break;

            switch (el)
            {
                case Wall w:
                {
                    var lvlId = SafeIdValue(w.LevelId);
                    if (lvlId > 0) yield return new EdgeSpec(lvlId, EdgeTypes.AtLevel);
                    var typeId = SafeIdValue(w.GetTypeId());
                    if (typeId > 0) yield return new EdgeSpec(typeId, EdgeTypes.IsType);
                    break;
                }
                case WallType wt:
                {
                    // One has_material edge per distinct layer material — the
                    // materials belong to the type, so every Wall reaches them
                    // through its is_type edge.
                    foreach (var matId in CompoundStructureMaterialIds(wt))
                        yield return new EdgeSpec(matId, EdgeTypes.HasMaterial);
                    break;
                }
                case FloorType ft:
                {
                    foreach (var matId in CompoundStructureMaterialIds(ft))
                        yield return new EdgeSpec(matId, EdgeTypes.HasMaterial);
                    break;
                }
                case Floor fl:
                {
                    var lvlId = SafeIdValue(fl.LevelId);
                    if (lvlId > 0) yield return new EdgeSpec(lvlId, EdgeTypes.AtLevel);
                    var typeId = SafeIdValue(fl.GetTypeId());
                    if (typeId > 0) yield return new EdgeSpec(typeId, EdgeTypes.IsType);
                    break;
                }
                case FamilySymbol fs when IsModelFamilySymbol(fs):
                {
                    // Loadable families have no compound structure — their
                    // materials come from Material-valued type parameters.
                    foreach (var matId in FamilySymbolMaterialIds(fs))
                        yield return new EdgeSpec(matId, EdgeTypes.HasMaterial);
                    break;
                }
                case FamilyInstance fi when IsOpening(fi):
                {
                    var symId = SafeIdValue(fi.GetTypeId());
                    if (symId > 0) yield return new EdgeSpec(symId, EdgeTypes.IsType);

                    var host = fi.Host;
                    if (host is Wall wallHost)
                    {
                        var wallId = SafeIdValue(wallHost.Id);
                        if (wallId > 0)
                            yield return new EdgeSpec(wallId, EdgeTypes.Hosts, EdgeDirection.Incoming);
                    }

                    var lvlId = SafeIdValue(fi.LevelId);
                    if (lvlId > 0) yield return new EdgeSpec(lvlId, EdgeTypes.AtLevel);
                    break;
                }
                case FamilyInstance fi when IsFacadeElement(fi):
                {
                    var lvlId = SafeIdValue(fi.LevelId);
                    if (lvlId > 0) yield return new EdgeSpec(lvlId, EdgeTypes.AtLevel);

                    var symId = SafeIdValue(fi.GetTypeId());
                    if (symId > 0) yield return new EdgeSpec(symId, EdgeTypes.IsType);

                    // In-place façade families are usually unhosted, but a
                    // loadable one may sit on a wall — mirror the opening
                    // host edge when present.
                    if (fi.Host is Wall wallHost)
                    {
                        var wallId = SafeIdValue(wallHost.Id);
                        if (wallId > 0)
                            yield return new EdgeSpec(wallId, EdgeTypes.Hosts, EdgeDirection.Incoming);
                    }
                    break;
                }
                case Room room:
                {
                    var lvlId = SafeIdValue(room.LevelId);
                    if (lvlId > 0) yield return new EdgeSpec(lvlId, EdgeTypes.AtLevel);
                    foreach (var wallId in ReadBoundaryWallIds(room))
                        yield return new EdgeSpec(wallId, EdgeTypes.BoundedBy);
                    break;
                }
            }
        }

        // ---- type resolution ----

        private static string ResolveTypeOf(Element el)
        {
            switch (el)
            {
                case null: return null;
                case Level _: return "Level";
                case WallType _: return "WallType";
                case FloorType _: return "FloorType";
                case Wall _: return "Wall";
                case Floor _: return "Floor";
                case Room _: return "Room";
                case Material _: return "Material";
                case FamilyInstance fi:
                    if (IsCategory(fi, BuiltInCategory.OST_Windows)) return "Window";
                    if (IsCategory(fi, BuiltInCategory.OST_Doors)) return "Door";
                    if (IsCategory(fi, BuiltInCategory.OST_Walls)) return "FacadeElement";
                    return null;
                case FamilySymbol fs:
                    return IsModelFamilySymbol(fs) ? "FamilyType" : null;
                default:
                    return null;
            }
        }

        private static bool IsOpening(FamilyInstance fi) =>
            IsCategory(fi, BuiltInCategory.OST_Windows) || IsCategory(fi, BuiltInCategory.OST_Doors);

        private static bool IsOpeningSymbol(FamilySymbol fs) =>
            IsCategory(fs, BuiltInCategory.OST_Windows) || IsCategory(fs, BuiltInCategory.OST_Doors);

        // A family instance carrying the Murs (OST_Walls) category but not of
        // class Wall — façade decoration modelled as in-place/loadable
        // families. Openings live in their own categories, so there is no
        // overlap with IsOpening.
        private static bool IsFacadeElement(FamilyInstance fi) =>
            IsCategory(fi, BuiltInCategory.OST_Walls);

        // A loadable-family type worth projecting as a FamilyType node: any
        // model-category symbol (doors, windows, furniture, lighting, casework,
        // generic models, façade families…). Excludes annotation/view symbols
        // (tags, title blocks) which carry no materials.
        private static bool IsModelFamilySymbol(FamilySymbol fs)
        {
            var cat = fs?.Category;
            return cat != null && cat.CategoryType == CategoryType.Model;
        }

        // Distinct materials referenced by a family type's Material-valued type
        // parameters (e.g. "Frame Material", "Glass"). Geometry-baked materials
        // and instance-level overrides are out of scope.
        private IEnumerable<long> FamilySymbolMaterialIds(FamilySymbol fs)
        {
            var seen = new HashSet<long>();
            foreach (Parameter p in fs.Parameters)
            {
                if (p == null || p.StorageType != StorageType.ElementId) continue;
                if (!IsMaterialParam(p)) continue;
                var mid = SafeIdValue(p.AsElementId());
                if (mid > 0 && seen.Add(mid)) yield return mid;
            }
        }

        private static bool IsMaterialParam(Parameter p)
        {
            try { return p.Definition != null && p.Definition.GetDataType() == SpecTypeId.Reference.Material; }
            catch { return false; }
        }

        private static bool IsCategory(Element el, BuiltInCategory bic)
        {
            var cat = el?.Category;
            if (cat == null) return false;
            return SafeIdValue(cat.Id) == (long)bic;
        }

        // ---- attribute readers ----

        private static Dictionary<string, object> ReadLevelAttrs(Level lvl) =>
            new Dictionary<string, object>
            {
                ["name"] = lvl.Name ?? string.Empty,
                ["elevation"] = RoundM(lvl.Elevation * FeetToMetres),
            };

        private static Dictionary<string, object> ReadWallTypeAttrs(WallType wt) =>
            new Dictionary<string, object>
            {
                ["name"] = wt.Name ?? string.Empty,
                ["total_thickness"] = RoundM(wt.Width * FeetToMetres),
            };

        private static Dictionary<string, object> ReadFloorTypeAttrs(FloorType ft)
        {
            double thickness = 0;
            try
            {
                var cs = ft.GetCompoundStructure();
                if (cs != null) thickness = RoundM(cs.GetWidth() * FeetToMetres);
            }
            catch { }
            return new Dictionary<string, object>
            {
                ["name"] = ft.Name ?? string.Empty,
                ["total_thickness"] = thickness,
            };
        }

        private Dictionary<string, object> ReadFloorAttrs(Floor fl)
        {
            double area = TryGetParamSquareMetres(fl, BuiltInParameter.HOST_AREA_COMPUTED) ?? 0.0;

            var attrs = new Dictionary<string, object>
            {
                ["type_ref"] = $"revit_{SafeIdValue(fl.GetTypeId())}",
                ["level_ref"] = $"revit_{SafeIdValue(fl.LevelId)}",
                ["area_m2"] = area,
            };

            var boundary = TryReadFloorBoundary(fl);
            if (boundary != null) attrs["boundary"] = boundary;

            return attrs;
        }

        // Outer boundary loop of the floor sketch as [x,y] metre points.
        // Best-effort: null on any API hiccup (kept optional in the spec).
        private double[][] TryReadFloorBoundary(Floor fl)
        {
            try
            {
                var sketchId = fl.SketchId;
                if (sketchId == null || SafeIdValue(sketchId) <= 0) return null;
                if (!(_doc.GetElement(sketchId) is Sketch sketch) || sketch.Profile == null) return null;

                foreach (CurveArray loop in sketch.Profile)
                {
                    var pts = new List<double[]>();
                    foreach (Curve c in loop)
                    {
                        var p = c.GetEndPoint(0);
                        pts.Add(new[] { RoundM(p.X * FeetToMetres), RoundM(p.Y * FeetToMetres) });
                    }
                    if (pts.Count > 0) return pts.ToArray();
                }
                return null;
            }
            catch { return null; }
        }

        private Dictionary<string, object> ReadWallAttrs(Wall w)
        {
            double[] p1 = null, p2 = null;
            double length = 0;
            if (w.Location is LocationCurve lc && lc.Curve != null)
            {
                var a = lc.Curve.GetEndPoint(0);
                var b = lc.Curve.GetEndPoint(1);
                p1 = new[] { RoundM(a.X * FeetToMetres), RoundM(a.Y * FeetToMetres) };
                p2 = new[] { RoundM(b.X * FeetToMetres), RoundM(b.Y * FeetToMetres) };
                length = RoundM(lc.Curve.ApproximateLength * FeetToMetres);
            }
            double height = TryGetParamMetres(w, BuiltInParameter.WALL_USER_HEIGHT_PARAM) ?? 0.0;

            return new Dictionary<string, object>
            {
                ["type_ref"] = $"revit_{SafeIdValue(w.GetTypeId())}",
                ["level_ref"] = $"revit_{SafeIdValue(w.LevelId)}",
                ["p1"] = p1 ?? new[] { 0.0, 0.0 },
                ["p2"] = p2 ?? new[] { 0.0, 0.0 },
                ["length"] = length,
                ["height"] = height,
            };
        }

        private Dictionary<string, object> ReadOpeningAttrs(FamilyInstance fi)
        {
            double[] position = null;
            if (fi.Location is LocationPoint lp && lp.Point != null)
            {
                position = new[] { RoundM(lp.Point.X * FeetToMetres), RoundM(lp.Point.Y * FeetToMetres) };
            }
            double sill = TryGetParamMetres(fi, BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM) ?? 0.0;
            double head = TryGetParamMetres(fi, BuiltInParameter.INSTANCE_HEAD_HEIGHT_PARAM) ?? 0.0;
            long hostId = fi.Host is Wall w ? SafeIdValue(w.Id) : 0;

            return new Dictionary<string, object>
            {
                ["type_ref"] = $"revit_{SafeIdValue(fi.GetTypeId())}",
                ["host_wall_ref"] = $"revit_{hostId}",
                ["position"] = position ?? new[] { 0.0, 0.0 },
                ["sill_height"] = sill,
                ["head_height"] = head,
            };
        }

        private static Dictionary<string, object> ReadMaterialAttrs(Material mat)
        {
            var attrs = new Dictionary<string, object>
            {
                ["name"] = mat.Name ?? string.Empty,
            };
            if (!string.IsNullOrEmpty(mat.MaterialClass))
                attrs["material_class"] = mat.MaterialClass;
            try
            {
                var c = mat.Color;
                if (c != null && c.IsValid)
                    attrs["color"] = $"#{c.Red:X2}{c.Green:X2}{c.Blue:X2}";
            }
            catch { }
            return attrs;
        }

        private Dictionary<string, object> ReadFacadeElementAttrs(FamilyInstance fi)
        {
            double[] position = null;
            if (fi.Location is LocationPoint lp && lp.Point != null)
                position = new[] { RoundM(lp.Point.X * FeetToMetres), RoundM(lp.Point.Y * FeetToMetres) };

            return new Dictionary<string, object>
            {
                ["family_name"] = fi.Symbol?.Family?.Name ?? string.Empty,
                ["type_name"] = fi.Symbol?.Name ?? fi.Name ?? string.Empty,
                ["position"] = position ?? new[] { 0.0, 0.0 },
                ["level_ref"] = $"revit_{SafeIdValue(fi.LevelId)}",
            };
        }

        private static Dictionary<string, object> ReadFamilyTypeAttrs(FamilySymbol fs) =>
            new Dictionary<string, object>
            {
                ["family_name"] = fs.Family?.Name ?? string.Empty,
                ["type_name"] = fs.Name ?? string.Empty,
                ["category"] = fs.Category?.Name ?? string.Empty,
            };

        private Dictionary<string, object> ReadRoomAttrs(Room room)
        {
            // Room.Name on its own can fold in the number ("Bureau 12");
            // ROOM_NAME isolates the user-facing name, with a defensive
            // fallback to Element.Name.
            var name = TryGetParamString(room, BuiltInParameter.ROOM_NAME);
            if (string.IsNullOrEmpty(name)) name = room.Name ?? string.Empty;

            var attrs = new Dictionary<string, object>
            {
                ["name"] = name,
                ["level_ref"] = $"revit_{SafeIdValue(room.LevelId)}",
                // Area is stored in square feet internally; metres² to match
                // every other KG v2 spatial attr. 0 for unplaced/unenclosed.
                ["area"] = RoundM(room.Area * SqFeetToSqMetres),
            };

            var boundaryWalls = ReadBoundaryWallIds(room)
                .Select(id => $"revit_{id}")
                .ToList();
            if (boundaryWalls.Count > 0) attrs["boundary_walls"] = boundaryWalls;

            return attrs;
        }

        // Distinct Wall ElementIds that bound the room (Finish location).
        // Non-wall boundary segments (separation lines, other rooms) and
        // unenclosed rooms yield nothing. Not an iterator so the
        // GetBoundarySegments call can sit inside a try/catch.
        private List<long> ReadBoundaryWallIds(Room room)
        {
            var result = new List<long>();
            var seen = new HashSet<long>();
            IList<IList<BoundarySegment>> loops;
            try { loops = room.GetBoundarySegments(new SpatialElementBoundaryOptions()); }
            catch { return result; }
            if (loops == null) return result;

            foreach (var loop in loops)
            {
                if (loop == null) continue;
                foreach (var seg in loop)
                {
                    if (seg == null) continue;
                    var id = SafeIdValue(seg.ElementId);
                    if (id <= 0 || !seen.Add(id)) continue;
                    if (GetElement(id) is Wall) result.Add(id);
                }
            }
            return result;
        }

        // ---- helpers ----

        private Element GetElement(long elementId)
        {
            try { return _doc.GetElement(new ElementId(elementId)); }
            catch { return null; }
        }

        private static long SafeIdValue(ElementId id)
        {
            if (id == null) return 0;
            try { return id.Value; }
            catch { return 0; }
        }

        private static double? TryGetParamMetres(Element el, BuiltInParameter bip)
        {
            try
            {
                var p = el.get_Parameter(bip);
                if (p == null || !p.HasValue) return null;
                return RoundM(p.AsDouble() * FeetToMetres);
            }
            catch { return null; }
        }

        private static double? TryGetParamSquareMetres(Element el, BuiltInParameter bip)
        {
            try
            {
                var p = el.get_Parameter(bip);
                if (p == null || !p.HasValue) return null;
                return RoundM(p.AsDouble() * SqFeetToSqMetres);
            }
            catch { return null; }
        }

        private static string TryGetParamString(Element el, BuiltInParameter bip)
        {
            try
            {
                var p = el.get_Parameter(bip);
                return p != null && p.HasValue ? p.AsString() : null;
            }
            catch { return null; }
        }
    }
}
