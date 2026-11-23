// A drawing names a plastic by its standard symbol (ISO 1043-1, Plastics - Symbols and abbreviated terms - Part 1: Basic polymers): "PA66",
// "POM", "PC". The reference data names the same plastics in words ("Generic Nylon, Type 66", "Generic Acetal, Copolymer", "Generic
// Polycarbonate"), so a symbol matched no row and the part was priced as an unrelated material. The search also tries each symbol written as
// the words the reference data uses for that polymer.
//
// Only symbols whose polymer the reference data names in other words are listed: ABS, PET and PMMA are in its names already. Trade names
// (Delrin, Ultem, Lexan) are not standard symbols and are not listed.

/** ISO 1043-1 symbol -> the words the reference data names that polymer with. */
export const POLYMER_SYMBOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  // Polyamide 6 and polyamide 66 (ISO 1043-1 PA, numbered by the carbon atoms of their monomers): nylon 6 and nylon 66.
  PA6: ['Nylon, Type 6'],
  PA66: ['Nylon, Type 66'],
  // Polyoxymethylene, which ISO 1043-1 also calls polyacetal.
  POM: ['Acetal'],
  PC: ['Polycarbonate'],
  PP: ['Polypropylene'],
  PE: ['Polyethylene'],
  PS: ['Polystyrene'],
  PBT: ['Polybutylene Terephthalate'],
};

/**
 * The symbol as a whole word, in any case, with or without a space or hyphen before its number ("PA66", "PA 66", "pa-66"). Not when a
 * slash or dot and a digit follow: "PA6/6" and "PA6.6" are polyamide 66, "PA6/10" another polyamide.
 */
function symbolPattern(symbol: string): RegExp {
  const written = symbol.replace(/^([A-Z]+)(\d+)$/, '$1[\\s-]?$2'); // "PA66" -> "PA[\s-]?66"
  return new RegExp(`(?<![a-z0-9])${written}(?![a-z0-9]|[/.]\\d)`, 'gi');
}

/** The reference data's words for each polymer symbol in `term` ("PA 66 GF30", "POM-C"): what to fetch the rows it may name by. */
export function polymerNamesIn(term: string): string[] {
  return Object.entries(POLYMER_SYMBOL_NAMES).filter(([symbol]) => symbolPattern(symbol).test(term)).flatMap(([, names]) => names);
}

/**
 * `term` with each polymer symbol in it written as the reference data's words, one variant per spelling; empty when it holds none. The rest
 * of the grade stays, so it still counts when the variant is scored: "PC/ABS" is the blend "ABS, PC-ABS", not plain polycarbonate.
 */
export function polymerSymbolVariants(term: string): string[] {
  let variants = [term];
  for (const [symbol, names] of Object.entries(POLYMER_SYMBOL_NAMES)) {
    if (!symbolPattern(symbol).test(term)) continue;
    variants = variants.flatMap((v) => names.map((name) => v.replace(symbolPattern(symbol), name)));
  }
  return variants.filter((v) => v !== term);
}
