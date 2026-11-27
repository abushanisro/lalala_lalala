import { useQuery } from "@tanstack/react-query";

import { costAnalyticsApi } from "@/lib/api/cost-analytics";

import { useAuthEnabled } from "./useAuthEnabled";

/** The organization's should-cost in dashboard figures. Read-only, so nothing invalidates it but time. */
export function useCostAnalytics() {
  return useQuery({
    queryKey: ["cost-analytics"],
    queryFn: () => costAnalyticsApi.get(),
    enabled: useAuthEnabled(),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
