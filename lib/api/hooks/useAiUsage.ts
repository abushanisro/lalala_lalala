import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { onAiUsage } from "@/lib/ai/usage-events";
import { aiUsageApi } from "@/lib/api/ai-usage";

import { useAuthEnabled } from "./useAuthEnabled";

const KEY = ["ai-usage"] as const;
/** Other members spend AI too, and so do other tabs: the figures are read again this often while the page is in view. */
const POLL_MS = 15_000;

/**
 * The organization's AI tokens, kept current: read again the moment anything in this window spends AI (notifyAiUsage), when the
 * window comes back into view, and on a timer for what other members and tabs spend.
 */
export function useAiUsage() {
  const queryClient = useQueryClient();
  useEffect(() => onAiUsage(() => { void queryClient.invalidateQueries({ queryKey: KEY }); }), [queryClient]);
  return useQuery({
    queryKey: KEY,
    queryFn: () => aiUsageApi.get(),
    enabled: useAuthEnabled(),
    staleTime: 5_000,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });
}
