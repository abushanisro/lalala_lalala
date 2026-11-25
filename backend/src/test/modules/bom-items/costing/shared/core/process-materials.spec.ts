import {
  closestProcessMaterial, enginePrices, isMaterialNamed, ownMaterialGroup, pricedGradeFor, PROCESS_OWN_MATERIAL_GROUP, type OwnMaterial, type ProcessMaterial,
} from '../../../../../../modules/bom-items/costing/shared/core/process-materials';

// Rows as raw_materials holds them for the Bar and Tube Fabrication group (names, types and densities from the local data).
const BAR_TUBE: ProcessMaterial[] = [
  { name: 'Steel, Cold Drawn, AISI 1018', grade: 'Generic Steel, Cold Drawn, AISI 1018', materialType: 'Steel', densityKgM3: 7870 },
  { name: 'Aluminum, ANSI 6061', grade: 'Generic Aluminum, ANSI 6061', materialType: 'Aluminum', densityKgM3: 2700 },
  { name: 'Aluminum, ANSI 1100', grade: 'Generic Aluminum, ANSI 1100', materialType: 'Aluminum', densityKgM3: 2710 },
  { name: 'Titanium, Grade 2', grade: 'Generic Titanium, Grade 2', materialType: 'Titanium', densityKgM3: 4510 },
];
const petg: OwnMaterial = { name: 'Generic PETG Copol', grade: 'Generic PETG Copol', materialGroup: 'Plastic & Rubber', materialType: 'PET', densityKgM3: 1200 };

describe('the grade a process prices (Apply never fails on a material the process cannot use)', () => {
  it('a grade of the process is priced as given, by name or by grade, case-insensitively', () => {
    expect(isMaterialNamed(BAR_TUBE[1], 'aluminum, ansi 6061')).toBe(true);
    expect(isMaterialNamed(BAR_TUBE[1], 'Generic Aluminum, ANSI 6061')).toBe(true);
    expect(pricedGradeFor({ family: 'bar_tube', processLabel: 'Bar and Tube Fabrication', grade: 'Generic Aluminum, ANSI 6061', own: [], materials: BAR_TUBE }))
      .toEqual({ grade: 'Generic Aluminum, ANSI 6061', note: null });
  });

  it('a grade of another process is priced as the closest own material: no shared type, so the nearest density, said in a note', () => {
    const r = pricedGradeFor({ family: 'bar_tube', processLabel: 'Bar and Tube Fabrication', grade: 'Generic PETG Copol', own: [petg], materials: BAR_TUBE });
    expect(r.grade).toBe('Aluminum, ANSI 6061');
    expect(r.note).toBe('"Generic PETG Copol" is not a Bar and Tube Fabrication material: priced as "Aluminum, ANSI 6061", its closest Bar and Tube Fabrication '
      + 'material (nearest density). Choose a Bar and Tube Fabrication material in Material Grade to price another.');
  });

  it('closeness: the same grade first, then a variant of it, then the same material type, then the nearest density', () => {
    const steelSheet: OwnMaterial = { name: 'Steel, Cold Worked, AISI 1020', grade: null, materialGroup: 'Ferrous & Non-Ferrous', materialType: 'Steel', densityKgM3: 2000 };
    expect(closestProcessMaterial([steelSheet], BAR_TUBE)).toEqual({ material: BAR_TUBE[0], by: 'material type' });
    const sameName: OwnMaterial = { ...steelSheet, name: 'Titanium, Grade 2', materialType: 'Steel' };
    expect(closestProcessMaterial([sameName], BAR_TUBE)).toEqual({ material: BAR_TUBE[3], by: 'grade' });
    // "Aluminum, ANSI 6061" with a qualifier is a variant of it: closer than the same type ("Aluminum, ANSI 1100") at the same density.
    const variant: OwnMaterial = { ...steelSheet, name: 'Aluminum, ANSI 6061', materialType: 'Aluminum', densityKgM3: 2710 };
    const withVariant = [...BAR_TUBE.slice(1), { name: 'Aluminum, ANSI 6061 (LD30)', grade: null, materialType: 'Aluminum', densityKgM3: 2770 }];
    expect(closestProcessMaterial([variant], withVariant.filter((m) => m.name !== 'Aluminum, ANSI 6061'))?.by).toBe('variant');
    // Not a variant: the name must end at a word ("Type 6" is no variant's base of "Type 66").
    const nylon6: OwnMaterial = { name: 'Nylon, Type 6', grade: null, materialGroup: null, materialType: null, densityKgM3: null };
    expect(closestProcessMaterial([nylon6], [{ name: 'Nylon, Type 66', grade: null, materialType: 'Nylon', densityKgM3: 1140 }])?.by).toBe('unplaced');
    expect(closestProcessMaterial([petg], [])).toBeNull();
  });

  // Was: "a grade the search cannot place ... the first material by name, so it is still priced". The first by name said nothing of the
  // grade and in Plastic & Rubber was a printing resin at 240 USD/kg. Still priced and flagged (Apply never fails), but as the median.
  it('a grade nothing places is priced as the process\'s material of median density, whose weight is the least off on average, not the first by name', () => {
    // Bar and tube densities 2700, 2710, 4510, 7870: the lower median is 2710, Aluminum, ANSI 1100 (also first by name, so check another order).
    expect(closestProcessMaterial([], BAR_TUBE)).toEqual({ material: BAR_TUBE[2], by: 'unplaced' });
    const heavyFirst: ProcessMaterial[] = [
      { name: 'A Lead', grade: null, materialType: 'Lead', densityKgM3: 11340 },
      { name: 'B Steel', grade: null, materialType: 'Steel', densityKgM3: 7870 },
      { name: 'C Aluminum', grade: null, materialType: 'Aluminum', densityKgM3: 2700 },
    ];
    expect(closestProcessMaterial([], heavyFirst)).toEqual({ material: heavyFirst[1], by: 'unplaced' });
    // No densities at all: the first by name.
    expect(closestProcessMaterial([], heavyFirst.map((m) => ({ ...m, densityKgM3: null })))?.material.name).toBe('A Lead');
  });

  it('an exact-name engine gets the row name of a grade the search placed in its group; a ranked-search engine (molding) gets the grade as given', () => {
    const placed: OwnMaterial = { name: 'Aluminum, ANSI 6061', grade: 'Generic Aluminum, ANSI 6061', materialGroup: 'Bar and Tube Fabrication', materialType: 'Aluminum', densityKgM3: 2700 };
    expect(pricedGradeFor({ family: 'bar_tube', processLabel: 'Bar and Tube Fabrication', grade: '6061', own: [placed], materials: BAR_TUBE }))
      .toEqual({ grade: 'Aluminum, ANSI 6061', note: null });
    const abs: OwnMaterial = { name: 'Generic ABS', grade: 'Generic ABS', materialGroup: 'Plastic & Rubber', materialType: 'ABS', densityKgM3: 1050 };
    expect(pricedGradeFor({ family: 'plastic_molded', processLabel: 'Plastic Molding', grade: 'ABS', own: [abs], materials: [] })).toEqual({ grade: 'ABS', note: null });
  });

  it('a process that prices any grade (machining, sheet metal) is not narrowed: a PETG part is machined as PETG', () => {
    for (const family of ['milled', 'turned', 'mill_turn', 'sheet_metal']) {
      expect(PROCESS_OWN_MATERIAL_GROUP[family]).toBeUndefined();
      expect(pricedGradeFor({ family, processLabel: 'Machining', grade: 'Generic PETG Copol', own: [petg], materials: BAR_TUBE })).toEqual({ grade: 'Generic PETG Copol', note: null });
    }
  });

  it('a Sheet Metal Roll Forming part, analysed as sheet metal, is priced from the roll forming materials: a sheet steel as its closest roll forming steel', () => {
    expect(ownMaterialGroup('sheet_metal', 'Sheet Metal Roll Forming')).toBe('Sheet Metal Roll Forming');
    expect(ownMaterialGroup('sheet_metal', null)).toBeUndefined();
    const rollForming: ProcessMaterial[] = [
      { name: 'Aluminum, AA 1100', grade: 'Generic Aluminum, AA 1100', materialType: 'Aluminum', densityKgM3: 2700 },
      { name: 'Steel, Cold Worked, AISI 1008', grade: 'Generic Steel, Cold Worked, AISI 1008', materialType: 'Steel', densityKgM3: 7850 },
    ];
    const spcc: OwnMaterial = { name: 'SPCC', grade: 'SPCC', materialGroup: 'Ferrous & Non-Ferrous', materialType: 'Steel', densityKgM3: 7850 };
    const r = pricedGradeFor({ family: 'sheet_metal', processGroup: 'Sheet Metal Roll Forming', processLabel: 'Sheet Metal Roll Forming', grade: 'SPCC', own: [spcc], materials: rollForming });
    expect(r.grade).toBe('Steel, Cold Worked, AISI 1008');
    expect(r.note).toMatch(/^"SPCC" is not a Sheet Metal Roll Forming material: priced as "Steel, Cold Worked, AISI 1008"/);
  });

  it('every engine that matches its grade by exact name in its own group is covered', () => {
    expect(PROCESS_OWN_MATERIAL_GROUP).toEqual({
      die_cast: 'Die Casting', sand_cast: 'Sand Casting', investment_cast: 'Casting Investment', forged: 'Forging', powder_metal: 'Powder Metal',
      composite: 'Composites', additive: 'Additive Manufacturing', bar_tube: 'Bar and Tube Fabrication', roto_blow: 'Roto & Blow Molding', plastic_molded: 'Plastic & Rubber',
    });
  });
});

// Plastic & Rubber rows as the local database holds them (name, type, density, stock form, state and the injection values the molding engine
// reads). The group also holds 3D-printing resins, machining stock and molding grades with no injection data on file.
const molding = (stockForm: string | null, matlState: string | null, ip: number | null, fl: number | null, mt: number, mo: number, dm: number | null, cure: number | null = null) =>
  ({ stockForm, matlState, injectionPressureMaxMpa: ip, flowLengthRatio: fl, meltingTempC: mt, moldTempC: mo, densityOfMeltKgM3: dm, cureTimeMin: cure });
const resin = (name: string, materialType: string, densityKgM3: number, m: ProcessMaterial['molding']): ProcessMaterial => ({ name, grade: name, materialType, densityKgM3, molding: m });
const PRINTING_RESIN = resin('Generic 10122 Colorless', 'WaterClear', 1130, molding('Liquid Resin (SLA)', 'Photopolymer', null, null, 0, 0, null));
const ACETAL_COPOLYMER = resin('Generic Acetal, Copolymer', 'Acetal', 1410, molding('Granules', 'Semi-Crystalline', 120, 190, 205, 90, 1200));
const ACETAL_HOMOPOL = resin('Generic Acetal, Homopol', 'Acetal', 1410, molding(null, null, 120, 190, 216, 93, 1200));
const NYLON_66 = resin('Generic Nylon, Type 66', 'Nylon', 1346, molding('Granules', 'Semi-Crystalline', 150, 265, 260, 80, 1144));
const NYLON_66_GF = resin('Generic Nylon, Type 66 30% GF', 'Nylon', 1370, molding('Granules', 'Semi-Crystalline', null, null, 260, 80, null));
const NYLON_6_GLASS = resin('Generic Nylon, Type 6 30% Glass', 'Nylon', 1370, molding(null, null, 150, 250, 280, 90, 1200));
const NYLON_ROD = resin('Generic Nylon 6/6 (Thermoplastic)', 'Thermoplastics', 1140, molding('Rod / Sheet / Tube', 'Machined Stock', null, null, 340, 140, null));
const PP = resin('Generic Polypropylene G-P H', 'Polypropylene', 910, molding('Granules', 'Semi-Crystalline', 130, 290, 250, 60, 775));
const PC_GLASS = resin('Generic Polycarbonate 30% Glass', 'Polycarbonate', 2100, molding(null, null, 132, 110, 300, 95, 1830));
const PET = resin('Generic PET, Injection', 'PET', 1420, molding('Granules / Pellets', 'Semi-Crystalline', 103, 150, 232, 27, 1210));
const UP_THERMOSET = resin('Generic Unsaturated Polyester (UP-GF10-FR)', 'Thermoset', 1875, molding('Prepreg / Sheet', 'Cross-Linked Polymer', null, null, 160, 120, null, 35));
const PLASTIC_RUBBER = [PRINTING_RESIN, ACETAL_COPOLYMER, ACETAL_HOMOPOL, NYLON_66, NYLON_66_GF, NYLON_6_GLASS, NYLON_ROD, PP, PC_GLASS, PET, UP_THERMOSET];
const row = (name: string, grade: string | null, materialGroup: string, materialType: string, densityKgM3: number): OwnMaterial => ({ name, grade, materialGroup, materialType, densityKgM3 });
const priced = (grade: string, own: OwnMaterial[]) => pricedGradeFor({ family: 'plastic_molded', processLabel: 'Plastic Molding', grade, own, materials: PLASTIC_RUBBER });

describe('a molded part\'s stand-in material is one the molding engine can price (TERMINAL BOX COVER, 40 201 G Front Lens Holder)', () => {
  it('the molding engine prices only injection-moldable materials, by the rule it judges every material with; other processes price their whole group', () => {
    expect(PLASTIC_RUBBER.filter((m) => enginePrices('plastic_molded', m)).map((m) => m.name)).toEqual([
      'Generic Acetal, Copolymer', 'Generic Acetal, Homopol', 'Generic Nylon, Type 66', 'Generic Nylon, Type 6 30% Glass', 'Generic Polypropylene G-P H',
      'Generic Polycarbonate 30% Glass', 'Generic PET, Injection',
    ]);
    // A silicone is molded by its cure time, so it is priced with one and not without (material-moldability.ts).
    const lsr = (cure: number | null) => resin('Generic LSR, 50 Shore A', 'Silicone', 1120, molding(null, null, null, null, 0, 0, null, cure));
    expect(enginePrices('plastic_molded', lsr(2))).toBe(true);
    expect(enginePrices('plastic_molded', lsr(null))).toBe(false);
    expect(enginePrices('plastic_molded', { ...NYLON_66, molding: undefined })).toBe(false);
    expect(BAR_TUBE.every((m) => enginePrices('bar_tube', m))).toBe(true);
  });

  it('a grade nothing places is priced as the median-density moldable material, never the printing resin first by name, and the note says so', () => {
    const r = priced('XYZ-123 TBD', []);
    // Moldable densities 910, 1346, 1370, 1410, 1410, 1420, 2100: the median is 1410, the acetals, the copolymer first by name.
    expect(r.grade).toBe('Generic Acetal, Copolymer');
    expect(r.note).toBe('No material on file matches "XYZ-123 TBD", so its material type and density are unknown: priced as "Generic Acetal, Copolymer", '
      + 'the Plastic Molding material of median density (1410 kg/m³), whose weight is the least off on average. Choose a Plastic Molding material in Material Grade to price another.');
  });

  it('PA66, which the search finds in 3 rows of different density, is priced as the moldable nylon 66 among them', () => {
    // The rows "PA66" (as "Nylon, Type 66", ISO 1043-1) fits equally: Roto & Blow's and Assembly Plastic Molding's at 1140 kg/m3, Plastic & Rubber's at 1346.
    const own = [
      row('Generic Nylon, Type 66', 'Generic Nylon, Type 66', 'Plastic & Rubber', 'Nylon', 1346),
      row('Nylon, Type 66', 'Generic Nylon, Type 66', 'Assembly Plastic Molding', 'Nylon', 1140),
      row('Nylon, Type 66', 'Generic Nylon, Type 66', 'Roto & Blow Molding', 'Nylon', 1140),
    ];
    expect(priced('PA66', own)).toEqual({
      grade: 'Generic Nylon, Type 66',
      note: '"PA66" fits 3 materials on file equally well (Nylon, 1140 to 1346 kg/m³): priced as "Generic Nylon, Type 66", its closest Plastic Molding material (one of them). '
        + 'Choose a Plastic Molding material in Material Grade to price another.',
    });
  });

  it('"Acetal / Delrin - Natural", ambiguous between acetals of 1410 to 1557 kg/m3, is priced as the acetal at their median density', () => {
    const own = [
      row('Acetal', 'Generic Acetal', 'Machining', 'Thermoplastic', 1420),
      row('Acetal, Copolymer', 'Generic Acetal, Copolymer', 'Roto & Blow Molding', 'Acetal', 1410),
      row('Acetal, Homopol', 'Generic Acetal, Homopol', 'Roto & Blow Molding', 'Acetal', 1410),
      row('Acetal, Homopol 20% Glass', 'Generic Acetal, Homopol 20% Glass', 'Roto & Blow Molding', 'Acetal', 1557),
    ];
    expect(priced('Acetal / Delrin - Natural', own).grade).toBe('Generic Acetal, Copolymer');
  });

  it('a metal on a molded part, ambiguous between aluminium rows, is priced as the moldable plastic of nearest density, said to be no Plastic Molding material', () => {
    const own = [row('Aluminum, ANSI 6061', 'Generic Aluminum, ANSI 6061', 'Forging', 'Aluminum', 2700), row('Generic Aluminum, ANSI 6061 (LD30)', null, 'Ferrous & Non-Ferrous', 'Aluminum', 2770)];
    expect(priced('Aluminium 6061 T6 - Extrusion / Profile', own)).toEqual({
      grade: 'Generic Polycarbonate 30% Glass',
      note: '"Aluminium 6061 T6 - Extrusion / Profile" fits 2 materials on file equally well (Aluminum, 2700 to 2770 kg/m³), none of them a Plastic Molding material: '
        + 'priced as "Generic Polycarbonate 30% Glass", its closest Plastic Molding material (nearest density). Choose a Plastic Molding material in Material Grade to price another.',
    });
  });

  it('POM, placed on Machining\'s "Acetal" (typed Thermoplastic), is priced as a variant of it, not as PET of the same density', () => {
    const r = priced('POM', [row('Acetal', 'Generic Acetal', 'Machining', 'Thermoplastic', 1420)]);
    expect(r.grade).toBe('Generic Acetal, Copolymer');
    expect(r.note).toMatch(/its closest Plastic Molding material \(a variant of "Generic Acetal"\)/);
  });

  it('a grade the search places on a group row the engine cannot price gets a stand-in; the row named exactly is the user\'s choice and is priced as given', () => {
    const r = priced('PA 66 GF30', [row('Generic Nylon, Type 66 30% GF', 'Generic Nylon, Type 66 30% GF', 'Plastic & Rubber', 'Nylon', 1370)]);
    expect(r).toEqual({
      grade: 'Generic Nylon, Type 6 30% Glass',
      note: '"PA 66 GF30" is "Generic Nylon, Type 66 30% GF" on file, which Plastic Molding cannot price: priced as "Generic Nylon, Type 6 30% Glass", '
        + 'its closest Plastic Molding material (the same material type, Nylon). Choose a Plastic Molding material in Material Grade to price another.',
    });
    expect(priced('Generic Nylon, Type 66 30% GF', [])).toEqual({ grade: 'Generic Nylon, Type 66 30% GF', note: null });
    // A grade placed on a moldable row of the group is the engine's own and is found again by the engine's ranked search.
    expect(priced('PP', [row('Generic Polypropylene G-P H', 'Generic Polypropylene G-P H', 'Plastic & Rubber', 'Polypropylene', 910)])).toEqual({ grade: 'PP', note: null });
  });
});
