// Cavities by the lowest cost per part (user decision 2026-11-25). The user's case: a molded part at 2,000,000 a year for 5 years was costed at
// "1 cavity · reference default". Now, with no user count and a priced mold, every reference layout (layoutNumCav) a press holds is priced on
// that press, piece cost plus the mold's cost per part, and the cheapest is kept; a user count still wins.
//
// Run: npm run test -- cavity-search

import {
  computeInjectionMoldedCostSummary, costMoldOnPresses, type InjectionMoldingCostInput, type MoldingPress,
} from '../../../../../../modules/bom-items/costing/plastic-molding/process/cost-injection-molding-engine';
import { realMaterialClamp, realPlasticReference, realPress, realResinInputs } from '../real-plastic-reference';
import { plasticMoldingCalculatorsByName } from '../../../../../../modules/bom-items/costing/plastic-molding/calculators/plastic-molding-calculator-spec';

const REF = realPlasticReference();
const rate = (machineClass: string, rateUsd: number, machineName: string | null) =>
  ({ rate: rateUsd, labourRate: 30, source: 'mhr_database' as const, machineClass, machineName, commodityCode: null });
const press = (name: string, tieBars?: { x: number; y: number }): MoldingPress => {
  const p = realPress(name);
  return {
    mhrRate: rate('injection_molding', p.mhrUsd, name), machineClampTonnes: p.maxTonnage, machineShotCapacityG: p.shotCapacityGrams,
    pressTiming: p.timing, goodPartYield: p.goodPartYield, tieBarXMm: tieBars?.x ?? null, tieBarYMm: tieBars?.y ?? null,
  };
};
const SMALL = press('Kawaguchi KM50');
const LARGE = press('Kawaguchi KM280');

// A small ABS part (the material-gate fixture's geometry), no press: each test puts it on its presses.
const part = (over: Partial<InjectionMoldingCostInput> = {}): Omit<InjectionMoldingCostInput, keyof MoldingPress> => ({
  volume: 18_800, surfaceArea: 25_700, wallThicknessNominalMm: 1.5, batchSize: 500_000, family: 'plastic_molded', materialSource: 'db',
  materialGrade: 'Generic ABS', materialCostPerKg: 3.046, materialDensityKgM3: 1040,
  deburrRate: rate('deburring', 0, null), inspectionRate: rate('cmm', 0, null), calculators: plasticMoldingCalculatorsByName(),
  materialClamp: realMaterialClamp('ABS'), realResinInputs: realResinInputs('ABS'), materialType: 'ABS',
  materialStockForm: 'Granules', materialMatlState: 'Base Polymer', bboxMaxMm: 60, bboxMidMm: 40, bboxMinMm: 15, cadFaceCount: 120,
  plasticReference: REF, location: 'USA', signals: { projectedAreaMm2: 2400, undercutCount: 0 }, annualVolume: 2_000_000, productionLifeYears: 5,
  ...over,
});
const perPart = (r: ReturnType<typeof computeInjectionMoldedCostSummary>) => r.totalCost + (r.tooling?.moldCostPerPartUsd ?? 0);

describe('costMoldOnPresses: cavities by the lowest cost per part, mold included', () => {
  const high = costMoldOnPresses(part(), [LARGE]);
  const im = high.result.injectionMolding!;

  it('at 2,000,000 a year for 5 years it molds more than one cavity, and says why', () => {
    expect(im.cavityConstrainedBy).toBe('lowest_cost');
    expect(im.cavityCount).toBeGreaterThan(1);
    expect(REF.cavityLayouts).toContain(im.cavityCount);
  });

  it('lists every layout the press holds, cheapest first, the costed one marked: its cost is the lowest', () => {
    const options = im.cavityOptions!;
    expect(options.length).toBeGreaterThan(1);
    expect(options.filter((o) => o.chosen)).toHaveLength(1);
    expect(options[0]!).toMatchObject({ chosen: true, cavityCount: im.cavityCount, machineName: 'Kawaguchi KM280' });
    for (let i = 1; i < options.length; i++) expect(options[i]!.costPerPartUsd).toBeGreaterThanOrEqual(options[i - 1]!.costPerPartUsd);
    for (const o of options) expect(o.costPerPartUsd).toBeCloseTo(o.pieceCostUsd + (o.moldCostPerPartUsd ?? 0), 5);
  });

  it('each option is the engine run at that count: one cavity costs more per part than the count chosen', () => {
    const one = computeInjectionMoldedCostSummary({ ...part({ cavityCountOverride: 1 }), ...LARGE });
    expect(perPart(one)).toBeGreaterThan(perPart(high.result));
    const oneOption = im.cavityOptions!.find((o) => o.cavityCount === 1)!;
    expect(oneOption.costPerPartUsd).toBeCloseTo(perPart(one), 5);
  });

  it('never more cavities than the press holds closed and fills', () => {
    expect(im.clampRequiredT!).toBeLessThanOrEqual(LARGE.machineClampTonnes!);
    expect(im.shotRequiredG!).toBeLessThanOrEqual(LARGE.machineShotCapacityG!);
    for (const o of im.cavityOptions!) expect(o.clampMachineT).toBe(LARGE.machineClampTonnes);
  });

  it('a lower volume molds no more cavities than the higher one (the mold is spread over fewer parts)', () => {
    const low = costMoldOnPresses(part({ annualVolume: 1_000, batchSize: 1_000 }), [LARGE]).result.injectionMolding!;
    expect(low.cavityConstrainedBy).toBe('lowest_cost');
    expect(low.cavityCount).toBeLessThanOrEqual(im.cavityCount);
  });

  it('picks the press with the count: the small press holds fewer cavities, the large one is kept when it is cheaper per part', () => {
    const both = costMoldOnPresses(part(), [SMALL, LARGE]);
    const onSmall = costMoldOnPresses(part(), [SMALL]).result;
    expect(perPart(both.result)).toBeLessThanOrEqual(perPart(onSmall) + 1e-9);
    expect(perPart(both.result)).toBeLessThanOrEqual(perPart(high.result) + 1e-9);
    expect(both.press).toBe(perPart(onSmall) < perPart(high.result) ? 0 : 1);
  });

  it('the user count still wins, on the cheapest press that holds it', () => {
    const user = costMoldOnPresses(part({ cavityCountOverride: 2 }), [SMALL, LARGE]).result.injectionMolding!;
    expect(user).toMatchObject({ cavityCount: 2, cavityConstrainedBy: 'user' });
    expect(user.cavityOptions).toBeUndefined();
  });

  it('with no annual volume the mold is not priced: the reference default count, and the panel says why', () => {
    const r = costMoldOnPresses(part({ annualVolume: undefined }), [LARGE]).result.injectionMolding!;
    expect(r).toMatchObject({ cavityCount: REF.defaultNumCavities, cavityConstrainedBy: 'default' });
    expect(r.cavityNote).toContain('annual volume and a production life');
  });

  it('a mold the tooling cannot price (no CAD face count) is the default count, naming what the mold lacks', () => {
    const r = costMoldOnPresses(part({ cadFaceCount: null }), [LARGE]).result.injectionMolding!;
    expect(r).toMatchObject({ cavityCount: REF.defaultNumCavities, cavityConstrainedBy: 'default' });
    expect(r.cavityNote).toContain('the CAD face count');
  });

  it('a mold is hung from above: the layouts whose base is wider on its narrow side than the horizontal tie bars are not candidates', () => {
    const wide = costMoldOnPresses(part(), [{ ...LARGE, tieBarXMm: 10_000, tieBarYMm: 10 }]).result.injectionMolding!;
    expect(wide.cavityCount).toBe(im.cavityCount);
    const none = costMoldOnPresses(part(), [{ ...LARGE, tieBarXMm: 50, tieBarYMm: 50 }]).result.injectionMolding!;
    expect(none.cavityConstrainedBy).toBe('default');
    expect(none.cavityCount).toBe(REF.defaultNumCavities);
  });

  it('records the count it costed, so a replay of the saved line runs the same mold', () => {
    const line = high.result.processLines.find((l) => l.calculationSnapshot !== undefined)!;
    expect((line.calculationSnapshot!.inputs as { cavityCountOverride?: number }).cavityCountOverride).toBe(im.cavityCount);
    // As calculation-replay.ts recomputes it: the recorded inputs with the build's calculators and the reference.
    const replay = computeInjectionMoldedCostSummary({
      ...(line.calculationSnapshot!.inputs as unknown as InjectionMoldingCostInput), calculators: plasticMoldingCalculatorsByName(), plasticReference: REF, plasticReferenceMissing: [],
    });
    const replayed = replay.processLines.find((l) => l.calculationSnapshot !== undefined)!;
    expect(replay.injectionMolding!.cavityCount).toBe(im.cavityCount);
    expect(replayed.totalCost).toBeCloseTo(line.totalCost, 9);
  });
});
