using System.Collections.Generic;

namespace RevitMCPKgCommandSet.Core
{
    public static class EdgeTypes
    {
        public const string AtLevel = "at_level";
        public const string IsType = "is_type";
        public const string Hosts = "hosts";
        public const string BoundedBy = "bounded_by";
        public const string ConnectsAt = "connects_at";
        public const string DerivedFrom = "derived_from";

        public static readonly HashSet<string> All = new HashSet<string>
        {
            AtLevel, IsType, Hosts, BoundedBy, ConnectsAt, DerivedFrom,
        };
    }
}
