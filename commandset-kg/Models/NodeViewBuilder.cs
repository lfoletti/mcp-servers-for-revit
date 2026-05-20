using System.Collections.Generic;
using System.Linq;
using RevitMCPKgCommandSet.Core;

namespace RevitMCPKgCommandSet.Models
{
    public static class NodeViewBuilder
    {
        public static KgNodeView From(Node node)
        {
            if (node == null) return null;
            var publicAttrs = new Dictionary<string, object>();
            foreach (var kvp in node.Attrs)
            {
                if (LifecycleAttrs.Reserved.Contains(kvp.Key)) continue;
                publicAttrs[kvp.Key] = kvp.Value;
            }

            return new KgNodeView
            {
                LlmId = node.LlmId,
                NodeType = node.NodeType,
                RevitId = node.RevitId,
                CreatedAtTurn = node.CreatedAtTurn,
                ModifiedAtTurn = node.ModifiedAtTurns,
                DeletedAtTurn = node.DeletedAtTurn,
                Attrs = publicAttrs,
            };
        }

        public static List<KgNodeView> FromMany(IEnumerable<Node> nodes) =>
            nodes.Select(From).ToList();
    }
}
