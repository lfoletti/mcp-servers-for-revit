using System;
using System.Threading;
using Autodesk.Revit.UI;
using RevitMCPKgCommandSet.Models;
using RevitMCPKgCommandSet.Models.Common;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPKgCommandSet.Services
{
    public class KgSessionInfoEventHandler : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent = new ManualResetEvent(false);

        public AIResult<KgSessionInfoResult> Result { get; private set; }

        public void Execute(UIApplication app)
        {
            try
            {
                var doc = app?.ActiveUIDocument?.Document;
                var pathName = doc?.PathName ?? string.Empty;
                var projectId = string.IsNullOrEmpty(pathName)
                    ? $"title:{doc?.Title ?? "untitled"}"
                    : pathName;

                Result = new AIResult<KgSessionInfoResult>
                {
                    Success = true,
                    Message = "KG v2 session info (stub)",
                    Response = new KgSessionInfoResult
                    {
                        ProjectId = projectId,
                        Turn = 0,
                        NodeCount = 0,
                        EdgeCount = 0,
                        LastActionSummary = "stub — KG v2 not yet wired to DocumentChanged (P2)",
                    },
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgSessionInfoResult>
                {
                    Success = false,
                    Message = $"kg_session_info failed: {ex.Message}",
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

        public string GetName() => "KG Session Info";
    }
}
