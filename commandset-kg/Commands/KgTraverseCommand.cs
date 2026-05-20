using System;
using System.Collections.Generic;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPKgCommandSet.Core;
using RevitMCPKgCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPKgCommandSet.Commands
{
    public class KgTraverseCommand : ExternalEventCommandBase
    {
        private KgTraverseEventHandler _handler => (KgTraverseEventHandler)Handler;

        public override string CommandName => "kg_traverse";

        public KgTraverseCommand(UIApplication uiApp)
            : base(new KgTraverseEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                var startId = parameters?["start_id"]?.ToString();
                if (string.IsNullOrEmpty(startId))
                    throw new ArgumentException("start_id required");

                var path = new List<TraverseStep>();
                if (parameters?["path"] is JArray arr)
                {
                    foreach (var step in arr)
                    {
                        var edgeType = step?["edge_type"]?.ToString();
                        var dirStr = (step?["direction"]?.ToString() ?? "out").ToLowerInvariant();
                        var dir = (dirStr == "in" || dirStr == "incoming")
                            ? EdgeDirection.Incoming
                            : EdgeDirection.Outgoing;
                        path.Add(new TraverseStep { EdgeType = edgeType, Direction = dir });
                    }
                }

                _handler.SetParameters(startId, path);

                if (RaiseAndWaitForCompletion(10000))
                    return _handler.Result;

                throw new TimeoutException("kg_traverse timed out");
            }
            catch (Exception ex)
            {
                throw new Exception($"kg_traverse failed: {ex.Message}");
            }
        }
    }
}
