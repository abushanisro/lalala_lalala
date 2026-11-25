// What a cutting process's feed table holds for a material (SheetMetalLookupService.getCutFeedCoverage): the gate a plate cut asks before it
// is priced. The feed getters read the row nearest a thickness and price every grade that is not stainless at the steel rows, which is right
// for sheet; a machined part's plate (far thicker, of any material) is priced only where the table lists the material at that thickness.
// The rows below are shaped as the staged tables are; the ranges are those of the staged data.
import { SheetMetalLookupService, thermalCutMaterial } from '../../../../../../modules/bom-items/costing/sheet-metal/lookup/sheet-metal-lookup.service';
import { PlasmaCuttingEngine } from '../../../../../../modules/bom-items/costing/sheet-metal/process/plasma-cutting-engine';

const LASER = [
  ...[1, 12, 50].map((t) => ({ material: 'Aluminium', laser_technology: 'fiber', thickness_mm: t, laser_power_w: 6000 })),
  ...[1, 60].map((t) => ({ material: 'Carbon Steel', laser_technology: 'fiber', thickness_mm: t, laser_power_w: 6000 })),
  ...[0.25, 25.4].map((t) => ({ material: 'Carbon Steel', laser_technology: 'co2', thickness_mm: t, laser_power_w: 4000 })),
];
const WATERJET = [3, 12, 32].flatMap((t) => ['Aluminium', 'Carbon Steel', 'Stainless Steel'].map((material) => ({ material, thickness_mm: t })));
const cutRate = (cut: string, materialTypeName: string, thicknessMm: number) => ({ key: `nestingCutRate:${materialTypeName}:${cut}:${thicknessMm}`, raw: { materialTypeName, thicknessMm } });
const NESTING = [
  ...[6.4, 77].flatMap((t) => ['Steel', 'Cast Iron', 'Stainless Steel'].map((m) => cutRate('PlasmaCut', m, t))),
  ...[3, 305].flatMap((t) => ['Steel', 'Cast Iron', 'Stainless Steel'].map((m) => cutRate('OxyFuelCut', m, t))),
];

// The machining workbook's plasma curve as migration 1137 stages it (tblThermalCutFeed: memory/machining/workbook), its plasma rows.
const WORKBOOK_PLASMA = [[3, 2400, 1], [6, 2200, 1.5], [12, 1800, 3], [25, 1200, 5], [40, 400, 8]]
  .map(([ThicknessMm, FeedMmPerMin, KerfMm]) => ({ Machine: 'Plasma Cutting Machine', ThicknessMm, FeedMmPerMin, KerfMm }));
const MACHINING_REFERENCE = [{ key: 'tblThermalCutFeed', raw: [...WORKBOOK_PLASMA, { Machine: 'Laser 2 Axis', ThicknessMm: 2, FeedMmPerMin: 4200, KerfMm: 0.6 }] }];

/** A database that answers the three tables with their rows, by the equality and LIKE filters the service asks. */
function fakeDatabase() {
  const query = (table: string) => {
    const eq: Record<string, unknown> = {};
    let like = '';
    const builder: any = {
      select: () => builder, not: () => builder,
      eq: (column: string, value: unknown) => { eq[column] = value; return builder; },
      like: (_column: string, pattern: string) => { like = pattern; return builder; },
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        resolve({ data: matching(), error: null });
      },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
    };
    const matching = () => {
      const rows: Record<string, unknown>[] = table === 'sm_lookup_laser_cut' ? LASER : table === 'sm_lookup_waterjet_cut' ? WATERJET
        : table === 'machining_reference_data' ? MACHINING_REFERENCE : NESTING;
      const pattern = new RegExp(`^${like.replace(/%/g, '.*')}$`);
      return rows.filter((r) => Object.entries(eq).every(([c, v]) => !(c in r) || r[c] === v) && (!like || pattern.test(String(r.key))));
    };
    return builder;
  };
  return { getPrivilegedClient: () => ({ from: query }) } as any;
}
const coverage = (machineClass: Parameters<SheetMetalLookupService['getCutFeedCoverage']>[0], grade: string | null) =>
  new SheetMetalLookupService(fakeDatabase()).getCutFeedCoverage(machineClass, grade);

describe('SheetMetalLookupService.getCutFeedCoverage', () => {
  it('aluminium: the fiber laser and the waterjet list it, plasma at the workbook\'s curve; the CO2 laser and oxyfuel do not', async () => {
    const grade = 'Aluminum, ANSI 6061';
    expect(await coverage('fiber_laser', grade)).toEqual({ table: 'sm_lookup_laser_cut (fiber)', material: 'Aluminium', minThicknessMm: 1, maxThicknessMm: 50 });
    expect(await coverage('waterjet', grade)).toEqual({ table: 'sm_lookup_waterjet_cut', material: 'Aluminium', minThicknessMm: 3, maxThicknessMm: 32 });
    expect(await coverage('co2_laser', grade)).toEqual({ table: 'sm_lookup_laser_cut (co2)', material: null, minThicknessMm: null, maxThicknessMm: null });
    // The plasma rows are ferrous only: aluminium is not read as steel, it is cut at the machining workbook's plasma curve (3 - 40 mm).
    expect(await coverage('plasma_cut', grade)).toEqual({ table: 'tblThermalCutFeed (machining workbook plasma curve)', material: 'Aluminium', minThicknessMm: 3, maxThicknessMm: 40 });
    expect(await coverage('oxyfuel_cut', grade)).toEqual({ table: 'sm_reference_data nestingCutRate OxyFuelCut', material: null, minThicknessMm: null, maxThicknessMm: null });
  });

  it('carbon steel: every process lists it, each over its own thicknesses', async () => {
    const grade = 'Steel, Cold Worked, AISI 1018';
    expect(await coverage('fiber_laser', grade)).toMatchObject({ material: 'Carbon Steel', minThicknessMm: 1, maxThicknessMm: 60 });
    expect(await coverage('co2_laser', grade)).toMatchObject({ material: 'Carbon Steel', minThicknessMm: 0.25, maxThicknessMm: 25.4 });
    expect(await coverage('waterjet', grade)).toMatchObject({ material: 'Carbon Steel', minThicknessMm: 3, maxThicknessMm: 32 });
    // The plasma and oxyfuel rows name it Steel.
    expect(await coverage('plasma_cut', grade)).toMatchObject({ material: 'Steel', minThicknessMm: 3, maxThicknessMm: 77 });
    expect(await coverage('oxyfuel_cut', grade)).toMatchObject({ material: 'Steel', minThicknessMm: 3, maxThicknessMm: 305 });
  });

  it('cast iron is read at its own rows, not the steel\'s', async () => {
    expect(await coverage('plasma_cut', 'Cast Iron, Gray, ASTM A48 Class 30')).toMatchObject({ material: 'Cast Iron', minThicknessMm: 3, maxThicknessMm: 77 });
    expect(await coverage('oxyfuel_cut', 'EN-GJS-400-15')).toMatchObject({ material: 'Cast Iron', minThicknessMm: 3, maxThicknessMm: 305 });
  });

  it('stainless steel is read at its own rows', async () => {
    expect(await coverage('plasma_cut', 'SS304')).toMatchObject({ material: 'Stainless Steel', minThicknessMm: 3, maxThicknessMm: 77 });
    expect(await coverage('waterjet', 'SS304')).toMatchObject({ material: 'Stainless Steel' });
  });

  it('a material no feed table names, and a part with no grade, are listed by none: never defaulted to steel', async () => {
    for (const machineClass of ['fiber_laser', 'co2_laser', 'waterjet', 'plasma_cut', 'oxyfuel_cut'] as const) {
      expect((await coverage(machineClass, 'Titanium, Grade 2')).material).toBeNull();
      expect((await coverage(machineClass, 'Nylon 6/6')).material).toBeNull();
      expect((await coverage(machineClass, null)).material).toBeNull();
    }
  });
});

describe('thermalCutMaterial: the rows a grade is cut at in the plasma and oxyfuel data', () => {
  it('a cast iron its own, a stainless steel its own, a non-ferrous metal none, any other grade the steel rows', () => {
    for (const g of ['Cast Iron, Gray', 'EN-GJL-250', 'GG25', 'GGG40', 'Ductile Iron 65-45-12', 'ASTM A536', 'FG 260', 'SG Iron']) expect(thermalCutMaterial(g)).toBe('Cast Iron');
    expect(thermalCutMaterial('SS304')).toBe('Stainless Steel');
    for (const g of ['Aluminum, ANSI 6061', 'AL6061-T6', 'Brass CuZn39Pb3', 'Copper C110']) expect(thermalCutMaterial(g)).toBeNull();
    for (const g of ['Steel, Cold Worked, AISI 1018', 'IS2062', 'AISI 4140', null]) expect(thermalCutMaterial(g)).toBe('Steel');
  });
});

describe('a non-ferrous plate\'s plasma cut: the machining workbook\'s curve, not a steel\'s feed', () => {
  const service = new SheetMetalLookupService(fakeDatabase()) as unknown as {
    getPlasmaCutRateParams(cut: 'PlasmaCut' | 'PlasmaPunch', powerWatts: number, grade: string, thicknessMm: number): Promise<{ feedRateLargeFeaturesMmPerMin: number; pierceTimeSec: number; dataFound: boolean; source?: string }>;
  };

  it('feeds at the first of the curve\'s thicknesses that holds the plate, with no pierce time, and says so', async () => {
    // 10 mm aluminium: the 12 mm row, 1800 mm/min.
    const params = await service.getPlasmaCutRateParams('PlasmaCut', 2000, 'Aluminum, ANSI 6061', 10);
    expect(params).toMatchObject({ feedRateLargeFeaturesMmPerMin: 1800, pierceTimeSec: 0, dataFound: true });
    expect(params.source).toContain("fed at the machining workbook's plasma curve (tblThermalCutFeed, the same for every material): 1800 mm/min at its 12 mm row for 10 mm plate");
  });

  it('a plate thicker than the curve reaches is not priced', async () => {
    expect((await service.getPlasmaCutRateParams('PlasmaCut', 2000, 'Aluminum, ANSI 6061', 50)).dataFound).toBe(false);
  });
});

describe('the plasma cutting line says where a feed came from when it is not the plasma cut data', () => {
  it('carries the source of a workbook feed among its warnings, and none for the data\'s own feed', () => {
    const base = { sheetThicknessMm: 10, cutLengthMm: 600, pierceCount: 2, batchSize: 10 } as any;
    const source = "Plasma Cut: the plasma cut data holds no rows of Aluminium; fed at the machining workbook's plasma curve";
    const fromWorkbook = new PlasmaCuttingEngine().computeCost({ ...base, plasmaCutParams: { feedRateLargeFeaturesMmPerMin: 1800, pierceTimeSec: 0, dataFound: true, source } });
    expect(fromWorkbook.warnings).toContain(source);
    // 600 mm at 1800 mm/min = 20 s of cutting, no pierce time.
    expect(fromWorkbook.cuttingMin * 60).toBeCloseTo(20, 6);
    const fromData = new PlasmaCuttingEngine().computeCost({ ...base, plasmaCutParams: { feedRateLargeFeaturesMmPerMin: 1800, pierceTimeSec: 1, dataFound: true } });
    expect(fromData.warnings.some((w) => w.includes('workbook'))).toBe(false);
  });
});

describe('plasma on plate thinner than the plasma data\'s thinnest row (user decision 2026-11-25)', () => {
  // The staged plasma rows start at 6.4 mm (Steel 1,037 / 1,280 / 1,573 mm/min at 100 / 200 / 300 A); the machining workbook's curve
  // covers 3 to 6.35 mm (2,400 mm/min to 4 mm, 2,200 to 6.35). Plate below 6.4 mm is fed at the curve, with the 6.4 mm row's pierce time.
  const plasmaRow = (materialTypeName: string, thicknessMm: number, feed: number) => ({
    key: `nestingCutRate:10:PlasmaCut:NoGas:${materialTypeName}:200:${thicknessMm}`,
    raw: { materialTypeName, thicknessMm, powerWatts: 200, feedRateLargeFeaturesMmPerMin: feed, pierceTimeS: 0.8 },
  });
  const rows = [plasmaRow('Steel', 6.4, 1280), plasmaRow('Steel', 8, 1063)];
  const curve = [[3, 2400, 1], [4, 2400, 1.2], [6.35, 2200, 1.5], [8, 2200, 2.5]]
    .map(([ThicknessMm, FeedMmPerMin, KerfMm]) => ({ Machine: 'Plasma Cutting Machine', ThicknessMm, FeedMmPerMin, KerfMm }));
  function db(powerWatts = 200) {
    const query = (table: string) => {
      const eq: Record<string, unknown> = {};
      let like = '';
      const builder: any = {
        select: () => builder,
        eq: (c: string, v: unknown) => { eq[c] = v; return builder; },
        like: (_c: string, pattern: string) => { like = pattern; return builder; },
        then: (resolve: (v: { data: unknown; error: null }) => void) => { resolve({ data: matching(), error: null }); },
        maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      };
      const matching = () => {
        if (table === 'machining_reference_data') return [{ key: 'tblThermalCutFeed', raw: curve }];
        if (table === 'sm_reference_data' && eq['category'] === 'machine') return [{ raw: { power_watts: powerWatts } }];
        const pattern = new RegExp(`^${like.replace(/%/g, '.*')}$`);
        return rows.filter((r) => !like || pattern.test(r.key));
      };
      return builder;
    };
    return { getPrivilegedClient: () => ({ from: query }) } as any;
  }
  const feed = (t: number) => new SheetMetalLookupService(db()).getPlasmaCutParams('Hypertherm 200A', 'AISI 1018', t);

  it('5 mm steel: the workbook\'s 2,200 mm/min at its 6.35 mm row, the 6.4 mm row\'s pierce time; 3.5 mm: 2,400 at its 4 mm row', async () => {
    expect(await feed(5)).toMatchObject({ feedRateLargeFeaturesMmPerMin: 2200, pierceTimeSec: 0.8, dataFound: true });
    expect((await feed(5)).source).toContain('fed at the machining workbook\'s plasma curve');
    expect(await feed(3.5)).toMatchObject({ feedRateLargeFeaturesMmPerMin: 2400, pierceTimeSec: 0.8 });
  });

  it('a heavy machine whose data starts thicker and faster than the curve keeps its thinnest row\'s feed: thinner plate never cuts slower', async () => {
    // ESAB Avenger Plus (1000): its Steel rows start at 12.7 mm, 3,068 mm/min, faster than the curve's 2,400.
    rows.push({ key: 'nestingCutRate:10:PlasmaCut:NoGas:Steel:1000:12.7', raw: { materialTypeName: 'Steel', thicknessMm: 12.7, powerWatts: 1000, feedRateLargeFeaturesMmPerMin: 3068, pierceTimeS: 7.04 } });
    const heavy = new SheetMetalLookupService(db(1000)).getPlasmaCutParams('ESAB - Avenger Plus', 'AISI 1018', 1.5);
    expect(await heavy).toMatchObject({ feedRateLargeFeaturesMmPerMin: 3068, pierceTimeSec: 7.04, dataFound: true });
    expect((await heavy).source).toContain('thinner plate does not cut slower on one machine');
    rows.pop();
  });

  it('6.4 mm and thicker: the plasma data, as before', async () => {
    expect(await feed(6.4)).toEqual({ feedRateLargeFeaturesMmPerMin: 1280, pierceTimeSec: 0.8, dataFound: true });
    expect(await feed(8)).toEqual({ feedRateLargeFeaturesMmPerMin: 1063, pierceTimeSec: 0.8, dataFound: true });
  });
});
