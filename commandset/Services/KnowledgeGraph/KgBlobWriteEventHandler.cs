using System;
using System.Threading;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitMCPCommandSet.Models.Common;
using RevitMCPCommandSet.Models.KnowledgeGraph;
using RevitMCPSDK.API.Interfaces;

namespace RevitMCPCommandSet.Services.KnowledgeGraph
{
    /// <summary>
    /// Handler de <c>kg_blob_write</c> — moule de
    /// <c>CreateLevelEventHandler</c> (SetParameters → ExternalEvent →
    /// <c>Transaction</c>). L'écriture ES dans une Tx Revit rend
    /// l'atomicité Stage 2 « gratuite » (DESIGN-internalize-es.md §1, §4,
    /// §8, §10.3). Le découpage 16 Mo/chunk est garanti **côté TS**
    /// (`server/src/kg/persist.ts`) — ici on stocke tel quel.
    /// </summary>
    public class KgBlobWriteEventHandler
        : IExternalEventHandler, IWaitableExternalEventHandler
    {
        private readonly ManualResetEvent _resetEvent =
            new ManualResetEvent(false);

        /// <summary>Données à persister (input).</summary>
        public KgBlobWriteParams Data { get; private set; }

        /// <summary>Résultat (output).</summary>
        public AIResult<KgBlobWriteResult> Result { get; private set; }

        /// <summary>Pose les paramètres avant de lever l'ExternalEvent.</summary>
        public void SetParameters(KgBlobWriteParams data)
        {
            Data = data;
            _resetEvent.Reset();
        }

        public void Execute(UIApplication app)
        {
            try
            {
                // Démarre la surveillance §5 dès la 1ʳᵉ op KG (idempotent).
                KgDocumentWatcher.EnsureSubscribed(app?.Application);

                Document doc = app.ActiveUIDocument?.Document;
                if (doc == null)
                    throw new InvalidOperationException(
                        "No active Revit document for kg_blob_write");
                if (Data == null)
                    throw new ArgumentNullException(
                        nameof(Data), "No KG blob data provided");

                bool created = KgExtensibleStorage.Write(doc, Data);

                Result = new AIResult<KgBlobWriteResult>
                {
                    Success = true,
                    Message = created
                        ? "KG blob written (DataStorage created)"
                        : "KG blob written",
                    Response = new KgBlobWriteResult
                    {
                        Wrote = true,
                        CreatedDataStorage = created,
                    },
                };
            }
            catch (Exception ex)
            {
                Result = new AIResult<KgBlobWriteResult>
                {
                    Success = false,
                    Message = $"kg_blob_write failed: {ex.Message}",
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

        public string GetName() => "KG Blob Write";
    }
}
