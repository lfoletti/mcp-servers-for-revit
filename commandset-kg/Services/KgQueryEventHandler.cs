using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Autodesk.Revit.UI;
using RevitMCPKgCommandSet.Core;
using RevitMCPKgCommandSet.Models;
using RevitMCPKgCommandSet.Models.Common;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPKgCommandSet.Services
{
    public class KgQueryEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string NodeType { get; private set; }
        public Dictionary<string, object> AttrsFilter { get; private set; }
        public bool IncludeSoftDeleted { get; private set; }
        public HashSet<string> Select { get; private set; }
        public string AggOp { get; private set; }
        public string AggField { get; private set; }
        public string AggGroupBy { get; private set; }
        public List<JoinStep> Join { get; private set; }
        public bool IncludeEdges { get; private set; }

        public AIResult<KgQueryResult> Result { get; private set; }

        public void SetParameters(
            string nodeType, Dictionary<string, object> attrsFilter, bool includeSoftDeleted,
            HashSet<string> select = null, string aggOp = null, string aggField = null, string aggGroupBy = null,
            List<JoinStep> join = null, bool includeEdges = false)
        {
            NodeType = nodeType;
            AttrsFilter = attrsFilter;
            IncludeSoftDeleted = includeSoftDeleted;
            Select = select;
            AggOp = aggOp;
            AggField = aggField;
            AggGroupBy = aggGroupBy;
            Join = join;
            IncludeEdges = includeEdges;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                KgV2DocumentWatcher.EnsureSubscribed(app);
                var kg = KgV2DocumentWatcher.GetCurrentProjectKg();

                var nodes = NodeQueryFilter.Apply(kg, NodeType, AttrsFilter, IncludeSoftDeleted);

                KgQueryResult response;
                if (!string.IsNullOrEmpty(AggOp))
                {
                    var agg = NodeAggregator.Aggregate(nodes, AggOp, AggField, AggGroupBy);
                    response = new KgQueryResult { Count = agg.N, Nodes = null, Aggregate = agg };
                }
                else if (Join != null && Join.Count > 0)
                {
                    var rows = NodeJoiner.BuildRows(kg, nodes, Select, Join);
                    response = new KgQueryResult { Count = rows.Count, Nodes = null, Rows = rows };
                }
                else
                {
                    var nodeList = nodes as IList<Node> ?? nodes.ToList();
                    var views = NodeViewBuilder.FromMany(nodeList, Select);
                    response = new KgQueryResult { Count = views.Count, Nodes = views };

                    if (IncludeEdges)
                    {
                        // Induced subgraph: only edges with both endpoints in
                        // the matched set, so the result stands alone.
                        var idset = new HashSet<string>(nodeList.Select(n => n.LlmId));
                        var edgeViews = new List<KgEdgeView>();
                        foreach (var e in kg.Edges)
                        {
                            if (!idset.Contains(e.Src) || !idset.Contains(e.Dst)) continue;
                            edgeViews.Add(new KgEdgeView
                            {
                                Src = e.Src,
                                Dst = e.Dst,
                                EdgeType = e.EdgeType,
                                Attrs = (e.Attrs != null && e.Attrs.Count > 0) ? e.Attrs : null,
                            });
                        }
                        response.Edges = edgeViews;
                        response.EdgesCount = edgeViews.Count;
                    }
                }

                Result = new AIResult<KgQueryResult>
                {
                    Success = true,
                    Message = "KG v2 query",
                    Response = response,
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgQueryResult>
                {
                    Success = false,
                    Message = $"kg_query failed: {ex.Message}",
                };
            }
            finally
            {
                _resetEvent.Set();
            }
        }

        public bool WaitForCompletion(int timeoutMilliseconds = 10000)
        {
            _resetEvent.Reset();
            return _resetEvent.WaitOne(timeoutMilliseconds);
        }

        public string GetName() => "KG Query";
    }
}
