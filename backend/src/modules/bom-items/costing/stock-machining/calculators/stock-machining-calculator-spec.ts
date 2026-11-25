import spec from './stock-machining-calculators.json';
import { domainCalculatorsByName, validateDomainCalculatorSpec, type DomainCalculatorSpec } from '../../shared/calculators/domain-calculator-spec';

import type { ReferenceCalculatorDef } from '../../shared/calculators/reference-calculator';

/**
 * The Stock Machining calculator spec (stock-machining-calculators.json), validated: the current entry of each calculator. `includeSuperseded`
 * keeps an entry a later migration replaced (supersededBy), for generating the migration that shipped it, which never changes once applied.
 */
export function loadStockMachiningCalculatorSpec(opts: { includeSuperseded?: boolean } = {}): DomainCalculatorSpec {
  const raw = spec as DomainCalculatorSpec;
  // Names are unique among the current entries; a superseded entry shares its replacement's name, so only the current set is validated.
  validateDomainCalculatorSpec({ ...raw, calculators: raw.calculators.filter((c) => c.supersededBy == null) });
  return { ...raw, calculators: raw.calculators.filter((c) => opts.includeSuperseded || c.supersededBy == null) };
}

/** Every Stock Machining calculator by name, as the spec has it (tests; the engine reads the database). */
export function stockMachiningCalculatorsByName(): Record<string, ReferenceCalculatorDef> {
  return domainCalculatorsByName(loadStockMachiningCalculatorSpec());
}
