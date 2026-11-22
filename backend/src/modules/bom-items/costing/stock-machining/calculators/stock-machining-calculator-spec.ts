import spec from './stock-machining-calculators.json';
import { domainCalculatorsByName, validateDomainCalculatorSpec, type DomainCalculatorSpec } from '../../shared/calculators/domain-calculator-spec';

import type { ReferenceCalculatorDef } from '../../shared/calculators/reference-calculator';

/** The Stock Machining calculator spec (stock-machining-calculators.json), validated. */
export function loadStockMachiningCalculatorSpec(): DomainCalculatorSpec {
  return validateDomainCalculatorSpec(spec);
}

/** Every Stock Machining calculator by name, as the spec has it (tests; the engine reads the database). */
export function stockMachiningCalculatorsByName(): Record<string, ReferenceCalculatorDef> {
  return domainCalculatorsByName(loadStockMachiningCalculatorSpec());
}
