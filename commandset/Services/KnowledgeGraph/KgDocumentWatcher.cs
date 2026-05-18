using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using RevitMCPCommandSet.Models.KnowledgeGraph;
using RevitMCPCommandSet.Utils;

namespace RevitMCPCommandSet.Services.KnowledgeGraph
{
    /// <summary>
    /// Protocole de cohérence cache↔`.rvt` (DESIGN-internalize-es.md §5,
    /// §10.5) — la moitié C#. Le graphe TS en mémoire est un **cache** du
    /// blob ES ; le `.rvt` change aussi hors de l'agent (édition humaine,
    /// ouverture/bascule de document, Sync-to-Central). Sans signal, le
    /// cache ment.
    ///
    /// Il n'existe **pas** de canal push Revit→serveur (le socket est
    /// requête→réponse). On expose donc un **epoch** monotone + l'identité
    /// du document, que le serveur interroge (commande `kg_doc_state`, sans
    /// Tx) au début de chaque op KG : epoch/doc inchangés ⇒ il garde son
    /// cache (« cache longue durée pour les écritures-outils », §5) ;
    /// changé ⇒ il recharge depuis l'ES. C'est la ligne « Cache longue
    /// durée + signal d'invalidation » du tableau §5, le signal étant
    /// *sondé* à coût quasi nul plutôt que poussé.
    ///
    /// **Filtre clé** : un `DocumentChanged` dont *toutes* les transactions
    /// sont la nôtre (<see cref="KgExtensibleStorage.WriteTransactionName"/>)
    /// n'incrémente PAS l'epoch — sinon nos propres écritures ES feraient
    /// recharger le serveur à chaque op (perte du cache, §5). Source unique
    /// du littéral ⇒ le filtre ne peut pas dériver de l'écrivain.
    ///
    /// Les ids supprimés/ajoutés/modifiés sont aussi capturés (fenêtre
    /// bornée, par epoch) : c'est la **base de `kg_detect_drift` (Stage 2)**.
    /// Étape 5 ne fait que *câbler le signal* ; basculer `deleted_at_turn` +
    /// la `Map<ElementId,llm_id>` est le refactor §2 / Stage 2, **différé**.
    ///
    /// Souscription **lazy & idempotente** depuis les handlers KG (pas
    /// d'`IExternalApplication` dans le commandset ; tout reste self-contained
    /// comme aux étapes 3–4). Robustesse : un handler d'événement Revit ne
    /// doit JAMAIS lever — tout est sous try/catch.
    /// </summary>
    public static class KgDocumentWatcher
    {
        private const int MaxDriftIds = 10000; // borne mémoire par catégorie

        private struct DriftEntry
        {
            public long Epoch;
            public long Id;
        }

        private static readonly object _lock = new object();
        private static bool _subscribed;
        private static Application _app;

        private static long _epoch;
        private static string _docKey = string.Empty;
        private static string _docTitle = string.Empty;

        private static readonly List<DriftEntry> _deleted = new List<DriftEntry>();
        private static readonly List<DriftEntry> _added = new List<DriftEntry>();
        private static readonly List<DriftEntry> _modified = new List<DriftEntry>();

        /// <summary>
        /// Souscrit (une seule fois) aux événements document de
        /// l'application Revit. Appelé en tête des handlers KG → la
        /// surveillance démarre à la première op KG du serveur.
        /// </summary>
        public static void EnsureSubscribed(Application app)
        {
            if (app == null) return;
            lock (_lock)
            {
                if (_subscribed) return;
                try
                {
                    app.DocumentChanged += OnDocumentChanged;
                    app.DocumentOpened += OnDocumentOpened;
                    app.DocumentSynchronizingWithCentral += OnSynchronizing;
                    _app = app;
                    _subscribed = true;

                    // Amorce l'identité avec le document actif courant (le
                    // serveur peut interroger avant tout événement).
                    Document active = app.Documents
                        ?.Cast<Document>()
                        .FirstOrDefault(d => d != null && !d.IsLinked);
                    if (active != null) SetDocIdentity(active);
                }
                catch
                {
                    // Souscription best-effort : ne jamais casser la commande.
                }
            }
        }

        /// <summary>
        /// Photo de l'état pour `kg_doc_state`. <paramref name="sinceEpoch"/>
        /// borne la fenêtre de drift renvoyée (0 ⇒ tout le buffer retenu).
        /// </summary>
        public static KgDocStateResult Snapshot(long sinceEpoch)
        {
            lock (_lock)
            {
                return new KgDocStateResult
                {
                    Epoch = _epoch,
                    DocKey = _docKey,
                    DocTitle = _docTitle,
                    DeletedIds = IdsSince(_deleted, sinceEpoch),
                    AddedIds = IdsSince(_added, sinceEpoch),
                    ModifiedIds = IdsSince(_modified, sinceEpoch),
                };
            }
        }

        private static List<long> IdsSince(List<DriftEntry> buf, long since)
        {
            var outIds = new List<long>();
            foreach (var d in buf)
                if (d.Epoch > since) outIds.Add(d.Id);
            return outIds;
        }

        private static void SetDocIdentity(Document doc)
        {
            if (doc == null) return;
            string path = doc.PathName;
            _docTitle = doc.Title ?? string.Empty;
            _docKey = !string.IsNullOrEmpty(path) ? path : _docTitle;
        }

        private static void Append(List<DriftEntry> buf, IEnumerable<ElementId> ids, long epoch)
        {
            foreach (var id in ids)
            {
                buf.Add(new DriftEntry { Epoch = epoch, Id = id.GetValue() });
            }
            if (buf.Count > MaxDriftIds)
                buf.RemoveRange(0, buf.Count - MaxDriftIds); // drop oldest
        }

        // ----- handlers d'événements Revit (ne lèvent jamais) --------------

        private static void OnDocumentChanged(object sender, DocumentChangedEventArgs e)
        {
            try
            {
                lock (_lock)
                {
                    IList<string> txns = e.GetTransactionNames();
                    // Nos propres écritures ES : NE PAS invalider le cache
                    // serveur (§5). Tout autre changement ⇒ signal.
                    bool onlyOurWrites =
                        txns != null &&
                        txns.Count > 0 &&
                        txns.All(n => n == KgExtensibleStorage.WriteTransactionName);
                    if (onlyOurWrites) return;

                    _epoch += 1;
                    try { SetDocIdentity(e.GetDocument()); } catch { }
                    Append(_deleted, e.GetDeletedElementIds(), _epoch);
                    Append(_added, e.GetAddedElementIds(), _epoch);
                    Append(_modified, e.GetModifiedElementIds(), _epoch);
                }
            }
            catch
            {
                // Un handler d'événement Revit ne doit jamais propager.
            }
        }

        private static void OnDocumentOpened(object sender, DocumentOpenedEventArgs e)
        {
            try
            {
                lock (_lock)
                {
                    _epoch += 1;
                    try { SetDocIdentity(e.Document); } catch { }
                }
            }
            catch { }
        }

        private static void OnSynchronizing(
            object sender, DocumentSynchronizingWithCentralEventArgs e)
        {
            try
            {
                lock (_lock)
                {
                    _epoch += 1;
                    try { SetDocIdentity(e.Document); } catch { }
                }
            }
            catch { }
        }
    }
}
