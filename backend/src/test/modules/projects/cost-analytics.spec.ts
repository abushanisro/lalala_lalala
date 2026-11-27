import { driversOf, PART_ROWS_MAX, reportingCurrencyOf, summariseCosts, type AnalyticsAmount, type AnalyticsItem } from '../../../modules/projects/cost-analytics';

// 1 USD = 80 INR; nothing on file for XXX.
const PER_USD = new Map([['USD', 1], ['INR', 80]]);
const rate = (from: string, to: string): number | null => {
  const f = PER_USD.get(from), t = PER_USD.get(to);
  return f === undefined || t === undefined ? null : t / f;
};
const item = (id: string, over: Partial<AnalyticsItem> = {}): AnalyticsItem =>
  ({ id, bomId: 'bom', name: id, partNumber: null, annualVolume: 1000, weightKg: 2, scenarioOverrides: null, ...over });
let next = 0;
const record = (itemId: string, kind: AnalyticsAmount['kind'], amount: number, currency: string | null = 'INR', over: Partial<AnalyticsAmount> = {}): AnalyticsAmount =>
  ({ itemId, ref: `r${next++}`, kind, amount, currency, basis: 'local', ...over });
const boms = [{ id: 'bom', name: 'Module', projectId: 'p', projectName: 'Project' }];
const run = (items: AnalyticsItem[], amounts: AnalyticsAmount[]) => summariseCosts({ items, boms, amounts, rate });
const asked = (amount: number, currency = 'INR') => ({ askPrice: { amount, currency } });

describe('reportingCurrencyOf', () => {
  it('is the currency of the factory costs when they share one, though the material price list is in another', () => {
    expect(reportingCurrencyOf([record('a', 'process', 500, 'INR'), record('a', 'raw_material', 10, 'USD')])).toBe('INR');
  });

  it('is the one currency of every record when there is no process cost, and USD when the factories cost in several', () => {
    expect(reportingCurrencyOf([record('a', 'raw_material', 10, 'EUR')])).toBe('EUR');
    expect(reportingCurrencyOf([record('a', 'process', 5, 'INR'), record('b', 'process', 5, 'USD')])).toBe('USD');
    expect(reportingCurrencyOf([])).toBe('USD');
  });

  it('is not decided by records that carry no money or whose currency cannot be trusted', () => {
    expect(reportingCurrencyOf([record('a', 'process', 500, 'INR'), record('a', 'process', 0, 'USD'),
      record('b', 'process', 9, 'EUR', { basis: 'legacy_unverified' })])).toBe('INR');
  });
});

describe('cost drivers', () => {
  // A real machining record: 30 s of set-up over the batch, 4 998 s of cycle at 23.84 (machine) + 47.36 (labour) an hour.
  const milling = record('a', 'process', 98.871, 'USD', { setupCost: 0.014, cycleCost: 98.857, machineRate: 23.84, labourRate: 47.36 });
  // A real bar-stock record: 35.839 kg bought at 7.438 a kg, 10.283 kg left in the part, 5 % overhead.
  const stock = record('a', 'raw_material', 279.9, 'USD', { unitPrice: 7.438, grossUsage: 35.839, netUsage: 10.283, grossCost: 266.57, overheadCost: 13.33 });

  it('splits a process record into set-up and cycle cost, and the cycle cost into machine and labour by their rates', () => {
    const d = driversOf(milling);
    expect(d.setup).toBe(0.014);
    expect(d.machineTime).toBeCloseTo(98.857 * 23.84 / 71.2, 6);
    expect(d.labourTime).toBeCloseTo(98.857 * 47.36 / 71.2, 6);
    expect(Object.values(d).reduce((sum, v) => sum + v, 0)).toBeCloseTo(98.871, 6);
  });

  it('splits a material record into the metal left in the part, the stock removed, and the overhead', () => {
    const d = driversOf(stock);
    expect(d.materialInPart).toBeCloseTo(10.283 * 7.438, 6);                    // 76.49
    expect(d.materialRemoved).toBeCloseTo(266.57 - 10.283 * 7.438, 6);          // 190.08: 71 % of the bar is machined away
    expect(d.materialOverhead).toBe(13.33);
    expect(Object.values(d).reduce((sum, v) => sum + v, 0)).toBeCloseTo(279.9, 6);
  });

  it('takes the scrap credit off the stock removed', () => {
    const d = driversOf(record('a', 'raw_material', 90, 'USD', { unitPrice: 10, grossUsage: 10, netUsage: 4, grossCost: 100, reclaimValue: 15, overheadCost: 5 }));
    expect(d).toMatchObject({ materialInPart: 40, materialRemoved: 45, materialOverhead: 5 });
  });

  it('does not split a record whose parts do not add up to its amount, or that states none', () => {
    expect(driversOf(record('a', 'process', 100, 'USD', { setupCost: 1, cycleCost: 50 }))).toEqual({ processOther: 100 });
    expect(driversOf(record('a', 'process', 100))).toEqual({ processOther: 100 });
    expect(driversOf(record('a', 'process', 100, 'USD', { setupCost: 1, cycleCost: 99 }))).toEqual({ setup: 1, processScrap: 0, processOther: 99 });   // no rates
    expect(driversOf(record('a', 'raw_material', 100, 'USD', { unitPrice: 10, grossUsage: 5, netUsage: 4, grossCost: 80 }))).toEqual({ materialOther: 100 });
    expect(driversOf(record('a', 'tooling', 7))).toEqual({ tooling: 7 });
  });

  it('adds up to the should-cost in the reporting currency, the largest driver first', () => {
    const out = summariseCosts({ items: [item('a')], boms, rate, amounts: [
      { ...milling, currency: 'INR' }, stock, record('a', 'tooling', 20), record('a', 'process', 50),
    ] });
    expect(out.currency).toBe('INR');
    expect(out.drivers.map(d => d.key)).toEqual(['materialRemoved', 'materialInPart', 'materialOverhead', 'labourTime', 'processOther', 'machineTime', 'tooling', 'setup']);
    expect(out.drivers.reduce((sum, d) => sum + d.unitCost, 0)).toBeCloseTo(out.totals.unitCost, 6);
    expect(out.drivers.reduce((sum, d) => sum + d.annualSpend, 0)).toBeCloseTo(out.totals.annualSpend, 3);
    expect(out.drivers[0].unitCost).toBeCloseTo((266.57 - 10.283 * 7.438) * 80, 6);          // converted at the record's own rate
  });
});

describe('summariseCosts', () => {
  it('adds a part from its saved records, each converted once, and keeps the elements apart', () => {
    const out = run([item('block')], [
      record('block', 'process', 400), record('block', 'process', 100), record('block', 'raw_material', 5, 'USD'), record('block', 'tooling', 20),
    ]);
    expect(out.currency).toBe('INR');
    expect(out.fxRates).toEqual({ USD: 80 });
    expect(out.parts[0]).toMatchObject({
      id: 'block', bomName: 'Module', projectId: 'p', unitCost: 920, annualVolume: 1000, annualSpend: 920_000,
      elements: { rawMaterial: 400, process: 500, tooling: 20, packagingLogistics: 0, procuredParts: 0 },
    });
    expect(out.totals.elements.rawMaterial).toEqual({ unitCost: 400, annualSpend: 400_000 });
    expect(out.totals).toMatchObject({ unitCost: 920, annualSpend: 920_000 });
    expect(out.coverage).toMatchObject({ parts: 1, costed: 1, notCosted: 0, unresolved: 0, withAnnualVolume: 1 });
  });

  it('leaves a part out of every sum when its money cannot be trusted, and says how many', () => {
    const out = run([item('good'), item('legacy'), item('no-rate'), item('empty')], [
      record('good', 'process', 100),
      record('legacy', 'process', 100), record('legacy', 'raw_material', 50, 'USD', { basis: 'legacy_unverified' }),
      record('no-rate', 'process', 100), record('no-rate', 'raw_material', 50, 'XXX'),
    ]);
    expect(out.coverage).toMatchObject({ parts: 4, costed: 1, unresolved: 2, notCosted: 1 });
    expect(out.totals.unitCost).toBe(100);
    expect(out.parts.map(p => p.id)).toEqual(['good']);
  });

  it('counts a part with no annual volume as costed and adds nothing for it to the annual figures', () => {
    const out = run([item('a'), item('b', { annualVolume: null })], [record('a', 'process', 10), record('b', 'process', 30)]);
    expect(out.totals).toMatchObject({ unitCost: 40, annualSpend: 10_000 });
    expect(out.coverage).toMatchObject({ costed: 2, withAnnualVolume: 1 });
    expect(out.parts.find(p => p.id === 'b')).toMatchObject({ annualSpend: null, annualVolume: null });
  });

  it('measures each ask price against the should-cost, and does not let a part priced below it hide the opportunity', () => {
    const out = run([
      item('high', { scenarioOverrides: asked(150) }),                       // asked 150, should cost 100
      item('low', { scenarioOverrides: asked(1, 'USD'), annualVolume: 500 }), // asked 80, should cost 100
      item('unpriced'),
      item('odd', { scenarioOverrides: asked(5, 'XXX') }),
    ], ['high', 'low', 'unpriced', 'odd'].map(id => record(id, 'process', 100)));
    expect(out.parts.find(p => p.id === 'high')).toMatchObject({ askPrice: 150, gap: 50, annualGap: 50_000 });
    expect(out.parts.find(p => p.id === 'low')).toMatchObject({ askPrice: 80, gap: -20, annualGap: -10_000 });
    expect(out.parts.find(p => p.id === 'unpriced')).toMatchObject({ askPrice: null, gap: null, annualGap: null });
    expect(out.savings).toEqual({ parts: 2, askAnnual: 190_000, shouldCostAnnual: 150_000, opportunityAnnual: 50_000, partsAboveShouldCost: 1,
      partsBelowShouldCost: 1, shortfallAnnual: 10_000 });
    expect(out.coverage).toMatchObject({ withAskPrice: 2, askPriceUnconverted: 1 });
    expect(out.boms[0]).toMatchObject({ askAnnual: 190_000, askShouldCostAnnual: 150_000 });
  });

  it('groups process cost by process and by machine, with the machine hours a year of running', () => {
    const out = run([item('a'), item('b', { annualVolume: 2000 })], [
      record('a', 'process', 60, 'INR', { processGroup: 'Machining', machine: 'Mill', cycleTimeS: 360 }),
      record('a', 'process', 5, 'INR', { processGroup: 'Machining', machine: 'Deburr', cycleTimeS: 36 }),
      record('b', 'process', 20, 'INR', { processGroup: 'Sheet Metal', machine: 'Mill', cycleTimeS: 90 }),
    ]);
    expect(out.processGroups).toEqual([
      { name: 'Machining', parts: 1, records: 2, unitCost: 65, annualSpend: 65_000, annualHours: 110 },
      { name: 'Sheet Metal', parts: 1, records: 1, unitCost: 20, annualSpend: 40_000, annualHours: 50 },
    ]);
    expect(out.machines[0]).toEqual({ name: 'Mill', parts: 2, records: 2, unitCost: 80, annualSpend: 100_000, annualHours: 150 });
    expect(out.totals.annualHours).toBe(160);
    expect(out.parts.find(p => p.id === 'a')?.cycleTimeS).toBe(396);
  });

  it('groups material cost by material, with the stock bought against the material left in the parts', () => {
    const out = run([item('a'), item('b')], [
      record('a', 'raw_material', 2, 'USD', { material: 'Aluminum 6061', grossKg: 10, netKg: 4 }),
      record('b', 'raw_material', 1, 'USD', { material: 'Aluminum 6061', grossKg: 5, netKg: 2 }),
      record('b', 'raw_material', 3, 'USD', { material: 'Steel 416' }),                          // no weights on the record
    ]);
    expect(out.currency).toBe('USD');
    expect(out.materials).toEqual([
      { name: 'Aluminum 6061', parts: 2, unitCost: 3, annualSpend: 3000, grossKg: 15, netKg: 6 },
      { name: 'Steel 416', parts: 1, unitCost: 3, annualSpend: 3000, grossKg: 0, netKg: 0 },
    ]);
    expect(out.totals).toMatchObject({ grossKg: 15, netKg: 6 });
  });

  it('gives each BOM its parts, how many are costed and what they cost, and drops a BOM with no parts', () => {
    const out = summariseCosts({
      items: [item('a', { bomId: 'one' }), item('b', { bomId: 'one' }), item('c', { bomId: 'two' })],
      boms: [{ id: 'one', name: 'One', projectId: 'p', projectName: 'P' }, { id: 'two', name: 'Two', projectId: 'p', projectName: 'P' },
        { id: 'none', name: 'Empty', projectId: 'p', projectName: 'P' }],
      amounts: [record('a', 'process', 10), record('c', 'process', 40), record('c', 'raw_material', 1, 'USD')],
      rate,
    });
    expect(out.boms.map(b => ({ id: b.id, parts: b.parts, costed: b.costed, unitCost: b.unitCost, annualSpend: b.annualSpend,
      rawMaterial: b.elements.rawMaterial, process: b.elements.process }))).toEqual([
      { id: 'two', parts: 1, costed: 1, unitCost: 120, annualSpend: 120_000, rawMaterial: 80, process: 40 },
      { id: 'one', parts: 2, costed: 1, unitCost: 10, annualSpend: 10_000, rawMaterial: 0, process: 10 },
    ]);
  });

  it('dates a part by its first cost record and lists the parts with the largest annual spend first, up to the row limit', () => {
    const many = Array.from({ length: PART_ROWS_MAX + 3 }, (_, i) => item(`p${i}`));
    const out = run(many, many.flatMap((p, i) => [
      record(p.id, 'process', i + 1, 'INR', { createdAt: '2026-11-20T10:00:00Z' }),
      record(p.id, 'raw_material', 0, 'INR', { createdAt: '2026-11-18T09:00:00Z' }),
    ]));
    expect(out.parts).toHaveLength(PART_ROWS_MAX);
    expect(out.partsOmitted).toBe(3);
    expect(out.parts[0]).toMatchObject({ id: `p${PART_ROWS_MAX + 2}`, costedAt: '2026-11-18T09:00:00Z' });
    expect(out.coverage.costed).toBe(PART_ROWS_MAX + 3);                       // the totals cover the rows left out
    expect(out.totals.unitCost).toBe(((PART_ROWS_MAX + 3) * (PART_ROWS_MAX + 4)) / 2);
  });
});
