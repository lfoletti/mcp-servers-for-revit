using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitMCPKgCommandSet.Core;

namespace RevitMCPKgCommandSet.Services
{
    public sealed class RevitElementReader : IElementReader
    {
        private const double FeetToMetres = 0.3048;
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
                case Wall w: return ReadWallAttrs(w);
                case FamilyInstance fi: return IsOpening(fi) ? ReadOpeningAttrs(fi) : null;
                case FamilySymbol fs: return IsOpeningSymbol(fs) ? ReadFamilyTypeAttrs(fs) : null;
                default: return null;
            }
        }

        public IEnumerable<long> EnumerateAllElementIds()
        {
            // Mirrors KgV2DocumentWatcher.BootstrapDocument's scan classes
            // (Level, WallType, FamilySymbol-of-openings, Wall,
            // FamilyInstance-of-openings) so drift detection covers
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
                .Where(IsOpeningSymbol)
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

            return ids;
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
                case Wall _: return "Wall";
                case FamilyInstance fi:
                    if (IsCategory(fi, BuiltInCategory.OST_Windows)) return "Window";
                    if (IsCategory(fi, BuiltInCategory.OST_Doors)) return "Door";
                    return null;
                case FamilySymbol fs:
                    return IsOpeningSymbol(fs) ? "FamilyType" : null;
                default:
                    return null;
            }
        }

        private static bool IsOpening(FamilyInstance fi) =>
            IsCategory(fi, BuiltInCategory.OST_Windows) || IsCategory(fi, BuiltInCategory.OST_Doors);

        private static bool IsOpeningSymbol(FamilySymbol fs) =>
            IsCategory(fs, BuiltInCategory.OST_Windows) || IsCategory(fs, BuiltInCategory.OST_Doors);

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
                ["elevation"] = lvl.Elevation * FeetToMetres,
            };

        private static Dictionary<string, object> ReadWallTypeAttrs(WallType wt) =>
            new Dictionary<string, object>
            {
                ["name"] = wt.Name ?? string.Empty,
                ["total_thickness"] = wt.Width * FeetToMetres,
            };

        private Dictionary<string, object> ReadWallAttrs(Wall w)
        {
            double[] p1 = null, p2 = null;
            double length = 0;
            if (w.Location is LocationCurve lc && lc.Curve != null)
            {
                var a = lc.Curve.GetEndPoint(0);
                var b = lc.Curve.GetEndPoint(1);
                p1 = new[] { a.X * FeetToMetres, a.Y * FeetToMetres };
                p2 = new[] { b.X * FeetToMetres, b.Y * FeetToMetres };
                length = lc.Curve.ApproximateLength * FeetToMetres;
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
                position = new[] { lp.Point.X * FeetToMetres, lp.Point.Y * FeetToMetres };
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

        private static Dictionary<string, object> ReadFamilyTypeAttrs(FamilySymbol fs) =>
            new Dictionary<string, object>
            {
                ["family_name"] = fs.Family?.Name ?? string.Empty,
                ["type_name"] = fs.Name ?? string.Empty,
                ["category"] = fs.Category?.Name ?? string.Empty,
            };

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
                return p.AsDouble() * FeetToMetres;
            }
            catch { return null; }
        }
    }
}
