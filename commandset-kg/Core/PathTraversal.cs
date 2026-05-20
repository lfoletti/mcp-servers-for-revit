using System.Collections.Generic;

namespace RevitMCPKgCommandSet.Core
{
    public sealed class TraverseStep
    {
        public string EdgeType { get; set; }
        public EdgeDirection Direction { get; set; }
    }

    public static class PathTraversal
    {
        public static HashSet<string> Walk(
            ProjectKg kg,
            string startLlmId,
            IEnumerable<TraverseStep> path)
        {
            var result = new HashSet<string>();
            if (kg == null || string.IsNullOrEmpty(startLlmId)) return result;
            if (!kg.HasNode(startLlmId)) return result;

            var current = new HashSet<string> { startLlmId };

            if (path == null) { result.UnionWith(current); return result; }

            foreach (var step in path)
            {
                if (step == null || string.IsNullOrEmpty(step.EdgeType))
                    return new HashSet<string>();

                var next = new HashSet<string>();
                foreach (var id in current)
                {
                    if (step.Direction == EdgeDirection.Outgoing)
                    {
                        foreach (var e in kg.OutgoingEdges(id, step.EdgeType))
                            next.Add(e.Dst);
                    }
                    else
                    {
                        foreach (var e in kg.IncomingEdges(id, step.EdgeType))
                            next.Add(e.Src);
                    }
                }
                current = next;
                if (current.Count == 0) return current;
            }

            return current;
        }
    }
}
