import spec from './sand-casting-calculators.json';
import {
  domainCalculatorsAsReference,
  domainCalculatorsByName,
  validateDomainCalculatorSpec,
  type DomainCalculatorSpec,
} from '../../../shared/calculators/domain-calculator-spec';
import type { ReferenceCalculatorDef, ReferenceCalculators } from '../../../shared/calculators/reference-calculator';

/**
 * The sand-casting calculator spec (sand-casting-calculators.json), validated: the current entry of each calculator. `includeSuperseded` keeps an entry a
 * later migration replaced, for generating the migration that shipped it (which stays byte-identical once applied).
 */
export function loadSandCastingCalculatorSpec(opts: { includeSuperseded?: boolean } = {}): DomainCalculatorSpec {
  const raw = spec as DomainCalculatorSpec;
  // Names are unique among the current entries; a superseded entry shares its replacement's name, so only the current set is validated.
  validateDomainCalculatorSpec({ ...raw, calculators: raw.calculators.filter((c) => c.supersededBy == null) });
  return { ...raw, calculators: raw.calculators.filter((c) => opts.includeSuperseded === true || c.supersededBy == null) };
}

/** The spec as the per-operation calculator set the engine receives (tests; the engine reads the database). */
export function sandCastingCalculatorsFromSpec(): ReferenceCalculators {
  return domainCalculatorsAsReference(loadSandCastingCalculatorSpec());
}

/** Every sand calculator by name, helpers included (sizing steps and machine variants no operation maps to). */
export function sandCastingCalculatorsByName(): Record<string, ReferenceCalculatorDef> {
  return domainCalculatorsByName(loadSandCastingCalculatorSpec());
}
