// The secondary checks of a molded part (user decision 2026-11-25): the insert pull test and the weight check are not in the default quote;
// the Cost Guide switches each on for the part (scenario overrides moldingInsertPullTest, moldingWeightCheck). Their USD rates are converted
// with the line, so a rupee quote charges them as a dollar one does.
//
// Run: npm run test -- secondary-checks

import { buildMoldingCommonInput } from '../../../../../../modules/bom-items/costing/plastic-molding/molding-input';
import { computeInjectionMoldedCostSummary, type InjectionMoldingCostInput } from '../../../../../../modules/bom-items/costing/plastic-molding/process/cost-injection-molding-engine';
import { buildInjectionMoldingRoute } from '../../../../../../modules/bom-items/costing/plastic-molding/process/routing-engine';
import { plasticMoldingCalculatorsByName } from '../../../../../../modules/bom-items/costing/plastic-molding/calculators/plastic-molding-calculator-spec';
import { resolveMoldingSecondaryChecks } from '../../../../../../modules/bom-items/costing/shared/physics/scenario-overrides';
import { realMaterialClamp, realPlasticReference, realPress, realResinInputs } from '../real-plastic-reference';

const REF = realPlasticReference();
const PRESS = realPress('Arburg Allrounder 420 C 1300 - 350');
const rate = (machineClass: string, usd: number, machineName: string | null, fx: number) =>
  ({ rate: usd * fx, labourRate: 30 * fx, source: 'mhr_database' as const, machineClass, machineName, commodityCode: null });

// An insert-molded ABS part with two inserts, priced in USD (fx 1) or rupees (fx 83).
const part = (fx: number, over: Partial<InjectionMoldingCostInput> = {}): InjectionMoldingCostInput => ({
  volume: 50_000, surfaceArea: 40_000, wallThicknessNominalMm: 2, materialGrade: 'ABS', materialCostPerKg: 3.046 * fx, materialDensityKgM3: 1040,
  materialSource: 'db', batchSize: 1000, family: 'plastic_molded', usdToLocal: fx, moldingSubtype: 'insert',
  mhrRate: rate('injection_molding', PRESS.mhrUsd, 'Arburg', fx), deburrRate: rate('deburring', 0, null, fx), inspectionRate: rate('cmm', 0, null, fx),
  machineClampTonnes: PRESS.maxTonnage, machineShotCapacityG: PRESS.shotCapacityGrams, pressTiming: PRESS.timing, goodPartYield: PRESS.goodPartYield,
  calculators: plasticMoldingCalculatorsByName(), materialClamp: realMaterialClamp('ABS'), realResinInputs: realResinInputs('ABS'), materialType: 'ABS',
  plasticReference: REF, location: 'USA', bboxMaxMm: 100, bboxMidMm: 100, bboxMinMm: 30, cadFaceCount: 900,
  signals: { projectedAreaMm2: 10_000, undercutCount: 0, insertCount: 2 },
  ...over,
});
const BOTH = { insertPullTest: true, weightCheck: true };
const processes = (r: ReturnType<typeof computeInjectionMoldedCostSummary>) => r.processLines.map((l) => l.process);

describe('the insert pull test and the weight check: only when the Cost Guide asks for them', () => {
  it('the route leaves both out unless switched on', () => {
    const ops = (checks?: typeof BOTH) => buildInjectionMoldingRoute({ insertCount: 2, materialGrade: 'ABS' } as never, 'insert', checks).operations.map((o) => o.id);
    expect(ops()).not.toEqual(expect.arrayContaining(['insert_inspection']));
    expect(ops()).not.toContain('weight_check');
    expect(ops(BOTH)).toEqual(expect.arrayContaining(['insert_inspection', 'weight_check']));
  });

  it('the default quote has neither line; switched on, each is costed with its calculator', () => {
    expect(processes(computeInjectionMoldedCostSummary(part(1)))).not.toEqual(expect.arrayContaining(['Insert Pull Test']));
    expect(processes(computeInjectionMoldedCostSummary(part(1)))).not.toContain('Weight Check');
    const checked = computeInjectionMoldedCostSummary(part(1, { secondaryChecks: BOTH }));
    expect(processes(checked)).toEqual(expect.arrayContaining(['Insert Pull Test', 'Weight Check']));
    expect(checked.processLines.find((l) => l.process === 'Insert Pull Test')?.calculatorName).toBe('Injection Molding - Insert Pull Test');
    expect(checked.processLines.find((l) => l.process === 'Weight Check')?.calculatorName).toBe('Injection Molding - Weight Check');
  });

  it('only a literal true in the scenario switches one on, and the common input carries it from the part', () => {
    expect(resolveMoldingSecondaryChecks({ moldingInsertPullTest: true, moldingWeightCheck: 'yes' })).toEqual({ insertPullTest: true, weightCheck: false });
    expect(resolveMoldingSecondaryChecks(null)).toEqual({ insertPullTest: false, weightCheck: false });
    const common = buildMoldingCommonInput({
      item: { volume: 1, scenarioOverrides: { moldingWeightCheck: true } }, summary: {} as never, grade: 'ABS', family: 'plastic_molded',
      material: {} as never, plasticReference: {} as never, location: 'USA', currencySymbol: '$', usdToLocal: 1, batchSize: 1,
      deburrRate: {} as never, inspectionRate: {} as never, annualVolume: null, productionLifeYears: 1, cavityCountOverride: null, calculators: {} as never,
    });
    expect(common.secondaryChecks).toEqual({ insertPullTest: false, weightCheck: true });
  });
});

describe('their USD rates are converted with the line', () => {
  const usd = computeInjectionMoldedCostSummary(part(1, { secondaryChecks: BOTH }));
  const inr = computeInjectionMoldedCostSummary(part(83, { secondaryChecks: BOTH }));
  const cost = (r: typeof usd, p: string) => r.processLines.find((l) => l.process === p)!;

  it.each(['Insert Pull Test', 'Weight Check'])('%s in rupees is its dollar cost x 83', (p) => {
    expect(cost(inr, p).totalCost).toBeCloseTo(cost(usd, p).totalCost * 83, 4);
  });

  it('the pull test\'s scrapped samples are kept in USD and in the line\'s currency', () => {
    expect(cost(inr, 'Insert Pull Test').otherCostPerPartUsd).toBeCloseTo(cost(usd, 'Insert Pull Test').otherCostPerPartUsd!, 9);
    expect(cost(inr, 'Insert Pull Test').otherCostPerPart).toBeCloseTo(cost(usd, 'Insert Pull Test').otherCostPerPartUsd! * 83, 6);
  });
});
