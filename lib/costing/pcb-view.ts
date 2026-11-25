import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';

export type PcbSummary = NonNullable<CostSummaryDto['pcb']>;
export type PcbFact = PcbSummary['board']['layers'];

/** The Cost Guide keys of a printed circuit board (backend pcb-cost.service.ts PCB_KEYS). */
export const PCB_SCENARIO_KEYS = {
  route: 'pcbRoute', layers: 'pcbLayers', thickness: 'pcbThicknessMm', outerOz: 'pcbOuterCopperOz', innerOz: 'pcbInnerCopperOz', finish: 'pcbFinish',
  maskSides: 'pcbSolderMaskSides', legendSides: 'pcbLegendSides', testPoints: 'pcbTestPoints', stackup: 'pcbStackupPreference', viaPlugging: 'pcbViaPlugging',
  assembly: 'pcbAssembly', thtSolder: 'pcbThtSolder', assemblyTest: 'pcbAssemblyTest',
} as const;

export type PcbAssemblyView = NonNullable<PcbSummary['assembly']>;

/** Whether the board is assembled (backend pcb-assembly.ts PCBA_MODES): Auto includes it when the board has parts to place or BOM children. */
export const PCB_ASSEMBLY_OPTIONS = [
  { key: 'include', label: 'Include (board + assembly)' },
  { key: 'bare', label: 'Bare board only' },
] as const;

/** Through-hole soldering (backend PCBA_THT_SOLDERS): Auto takes the cheapest that can solder the board. */
export const PCB_THT_SOLDER_OPTIONS = [
  { key: 'wave', label: 'Wave solder' },
  { key: 'selective', label: 'Selective solder' },
  { key: 'hand', label: 'Hand solder' },
] as const;

/** The assembly test (backend PCBA_TESTS): Auto takes the cheaper over the job, the in-circuit fixture included. */
export const PCB_ASSEMBLY_TEST_OPTIONS = [
  { key: 'ict', label: 'In-circuit test (fixture)' },
  { key: 'flying_probe', label: 'Flying probe' },
] as const;

/** A Cost Guide choice that is one of its options, or '' (Auto). */
export function choiceOf(overrides: Record<string, unknown> | null | undefined, key: string, options: readonly { key: string }[]): string {
  const v = overrides?.[key];
  return typeof v === 'string' && options.some((o) => o.key === v) ? v : '';
}

/** "Processes included", one line a group: "SMT top: Stencil Print, ... (auto)". */
export function processesIncluded(a: PcbAssemblyView | null | undefined): string[] {
  return (a?.processes ?? []).map((p) => `${p.group}: ${p.steps.join(', ')}${p.basis === 'user' ? ' (set)' : ''}`);
}

/** The four fabrication routes (backend pcb-route.ts PCB_ROUTES). */
export const PCB_ROUTE_OPTIONS = [
  { key: 'router_flying_probe', label: 'Routed, flying probe test' },
  { key: 'router_bed_of_nails', label: 'Routed, bed of nails test' },
  { key: 'stamp_flying_probe', label: 'Stamped, flying probe test' },
  { key: 'stamp_bed_of_nails', label: 'Stamped, bed of nails test' },
] as const;

/** The surface finishes (backend pcb-part.ts PCB_FINISHES): the board's specification, never switched to a cheaper one. */
export const PCB_FINISH_OPTIONS = [
  { key: 'hasl', label: 'HASL (hot air solder leveling)' },
  { key: 'enig', label: 'ENIG (nickel, immersion gold)' },
  { key: 'osp', label: 'OSP (organic preservative)' },
] as const;

/** The copper weights the reference prices (oz/ft²). */
export const PCB_COPPER_OZ = [0.5, 1, 1.5, 2] as const;

/** A part whose Process is PCB. */
export function isPcbItem(item: Pick<BOMItem, 'scenarioOverrides'> | null | undefined): boolean {
  return (item?.scenarioOverrides as Record<string, unknown> | null | undefined)?.processGroup === 'PCB';
}

/** The route set in the Cost Guide, or null: the engine quotes the cheapest complete one. */
export function pcbRouteOf(overrides: Record<string, unknown> | null | undefined): string | null {
  const v = overrides?.[PCB_SCENARIO_KEYS.route];
  return typeof v === 'string' && PCB_ROUTE_OPTIONS.some((o) => o.key === v) ? v : null;
}

/** Where a board value came from, as the Cost Guide says it. */
export function basisLabel(basis: PcbFact['basis']): string {
  return {
    board_files: 'measured from the board files', cad_model: 'measured from the 3D model', cost_guide: 'set in the Cost Guide',
    reference_default: 'reference default', derived: 'derived',
  }[basis];
}

/** A number set in the Cost Guide, or null when none is set. */
export function numberOf(overrides: Record<string, unknown> | null | undefined, key: string): number | null {
  const raw = overrides?.[key];
  const v = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(v) ? v : null;
}
