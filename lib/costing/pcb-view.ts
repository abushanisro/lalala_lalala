import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';

export type PcbSummary = NonNullable<CostSummaryDto['pcb']>;
export type PcbFact = PcbSummary['board']['layers'];

/** The Cost Guide keys of a printed circuit board (backend pcb-cost.service.ts PCB_KEYS). */
export const PCB_SCENARIO_KEYS = {
  route: 'pcbRoute', layers: 'pcbLayers', thickness: 'pcbThicknessMm', outerOz: 'pcbOuterCopperOz', innerOz: 'pcbInnerCopperOz', finish: 'pcbFinish',
  maskSides: 'pcbSolderMaskSides', legendSides: 'pcbLegendSides', testPoints: 'pcbTestPoints', stackup: 'pcbStackupPreference', viaPlugging: 'pcbViaPlugging',
} as const;

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
