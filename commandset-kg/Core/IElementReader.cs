using System.Collections.Generic;

namespace RevitMCPKgCommandSet.Core
{
    public interface IElementReader
    {
        string ResolveNodeType(long elementId);

        Dictionary<string, object> ReadAttrs(long elementId);

        IEnumerable<EdgeSpec> ReadEdges(long elementId);
    }

    public enum EdgeDirection
    {
        Outgoing,
        Incoming,
    }

    public sealed class EdgeSpec
    {
        public long PeerElementId { get; }
        public string EdgeType { get; }
        public EdgeDirection Direction { get; }

        public EdgeSpec(long peerElementId, string edgeType, EdgeDirection direction = EdgeDirection.Outgoing)
        {
            PeerElementId = peerElementId;
            EdgeType = edgeType;
            Direction = direction;
        }
    }
}
