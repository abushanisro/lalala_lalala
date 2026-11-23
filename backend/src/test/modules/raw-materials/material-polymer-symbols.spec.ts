import { POLYMER_SYMBOL_NAMES, polymerNamesIn, polymerSymbolVariants } from '../../../modules/raw-materials/material-polymer-symbols';

// A drawing names a plastic by its ISO 1043-1 symbol; the reference data names it in words. Pure functions, no database.
describe('ISO 1043-1 polymer symbols, as the words the reference data uses', () => {
  it('a symbol is written as each of the reference data\'s names for its polymer, the rest of the grade kept', () => {
    expect(polymerSymbolVariants('PA66')).toEqual(['Nylon, Type 66']);
    expect(polymerSymbolVariants('PA66-GF30')).toEqual(['Nylon, Type 66-GF30']);
    expect(polymerSymbolVariants('POM-C')).toEqual(['Acetal-C']);
    expect(polymerSymbolVariants('PC/ABS')).toEqual(['Polycarbonate/ABS']);
    expect(polymerSymbolVariants('PBT')).toEqual(['Polybutylene Terephthalate']);
  });

  it('in any case, with or without a space or hyphen before the number', () => {
    for (const written of ['PA66', 'PA 66', 'pa-66', 'Pa66']) expect(polymerSymbolVariants(written)).toContain('Nylon, Type 66');
    expect(polymerSymbolVariants('PA 6')).toEqual(['Nylon, Type 6']);
  });

  it('only as a whole word, and never a polyamide read as another: PA6/6 and PA6.6 are not PA6, PA612 is not PA6', () => {
    for (const other of ['PPS', 'SPCC', 'COPPER', 'PETG', 'PEEK', 'PA612', 'PA6/6', 'PA6.6', 'PA6/10', 'Aluminium 6061 T6', 'Acetal / Delrin - Natural']) {
      expect(polymerSymbolVariants(other)).toEqual([]);
    }
  });

  it('the names to fetch rows by, for every symbol in a grade', () => {
    expect(polymerNamesIn('PA 66 GF30')).toEqual(['Nylon, Type 66']);
    expect(polymerNamesIn('POM-C natural')).toEqual(['Acetal']);
    expect(polymerNamesIn('PC/ABS')).toEqual(['Polycarbonate']);
    expect(polymerNamesIn('Aluminium 6061 T6 - Extrusion / Profile')).toEqual([]);
  });

  it('holds standard symbols only, no trade names, and none the reference data already uses as a name', () => {
    expect(Object.keys(POLYMER_SYMBOL_NAMES)).toEqual(['PA6', 'PA66', 'POM', 'PC', 'PP', 'PE', 'PS', 'PBT']);
    expect(Object.values(POLYMER_SYMBOL_NAMES).flat().join(' ')).not.toMatch(/delrin|ultem|lexan/i);
  });
});
