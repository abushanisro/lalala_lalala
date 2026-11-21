import spec from './roll-forming-calculators.json';
import { domainCalculatorsByName, validateDomainCalculatorSpec, type DomainCalculatorSpec } from '../../shared/calculators/domain-calculator-spec';

import type { ReferenceCalculatorDef } from '../../shared/calculators/reference-calculator';

/** The Sheet Metal Roll Forming calculator spec (roll-forming-calculators.json), validated. */
export function loadRollFormingCalculatorSpec(): DomainCalculatorSpec {
  return validateDomainCalculatorSpec(spec);
}

/** Every Sheet Metal Roll Forming calculator by name, as the spec has it (tests; the engine reads the database). */
export function rollFormingCalculatorsByName(): Record<string, ReferenceCalculatorDef> {
  return domainCalculatorsByName(loadRollFormingCalculatorSpec());
}
