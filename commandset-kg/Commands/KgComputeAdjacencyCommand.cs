using System;
using Autodesk.Revit.UI;
using Newtonsoft.Json.Linq;
using RevitMCPKgCommandSet.Services;
using RevitMCPSDK.API.Base;

namespace RevitMCPKgCommandSet.Commands
{
    /// <summary>
    /// kg_compute_adjacency — build the Derived <c>adjacent_to</c> edges (Room ↔
    /// Room) from the live model, projecting room-separation lines on the way.
    /// Deterministic, idempotent (full replace), Revit-side read-only.
    /// </summary>
    public class KgComputeAdjacencyCommand : ExternalEventCommandBase
    {
        private KgComputeAdjacencyEventHandler _handler => (KgComputeAdjacencyEventHandler)Handler;

        public override string CommandName => "kg_compute_adjacency";

        public KgComputeAdjacencyCommand(UIApplication uiApp)
            : base(new KgComputeAdjacencyEventHandler(), uiApp)
        {
        }

        public override object Execute(JObject parameters, string requestId)
        {
            try
            {
                _handler.SetParameters();

                // GetRoomAtPoint × boundary segments × rooms can run a few
                // seconds on a large plan — allow a generous window.
                if (RaiseAndWaitForCompletion(60000))
                    return _handler.Result;

                throw new TimeoutException("kg_compute_adjacency timed out");
            }
            catch (Exception ex)
            {
                throw new Exception($"kg_compute_adjacency failed: {ex.Message}");
            }
        }
    }
}
