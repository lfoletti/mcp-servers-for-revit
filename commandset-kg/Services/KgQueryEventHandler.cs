using System;
using System.Collections.Generic;
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

        public AIResult<KgQueryResult> Result { get; private set; }

        public void SetParameters(string nodeType, Dictionary<string, object> attrsFilter, bool includeSoftDeleted)
        {
            NodeType = nodeType;
            AttrsFilter = attrsFilter;
            IncludeSoftDeleted = includeSoftDeleted;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                KgV2DocumentWatcher.EnsureSubscribed(app?.Application);
                var kg = KgV2DocumentWatcher.GetCurrentProjectKg();

                var nodes = NodeQueryFilter.Apply(kg, NodeType, AttrsFilter, IncludeSoftDeleted);
                var views = NodeViewBuilder.FromMany(nodes);

                Result = new AIResult<KgQueryResult>
                {
                    Success = true,
                    Message = "KG v2 query",
                    Response = new KgQueryResult { Count = views.Count, Nodes = views },
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
