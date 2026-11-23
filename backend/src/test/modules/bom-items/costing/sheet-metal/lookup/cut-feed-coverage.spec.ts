// What a cutting process's feed table holds for a material (SheetMetalLookupService.getCutFeedCoverage): the gate a plate cut asks before it
// is priced. The feed getters read the row nearest a thickness and price every grade that is not stainless at the steel rows, which is right
// for sheet; a machined part's plate (far thicker, of any material) is priced only where the table lists the material at that thickness.
// The rows below are shaped as the staged tables are; the ranges are those of the staged data.
import { SheetMetalLookupService } from '../../../../../../modules/bom-items/costing/sheet-metal/lookup/sheet-metal-lookup.service';

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
        const rows: Record<string, unknown>[] = table === 'sm_lookup_laser_cut' ? LASER : table === 'sm_lookup_waterjet_cut' ? WATERJET : NESTING;
        const pattern = new RegExp(`^${like.replace(/%/g, '.*')}$`);
        resolve({
          data: rows.filter((r) => Object.entries(eq).every(([c, v]) => !(c in r) || r[c] === v) && (!like || pattern.test(String(r.key)))),
          error: null,
        });
      },
    };
    return builder;
  };
  return { getPrivilegedClient: () => ({ from: query }) } as any;
}
const coverage = (machineClass: Parameters<SheetMetalLookupService['getCutFeedCoverage']>[0], grade: string | null) =>
  new SheetMetalLookupService(fakeDatabase()).getCutFeedCoverage(machineClass, grade);

describe('SheetMetalLookupService.getCutFeedCoverage', () => {
  it('aluminium: the fiber laser and the waterjet list it, the CO2 laser, plasma and oxyfuel do not', async () => {
    const grade = 'Aluminum, ANSI 6061';
    expect(await coverage('fiber_laser', grade)).toEqual({ table: 'sm_lookup_laser_cut (fiber)', material: 'Aluminium', minThicknessMm: 1, maxThicknessMm: 50 });
    expect(await coverage('waterjet', grade)).toEqual({ table: 'sm_lookup_waterjet_cut', material: 'Aluminium', minThicknessMm: 3, maxThicknessMm: 32 });
    expect(await coverage('co2_laser', grade)).toEqual({ table: 'sm_lookup_laser_cut (co2)', material: null, minThicknessMm: null, maxThicknessMm: null });
    // The plasma and oxyfuel rows are steels only: aluminium is not read as steel.
    expect(await coverage('plasma_cut', grade)).toEqual({ table: 'sm_reference_data nestingCutRate PlasmaCut', material: null, minThicknessMm: null, maxThicknessMm: null });
    expect(await coverage('oxyfuel_cut', grade)).toEqual({ table: 'sm_reference_data nestingCutRate OxyFuelCut', material: null, minThicknessMm: null, maxThicknessMm: null });
  });

  it('carbon steel: every process lists it, each over its own thicknesses', async () => {
    const grade = 'Steel, Cold Worked, AISI 1018';
    expect(await coverage('fiber_laser', grade)).toMatchObject({ material: 'Carbon Steel', minThicknessMm: 1, maxThicknessMm: 60 });
    expect(await coverage('co2_laser', grade)).toMatchObject({ material: 'Carbon Steel', minThicknessMm: 0.25, maxThicknessMm: 25.4 });
    expect(await coverage('waterjet', grade)).toMatchObject({ material: 'Carbon Steel', minThicknessMm: 3, maxThicknessMm: 32 });
    // The plasma and oxyfuel rows name it Steel.
    expect(await coverage('plasma_cut', grade)).toMatchObject({ material: 'Steel', minThicknessMm: 6.4, maxThicknessMm: 77 });
    expect(await coverage('oxyfuel_cut', grade)).toMatchObject({ material: 'Steel', minThicknessMm: 3, maxThicknessMm: 305 });
  });

  it('stainless steel is read at its own rows', async () => {
    expect(await coverage('plasma_cut', 'SS304')).toMatchObject({ material: 'Stainless Steel', minThicknessMm: 6.4, maxThicknessMm: 77 });
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
