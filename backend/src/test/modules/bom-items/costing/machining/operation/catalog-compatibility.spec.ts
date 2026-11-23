import { catalogGapSummary, machiningCatalogCompatibility } from '../../../../../../modules/bom-items/costing/machining/operation/catalog-compatibility';
import { resolveCanonicalOperation } from '../../../../../../modules/bom-items/costing/machining/process/canonical-operation';
import { readMachiningMemoryCsv } from '../real-reference-tables';

// The reference operation catalog itself (memory/Machining/operations_full__operations.csv, 1174 rows).
const CATALOG = readMachiningMemoryCsv('operations_full__operations.csv').map((r) => r['processName']!);

// Cannula Holder bottom: the operation the CAD engine states for each of its feature groups.
const feature = (feature_type: string, operation: string, n: number) =>
  ({ id: `${feature_type}-${n}`, feature_type, variant: 'default', canonical_operation: `${operation} // ${feature_type}`, occurrences: Array(n).fill({}) });
const PART = [
  feature('Edge', 'Rounding', 32), feature('SimpleHole', 'Tapping', 8), feature('SimpleHole', 'Drilling', 5),
  feature('PocketV2', 'Rough Milling', 16), feature('Keyway', 'Obround Slot Milling', 1), feature('Slot', 'Groove Milling', 6),
  feature('PlanarFace', 'Fine Finish Milling', 19), feature('CurvedWall', 'Contouring', 4), feature('CurvedSurface', 'Contouring', 8),
];

describe('machiningCatalogCompatibility: what a machine can make, read from the reference catalog', () => {
  it.each(['3 Axis Mill', '4 Axis Mill', '5 Axis Mill'])('%s makes every feature of the part', (process) => {
    expect(machiningCatalogCompatibility(PART, CATALOG, process)).toMatchObject({ status: 'compatible', incompatibilities: [] });
  });

  it('a 2 axis lathe cannot: it has no milling operation for pockets, faces, the keyway or the curved surfaces', () => {
    const v = machiningCatalogCompatibility(PART, CATALOG, '2 Axis Lathe')!;
    expect(v.status).toBe('incompatible');
    expect(v.incompatibilities.map((i) => i.featureType)).toEqual(expect.arrayContaining(['PocketV2', 'PlanarFace', 'Keyway', 'CurvedWall']));
    expect(v.incompatibilities.find((i) => i.featureType === 'PocketV2')).toMatchObject({
      count: 16, kind: 'not_in_process_vocabulary', reason: '2 Axis Lathe has no "Rough Milling // PocketV2" operation in the machining catalog',
    });
  });

  it('MillTurn contours with its live tooling (the catalog calls it Mill Contouring) but has no edge rounding, so it is ruled out by the 32 rounded edges alone', () => {
    const v = machiningCatalogCompatibility(PART, CATALOG, 'MillTurn')!;
    expect(v.incompatibilities.map((i) => i.featureType)).toEqual(['Edge']);
    expect(machiningCatalogCompatibility(PART.filter((f) => f.feature_type !== 'Edge'), CATALOG, 'MillTurn')!.status).toBe('compatible');
  });

  it('an operation that is a step of a compound feature counts (Rounding // SimpleHole : Rounding // Edge)', () => {
    expect(machiningCatalogCompatibility([feature('Edge', 'Rounding', 1)], ['X:Rounding//SimpleHole:Rounding//Edge'], 'X')!.status).toBe('compatible');
  });

  it('says why in one sentence: each operation the machine lacks, with the features that need it', () => {
    const v = machiningCatalogCompatibility(PART, CATALOG, '2 Axis Lathe')!;
    const sentence = catalogGapSummary('2 Axis Lathe', PART, v.incompatibilities);
    expect(sentence).toMatch(/^2 Axis Lathe cannot make this part: the machining catalog gives it no /);
    expect(sentence).toContain('Rough Milling (16 × PocketV2)');
    expect(sentence).toContain('Obround Slot Milling (1 × Keyway)');
    expect(sentence).toContain('Rounding (32 × Edge)');
    // The machine is named once, not once per feature group.
    expect(sentence.match(/2 Axis Lathe/g)).toHaveLength(1);
  });

  describe('a keyway, labelled as the analysis labels it (canonical-operation.ts)', () => {
    const keyway = (family: 'milling' | 'turning') =>
      [{ id: 'Keyway-1', feature_type: 'Keyway', variant: 'default', canonical_operation: resolveCanonicalOperation('Keyway', 'default', family)!, occurrences: [{}, {}] }];

    it.each(['3 Axis Mill', '4 Axis Mill', '5 Axis Mill', '3 Axis Lathe', '3 Axis Bar Feed Lathe with Sub Spindle', 'MillTurn', 'Simultaneous Turning'])(
      '%s mills it: the catalog gives it the operation the keyway is costed by',
      (process) => {
        for (const family of ['milling', 'turning'] as const) {
          expect(machiningCatalogCompatibility(keyway(family), CATALOG, process)).toMatchObject({ status: 'compatible', incompatibilities: [] });
        }
      },
    );

    it.each(['2 Axis Lathe', '2 Axis Bar Feed Lathe with Sub Spindle'])('%s cannot: the catalog gives it no milling operation for a keyway', (process) => {
      const v = machiningCatalogCompatibility(keyway('turning'), CATALOG, process)!;
      expect(v.incompatibilities).toEqual([expect.objectContaining({
        featureType: 'Keyway', count: 2, reason: `${process} has no "Obround Slot Milling // Keyway" operation in the machining catalog`,
      })]);
    });

    it('an analysis stored with the earlier label "Rough Milling" still rules out the 3 axis bar feed lathe and Simultaneous Turning: the catalog gives them no Rough Milling for a keyway', () => {
      const storedEarlier = [feature('Keyway', 'Rough Milling', 2)];
      for (const process of ['3 Axis Bar Feed Lathe with Sub Spindle', 'Simultaneous Turning']) {
        expect(machiningCatalogCompatibility(storedEarlier, CATALOG, process)!.status).toBe('incompatible');
      }
    });
  });

  describe('a flat, labelled as the analysis labels it (canonical-operation.ts)', () => {
    // Two wrench flats on a turned diameter. The catalog gives "Rough Milling//Flat" as a step of the machine's setup:
    // "3 Axis Lathe:Setup:Rough Milling//Flat".
    const flats = (family: 'milling' | 'turning') =>
      [{ id: 'Flat-default_c2', feature_type: 'Flat', variant: 'default', canonical_operation: resolveCanonicalOperation('Flat', 'default', family)!, occurrences: [{}, {}] }];

    it.each(['3 Axis Mill', '4 Axis Mill', '5 Axis Mill', '3 Axis Lathe', 'MillTurn'])('%s mills them: the catalog gives it Rough Milling of a flat in its setup', (process) => {
      for (const family of ['milling', 'turning'] as const) {
        expect(machiningCatalogCompatibility(flats(family), CATALOG, process)).toMatchObject({ status: 'compatible', incompatibilities: [] });
      }
    });

    it.each(['2 Axis Lathe', '2 Axis Bar Feed Lathe with Sub Spindle', '3 Axis Bar Feed Lathe with Sub Spindle', 'Simultaneous Turning'])(
      '%s cannot: the catalog gives it no operation on a flat',
      (process) => {
        const v = machiningCatalogCompatibility(flats('turning'), CATALOG, process)!;
        expect(v.incompatibilities).toEqual([expect.objectContaining({
          featureType: 'Flat', count: 2, reason: `${process} has no "Rough Milling // Flat" operation in the machining catalog`,
        })]);
        expect(catalogGapSummary(process, flats('turning'), v.incompatibilities)).toBe(`${process} cannot make this part: the machining catalog gives it no Rough Milling (2 × Flat).`);
      },
    );

    it('a step of the setup counts only as that machine\'s own step', () => {
      expect(machiningCatalogCompatibility(flats('turning'), ['X:Setup:Rough Milling//Flat'], 'X')!.status).toBe('compatible');
      expect(machiningCatalogCompatibility(flats('turning'), ['X:Setup:Rough Milling//Flat'], 'Y')!.status).toBe('incompatible');
    });
  });

  it('gives no verdict without a catalog or without a feature that states its operation', () => {
    expect(machiningCatalogCompatibility(PART, null, '3 Axis Mill')).toBeNull();
    expect(machiningCatalogCompatibility([{ feature_type: 'Edge' }], CATALOG, '3 Axis Mill')).toBeNull();
  });
});
