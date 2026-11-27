import { useMutation, useQuery } from "@tanstack/react-query";

import { fillSimulationApi, type FillSimulationRequest } from "@/lib/api/fill-simulation";

function required(id: string | undefined): string {
  if (!id) throw new Error("This needs a BOM item id");
  return id;
}

/** The part's fill mesh (no gate yet): what the engineer clicks a gate on. Fetched once the workspace is open; the mesh of a file does not change. */
export function useFillMesh(bomItemId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["bom-items", bomItemId, "fill-mesh"],
    queryFn: () => fillSimulationApi.run(required(bomItemId), {}),
    enabled: enabled && !!bomItemId,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** What the reference data recommends for the part's grade (melt temperature, pressure, flow length ratio): the setup starts from it. */
export function useFillSimulationInputs(bomItemId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["bom-items", bomItemId, "fill-simulation-inputs"],
    queryFn: () => fillSimulationApi.inputs(required(bomItemId)),
    enabled: enabled && !!bomItemId,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** One fill simulation run. Nothing is stored server-side, so nothing is invalidated. */
export function useRunFillSimulation(bomItemId: string | undefined) {
  return useMutation({
    mutationFn: (body: FillSimulationRequest) => fillSimulationApi.run(required(bomItemId), body),
  });
}
