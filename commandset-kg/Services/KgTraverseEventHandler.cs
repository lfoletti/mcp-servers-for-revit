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
    public class KgTraverseEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public string StartId { get; private set; }
        public List<TraverseStep> Path { get; private set; }

        public AIResult<KgTraverseResult> Result { get; private set; }

        public void SetParameters(string startId, List<TraverseStep> path)
        {
            StartId = startId;
            Path = path ?? new List<TraverseStep>();
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                KgV2DocumentWatcher.EnsureSubscribed(app?.Application);
                var kg = KgV2DocumentWatcher.GetCurrentProjectKg();

                var reached = PathTraversal.Walk(kg, StartId, Path);
                var reachedList = new List<KgTraverseReachedNode>();
                if (kg != null)
                {
                    foreach (var id in reached)
                    {
                        if (kg.HasNode(id))
                        {
                            var n = kg.GetNode(id);
                            reachedList.Add(new KgTraverseReachedNode
                            {
                                LlmId = n.LlmId,
                                NodeType = n.NodeType,
                            });
                        }
                    }
                }

                Result = new AIResult<KgTraverseResult>
                {
                    Success = true,
                    Message = "KG v2 traverse",
                    Response = new KgTraverseResult
                    {
                        StartId = StartId,
                        StepCount = Path.Count,
                        Count = reachedList.Count,
                        Reached = reachedList,
                    },
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgTraverseResult>
                {
                    Success = false,
                    Message = $"kg_traverse failed: {ex.Message}",
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

        public string GetName() => "KG Traverse";
    }
}
