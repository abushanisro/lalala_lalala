/**
 * Where a plastic-molding calculator input the engine works out from several facts came from, as the calculation it is (SourceRef of kind
 * 'calculation', each step with its own source and ref): the cavities per mold, the shot weight per part and the shot's melt volume, the inserts
 * per part, the cost of a part scrapped by a destructive test. Built where the engine works the value out, never by reading a trace back.
 */
import type { SourceRef } from '../../../dto/cost-breakdown.dto';
import type { InjectionMoldingBreakdown } from '../../../dto/cost-breakdown.dto';
import type { RunnerSystem } from '../clamp-force';
import { IM_RUNNER_SCRAP_PCT } from '../shot-size';
import { calc, inputStep, resultStep } from './plastic-cycle-time-seeds';
import { materialColumn, plasticLookup, plasticVariable, type MaterialRecord } from './plastic-input-sources';

const layoutRef = (n: number): SourceRef => plasticLookup('layoutNumCav', 'number_of_cavities', { number_of_cavities: n });

/**
 * The cavities per mold, by how they were chosen: the reference default (defaultNumCavities), the count set in the Cost Guide (a reference
 * layout), or the reference layout with the lowest cost per part with the mold spread over the annual volume and the production life.
 */
export function cavitiesRef(input: {
  count: number;
  basis: InjectionMoldingBreakdown['cavityConstrainedBy'];
  /** The Cost Guide's count, when the part has one. */
  override: number | null | undefined;
  defaultCount: number | null | undefined;
  layouts: readonly number[];
  annualVolume?: number | null;
  productionLifeYears?: number | null;
}): SourceRef {
  const { count: n } = input;
  const layouts = inputStep('Reference mold layouts', null, input.layouts.join(', '), 'layoutNumCav: the cavity counts a reference mold layout exists for',
    input.layouts.includes(n) ? layoutRef(n) : plasticLookup('layoutNumCav', 'number_of_cavities', null));
  if (input.basis === 'lowest_cost') {
    return calc('Cavities per Mold: the layout of the lowest cost per part', [
      layouts,
      inputStep('Annual volume', null, input.annualVolume ?? 'not set', "The part's annual volume (the mold is spread over it)", { kind: 'costingInput', field: 'annualVolume' }),
      inputStep('Production life', 'years', input.productionLifeYears ?? 'not set', "The part's production life", { kind: 'costingInput', field: 'productionLifeYears' }),
      resultStep('Cavities per Mold', null, n, 'The reference layout a press holds with the lowest piece cost + mold cost / (annual volume x production life)'),
    ]);
  }
  if (input.override != null && input.override === n) {
    return calc('Cavities per Mold: set in the Cost Guide', [
      inputStep('Cavities set for the part', null, n, 'Cost Guide: cavities per mold (scenario override cavityCount)'),
      layouts,
      resultStep('Cavities per Mold', null, n, 'The Cost Guide\'s count, when it is a reference mold layout'),
    ]);
  }
  if (input.defaultCount != null && input.defaultCount === n) return plasticVariable('defaultNumCavities');
  // A count with no reference to read (the reference not staged): one cavity, stated.
  return calc('Cavities per Mold', [resultStep('Cavities per Mold', null, n, 'No reference cavity default is staged: one cavity')]);
}

/** The melt-density column of the resin's record (raw_materials.im_density_of_melt_kg_m3, migration 831). */
const MELT_DENSITY_COLUMN = 'im_density_of_melt_kg_m3';

/**
 * The shot weight per part (the part's CAD volume at the resin's density, plus the runner and sprue share) and the melt volume of a full shot
 * (that weight over every cavity, at the resin's melt density), step by step. Null when the part has no volume.
 */
export function shotRefs(input: {
  volumeMm3: number;
  densityKgM3: number;
  /** The record the density was read from (its column), when it was read from one. */
  material: MaterialRecord | null | undefined;
  densityFromRecord: boolean;
  runner: RunnerSystem;
  shotWeightKg: number;
  cavities: number;
  cavitiesRef: SourceRef;
  meltDensityKgM3: number | null;
}): { resinPerPart: SourceRef; shotMeltVolume: SourceRef | null } | null {
  if (!(input.volumeMm3 > 0)) return null;
  const densityColumn = input.densityFromRecord ? input.material?.columns?.densityKgM3 ?? null : null;
  const runnerPct = input.runner === 'hot' ? 1 : IM_RUNNER_SCRAP_PCT;
  const netKg = (input.volumeMm3 / 1e9) * input.densityKgM3;
  const weightSteps = [
    inputStep('Part volume', 'mm3', input.volumeMm3, 'CAD: the solid\'s volume', { kind: 'cad', evidence: 'part_volume' }),
    inputStep('Material density', 'kg/m3', input.densityKgM3, input.densityFromRecord ? 'The resin\'s Raw Materials record' : 'The resin family\'s density (no record density on file)',
      densityColumn ? materialColumn(input.material, densityColumn) : undefined),
    resultStep('Part weight', 'kg', netKg, '{Part volume} / 1e9 * {Material density}'),
    inputStep('Runner and sprue share', '%', runnerPct, input.runner === 'hot'
      ? 'A hot runner: 1 % of the part (shot-size.ts)' : 'A cold runner: 8 % of the part (shot-size.ts, IM_RUNNER_SCRAP_PCT)'),
    resultStep('Shot Weight per Part', 'kg', input.shotWeightKg, '{Part weight} * (1 + {Runner and sprue share} / 100)'),
  ];
  const resinPerPart = calc('Resin per part: the shot weight per part', weightSteps, 'part_volume');
  const melt = input.meltDensityKgM3;
  const shotMeltVolume = melt != null && melt > 0
    ? calc('Shot Melt Volume: every cavity\'s shot, at the melt density', [
      ...weightSteps,
      inputStep('Cavities per Mold', null, input.cavities, 'The costed cavity count', input.cavitiesRef),
      inputStep('Melt Density', 'kg/m3', melt, 'The resin\'s Raw Materials record: density of melt', materialColumn(input.material, MELT_DENSITY_COLUMN)),
      resultStep('Shot Melt Volume', 'mm3', (input.shotWeightKg * input.cavities / melt) * 1e9, '{Shot Weight per Part} * {Cavities per Mold} / {Melt Density} * 1e9'),
    ], 'part_volume')
    : null;
  return { resinPerPart, shotMeltVolume };
}

/** Where each insert of the part is defined, for the inserts per part a test or a loading counts. */
export interface InsertBasis { name: string; perPart: number; source: 'bom' | 'cost_guide' | 'cad' }

const INSERT_FROM: Record<InsertBasis['source'], string> = {
  bom: 'A BOM child of the part (its quantity)',
  cost_guide: 'The Cost Guide\'s insert count',
  cad: 'CAD: the insert candidates the analysis recognised (bosses and holes sized for an insert)',
};

/** The inserts per part as their sum over the part's inserts, each with where it is defined; the CAD's insert candidates when none is listed. */
export function insertsRef(count: number, inserts: readonly InsertBasis[] | null | undefined): SourceRef {
  const listed = inserts && inserts.length > 0 ? inserts : [{ name: 'Insert candidates (CAD)', perPart: count, source: 'cad' as const }];
  return calc('Inserts per Part', [
    ...listed.map((i) => inputStep(i.name, null, i.perPart, INSERT_FROM[i.source])),
    resultStep('Inserts per Part', null, count, 'The sum over the part\'s inserts'),
  ]);
}

/** The cost a sample scrapped by a destructive test had reached: the material and the lines before the test, in USD. */
export function testedPartRef(input: { materialCost: number; lines: ReadonlyArray<{ process: string; totalCost: number }>; usdToLocal: number; usd: number }): SourceRef {
  return calc('Tested Part Cost: what the scrapped sample had cost', [
    inputStep('Material per part', null, input.materialCost, 'The shot weight per good part at the resin price (the quote\'s material cost)'),
    ...input.lines.map((l) => inputStep(`${l.process} per part`, null, l.totalCost, `The ${l.process} line's cost per part`)),
    inputStep('Quote currency per USD', null, input.usdToLocal, input.usdToLocal === 1 ? 'The quote is in USD' : 'The exchange rate the quote is converted at'),
    resultStep('Tested Part Cost', 'USD', input.usd, '({Material per part} + the lines\' costs) / {Quote currency per USD}'),
  ]);
}
