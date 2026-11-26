/**
 * The panel an input's eye opens, read for its SourceRef wherever a calculation trace is shown outside the Edit Process Cost dialog (the
 * Cost panel's cycle view, a calculation trace): the reference table, variable, machine or material record with the row outlined, the
 * calculation step by step, the calculator's table of defaults, or the part's costing inputs. The dialog opens the same panels
 * (ProcessCostDialog handleViewLookupTable). Null for a ref that opens no table (CAD faces: the model lights those).
 */
import type { processesApi } from '@/lib/api/processes';
import {
  calculationPanel, calculatorFieldPanel, costingInputPanel, isSheetMetalLibraryTable, lookupPanel, opensTable, recordPanel, smTablePanel, variablePanel,
  type ResolvedCostingInputsLike, type SourcePanel, type SourceRef,
} from '@/lib/calculators/input-source';

type ProcessesApi = typeof processesApi;

/** A sheet-metal table an smTable ref names, from the endpoint that serves it: a machine-library table's own, else the sm_lookup_* passthrough. */
function fetchSheetMetalTable(api: ProcessesApi, table: string) {
  if (!isSheetMetalLibraryTable(table)) return api.getSmLookupTableByName(table);
  switch (table) {
    case 'turret_machines': return api.getTurretMachinesTable();
    case 'waterjet_machines': return api.getWaterjetMachinesTable();
    case 'deslag_allowance': return api.getDeslagAllowanceTable();
    case 'stroke_rate_factor': return api.getStrokeRateFactorTable();
    case 'press_brake_machines': return api.getPressBrakeMachinesTable();
  }
}

export async function loadSourcePanel(
  ref: SourceRef | undefined, value: unknown, resolvedInputs?: ResolvedCostingInputsLike | null,
): Promise<SourcePanel | null> {
  if (!ref || !opensTable(ref)) return null;
  // Built from the ref alone: no request.
  if (ref.kind === 'calculation') return calculationPanel(ref);
  if (ref.kind === 'calculatorField') return calculatorFieldPanel(ref);
  if (ref.kind === 'costingInput') return costingInputPanel(ref, resolvedInputs, value);
  const api = (await import('@/lib/api/processes')).processesApi;
  switch (ref.kind) {
    case 'variable': return variablePanel(ref, (await api.getDomainVariables(ref.domain)).variables);
    case 'lookup': return lookupPanel(ref, await api.getReferenceLookup(ref.domain, ref.table), value);
    case 'machine': return recordPanel(await api.getRecordSourceTable('machine', ref.machineId, ref.column));
    case 'material': return recordPanel(await api.getRecordSourceTable('material', ref.materialId, ref.column));
    case 'smTable': return smTablePanel(ref, await fetchSheetMetalTable(api, ref.table), value);
    default: return null;
  }
}
