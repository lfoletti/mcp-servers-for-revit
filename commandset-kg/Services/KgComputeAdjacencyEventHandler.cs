using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using RevitMCPKgCommandSet.Core;
using RevitMCPKgCommandSet.Models;
using RevitMCPKgCommandSet.Models.Common;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPKgCommandSet.Services
{
    /// <summary>
    /// Computes room-to-room adjacency (Derived edge <c>adjacent_to</c>) from the
    /// live model — the only place it is reliable, separation lines included.
    /// Deterministic (no LLM), idempotent (full replace of adjacent_to each run).
    /// Revit-side is read-only: GetBoundarySegments + GetRoomAtPoint, no
    /// transaction. Writes land in the KG only.
    /// </summary>
    public class KgComputeAdjacencyEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        // Perpendicular probe distances (feet) from a boundary midpoint. Several
        // steps so a neighbour is found across walls of varying thickness.
        private static readonly double[] ProbeDistancesFeet = { 0.3, 0.8, 1.5 };

        public AIResult<KgComputeAdjacencyResult> Result { get; private set; }

        public void SetParameters()
        {
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                KgV2DocumentWatcher.EnsureSubscribed(app);
                var kg = KgV2DocumentWatcher.GetCurrentProjectKg();
                var doc = app.ActiveUIDocument?.Document;
                if (kg == null || doc == null)
                {
                    Result = new AIResult<KgComputeAdjacencyResult>
                    {
                        Success = false,
                        Message = "kg_compute_adjacency: no active KG v2 projection",
                    };
                    return;
                }

                var reader = new RevitElementReader(doc);
                int turn = kg.AdvanceTurn();

                var rooms = new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_Rooms)
                    .WhereElementIsNotElementType()
                    .Cast<Room>()
                    .Where(r => r != null && r.Area > 0 && r.Location != null)
                    .ToList();

                // pairKey "src|dst" (canonical, src=min llm_id) → aggregated state.
                var pairs = new Dictionary<string, PairAgg>();
                var separationLineIds = new HashSet<long>();
                var opts = new SpatialElementBoundaryOptions();

                foreach (var room in rooms)
                {
                    var roomLlmId = kg.FindByRevitId(room.Id.Value);
                    if (roomLlmId == null) continue;
                    var phase = ResolvePhase(doc, room);

                    IList<IList<BoundarySegment>> loops;
                    try { loops = room.GetBoundarySegments(opts); }
                    catch { continue; }
                    if (loops == null) continue;

                    foreach (var loop in loops)
                    {
                        if (loop == null) continue;
                        foreach (var seg in loop)
                        {
                            if (seg == null) continue;
                            var curve = GetSegmentCurve(seg);
                            if (curve == null) continue;

                            long beId = SafeId(seg.ElementId);
                            var be = beId > 0 ? GetElement(doc, beId) : null;
                            bool isWall = be is Wall;
                            bool isSep = IsRoomSeparationLine(be);
                            if (isSep) separationLineIds.Add(beId);

                            var neighbour = FindNeighbourRoom(doc, curve, phase, room);
                            if (neighbour == null) continue;

                            var otherLlmId = kg.FindByRevitId(neighbour.Id.Value);
                            if (otherLlmId == null || otherLlmId == roomLlmId) continue;

                            // Mediator node (the wall/separation between the two
                            // rooms). Ensure separation-line nodes exist so `via`
                            // can carry their llm_id (walls are already projected).
                            string mediatorLlmId = null;
                            if (beId > 0)
                            {
                                mediatorLlmId = kg.FindByRevitId(beId);
                                if (mediatorLlmId == null && isSep)
                                {
                                    Projection.ApplyAdded(kg, reader, new[] { beId });
                                    mediatorLlmId = kg.FindByRevitId(beId);
                                }
                            }

                            string boundaryKind = isWall ? "wall" : isSep ? "separation" : null;
                            var key = CanonicalKey(roomLlmId, otherLlmId, out var src, out var dst);
                            if (!pairs.TryGetValue(key, out var agg))
                                pairs[key] = agg = new PairAgg { Src = src, Dst = dst };
                            if (boundaryKind != null) agg.Kinds.Add(boundaryKind);
                            if (mediatorLlmId != null) agg.Via.Add(mediatorLlmId);
                        }
                    }
                }

                // Full replace: drop every prior adjacent_to, then re-emit. Keeps
                // the edge set an exact mirror of the current geometry (a pair no
                // longer adjacent simply disappears).
                foreach (var e in kg.Edges.Where(e => e.EdgeType == EdgeTypes.AdjacentTo).ToList())
                    kg.RemoveEdge(e.Src, e.Dst, e.EdgeType);

                var views = new List<KgAdjacencyPairView>();
                foreach (var agg in pairs.Values)
                {
                    var boundaryType = agg.Kinds.Count == 0 ? "unknown"
                        : agg.Kinds.Count == 1 ? agg.Kinds.First()
                        : "mixed";
                    var via = agg.Via.OrderBy(x => x, StringComparer.Ordinal).ToList();
                    var attrs = new Dictionary<string, object>
                    {
                        ["boundary_type"] = boundaryType,
                        ["via"] = via,
                        ["computed_at_turn"] = turn,
                    };
                    try
                    {
                        kg.AddEdge(agg.Src, agg.Dst, EdgeTypes.AdjacentTo, attrs);
                        views.Add(new KgAdjacencyPairView
                        {
                            Src = agg.Src,
                            Dst = agg.Dst,
                            BoundaryType = boundaryType,
                            Via = via,
                        });
                    }
                    catch (Exception) { /* skip a pair whose node vanished mid-run */ }
                }

                KgV2DocumentWatcher.FlushCurrent();

                Result = new AIResult<KgComputeAdjacencyResult>
                {
                    Success = true,
                    Message = $"KG v2 adjacency: {views.Count} pairs across {rooms.Count} rooms (turn {turn})",
                    Response = new KgComputeAdjacencyResult
                    {
                        Rooms = rooms.Count,
                        Pairs = views.Count,
                        SeparationLines = separationLineIds.Count,
                        ComputedAtTurn = turn,
                        Adjacencies = views,
                    },
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgComputeAdjacencyResult>
                {
                    Success = false,
                    Message = $"kg_compute_adjacency failed: {ex.Message}",
                };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        // Probe both perpendicular sides of the boundary midpoint at growing
        // distances; the first room that is neither null nor the source room is
        // the neighbour across this segment.
        private static Room FindNeighbourRoom(Document doc, Curve curve, Phase phase, Room self)
        {
            XYZ mid, normal;
            try
            {
                mid = curve.Evaluate(0.5, true);
                var d = curve.GetEndPoint(1) - curve.GetEndPoint(0);
                if (d.GetLength() < 1e-9) return null;
                var dir = d.Normalize();
                normal = new XYZ(-dir.Y, dir.X, 0);
                if (normal.GetLength() < 1e-9) return null;
                normal = normal.Normalize();
            }
            catch { return null; }

            foreach (var dist in ProbeDistancesFeet)
            {
                foreach (var sign in new[] { 1.0, -1.0 })
                {
                    var pt = mid + normal.Multiply(dist * sign);
                    Room hit;
                    try
                    {
                        hit = phase != null ? doc.GetRoomAtPoint(pt, phase) : doc.GetRoomAtPoint(pt);
                    }
                    catch { continue; }
                    if (hit != null && hit.Id != self.Id) return hit;
                }
            }
            return null;
        }

        private static Phase ResolvePhase(Document doc, Room room)
        {
            try
            {
                var pid = room.CreatedPhaseId;
                if (pid != null && pid.Value > 0) return doc.GetElement(pid) as Phase;
            }
            catch { }
            return null;
        }

        private static Curve GetSegmentCurve(BoundarySegment seg)
        {
            try
            {
#if REVIT2022_OR_GREATER
                return seg.GetCurve();
#else
                return seg.Curve;
#endif
            }
            catch { return null; }
        }

        private static string CanonicalKey(string a, string b, out string src, out string dst)
        {
            if (string.CompareOrdinal(a, b) <= 0) { src = a; dst = b; }
            else { src = b; dst = a; }
            return src + "|" + dst;
        }

        private static bool IsRoomSeparationLine(Element el) =>
            el is CurveElement && el.Category != null &&
            SafeId(el.Category.Id) == (long)BuiltInCategory.OST_RoomSeparationLines;

        private static Element GetElement(Document doc, long id)
        {
            try { return doc.GetElement(new ElementId(id)); }
            catch { return null; }
        }

        private static long SafeId(ElementId id)
        {
            if (id == null) return 0;
            try { return id.Value; }
            catch { return 0; }
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 30000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "KG Compute Adjacency";

        private sealed class PairAgg
        {
            public string Src;
            public string Dst;
            public readonly HashSet<string> Kinds = new HashSet<string>();
            public readonly HashSet<string> Via = new HashSet<string>();
        }
    }
}
