// The grooving insert a turned groove is plunged with (tblGrooving, migration 746), on the real table: the material's rows by hardness within
// its cut-code family, the insert as wide as the groove, the feed read between the 1.75 mm and 8 mm inserts.
import { groovingLookupSeeds } from '../../../../../../modules/bom-items/costing/machining/calculators/machining-lookup-seeds';
import { resolveGroovingParams } from '../../../../../../modules/bom-items/costing/machining/lookup/grooving-table';
import { turnedGrooveGroups } from '../../../../../../modules/bom-items/costing/machining/operation/turned-grooves';
import { realGroovingTable } from '../real-reference-tables';

const table = realGroovingTable();

describe('tblGrooving: the grooving insert of a turned groove', () => {
  it('stages 182 rows, two insert widths (1.75 and 8 mm) a material', () => {
    expect(table).toHaveLength(182);
    expect(new Set(table.map((r) => r['Length (mm)']))).toEqual(new Set([1.75, 8]));
  });

  it('mild steel, a 4 mm wide groove: code 1.0 (125 HB), 250.4 m/min, feed 0.06 + (4 - 1.75) / (8 - 1.75) x (0.27 - 0.06) = 0.1356', () => {
    const p = resolveGroovingParams(table, 4, 2, 'mild_steel')!;
    expect(p).toMatchObject({ materialCutCode: 1, hardnessHb: 125, insertWidthMm: 4, cuttingSpeedMPerMin: 250.4, feedMmPerRev: 0.1356 });
    expect(p.feedBasis).toMatch(/between the 1.75 mm insert .* and the 8 mm insert/);
    expect(p.rowWidthsMm).toEqual([1.75, 8]);
  });

  it('a groove narrower than the narrowest insert is fed at the 1.75 mm row; one wider than 8 mm takes the 8 mm insert', () => {
    expect(resolveGroovingParams(table, 1, 0.5, 'mild_steel')).toMatchObject({ insertWidthMm: 1, feedMmPerRev: 0.06 });
    expect(resolveGroovingParams(table, 1.75, 0.5, 'mild_steel')).toMatchObject({ insertWidthMm: 1.75, feedMmPerRev: 0.06 });
    expect(resolveGroovingParams(table, 12, 3, 'mild_steel')).toMatchObject({ insertWidthMm: 8, feedMmPerRev: 0.27 });
  });

  it('reads each material inside its own cut-code family: aluminium 30.x, stainless 5.x, copper 33.x', () => {
    expect(Math.trunc(resolveGroovingParams(table, 4, 2, 'aluminum')!.materialCutCode)).toBe(30);
    expect(Math.trunc(resolveGroovingParams(table, 4, 2, 'stainless')!.materialCutCode)).toBe(5);
    expect(Math.trunc(resolveGroovingParams(table, 4, 2, 'copper_alloy')!.materialCutCode)).toBe(33);
  });

  it('is null, never a neighbouring row, for a material with no hardness on file, a groove deeper than every insert, or no table', () => {
    expect(resolveGroovingParams(table, 4, 2, 'titanium')).toBeNull();
    expect(resolveGroovingParams(table, 4, 25, 'mild_steel')).toBeNull();
    expect(resolveGroovingParams(null, 4, 2, 'mild_steel')).toBeNull();
    expect(resolveGroovingParams(table, 0, 2, 'mild_steel')).toBeNull();
  });

  it('as the Plunging calculator\'s inputs: the insert width, the speed and the feed, each with its row; a gap is named', () => {
    const out = groovingLookupSeeds({ matClass: 'mild_steel', groovingTable: table }, { 'Groove Width': 4, 'Groove Depth': 2 });
    expect(out.missing).toEqual([]);
    expect(out.seeds['Insert Width']!.value).toBe(4);
    expect(out.seeds['Cutting Speed']).toMatchObject({ value: 250.4, lookup: true, match: { table: 'tblGrooving' } });
    expect(out.seeds['Feed']!.value).toBe(0.1356);
    expect(out.seeds['Feed']!.source).toMatch(/1.75 mm insert/);
    expect(groovingLookupSeeds({ matClass: 'titanium', groovingTable: table }, { 'Groove Width': 4, 'Groove Depth': 2 }).missing[0]).toMatch(/tblGrooving insert for titanium/);
    expect(groovingLookupSeeds({ matClass: 'mild_steel', groovingTable: table }, {}).missing[0]).toMatch(/Groove Width and Groove Depth/);
  });
});

describe('the grooves a lathe plunges (turned-grooves.ts)', () => {
  it('groups the Ring:groove occurrences by diameter, depth and width; a groove analysed before geo_v89 names what it lacks', () => {
    const groups = turnedGrooveGroups([
      { id: 'Ring-groove_d30.0_c2', feature_type: 'Ring', variant: 'groove', diameter_mm: 30, occurrences: [
        { depth_mm: 2, width_mm: 4, face_ids: [3] }, { depth_mm: 2, width_mm: 4, face_ids: [4] },
      ] },
      { id: 'Ring-groove_d20.0_c1', feature_type: 'Ring', variant: 'groove', diameter_mm: 20, occurrences: [{ radius_mm: 1.5, face_ids: [9] }] },
      { id: 'Slot-groove_d18.0_c1', feature_type: 'Slot', variant: 'groove', diameter_mm: 18, occurrences: [{ depth_mm: 1, width_mm: 2 }] },
    ]);
    expect(groups).toEqual([
      { diameterMm: 30, depthMm: 2, widthMm: 4, grooves: 2, faceIds: [3, 4], featureIds: ['Ring-groove_d30.0_c2'], lacks: [] },
      { diameterMm: 20, depthMm: null, widthMm: null, grooves: 1, faceIds: [9], featureIds: ['Ring-groove_d20.0_c1'], lacks: ['depth', 'width'] },
    ]);
  });
});
