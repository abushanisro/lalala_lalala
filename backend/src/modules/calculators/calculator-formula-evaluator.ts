import { erf, evaluate } from 'mathjs';

/**
 * Shared mathjs-based formula evaluator, extracted from
 * CalculatorsServiceV2.execute() so cost-engine.ts (the live/automatic cost
 * path) can evaluate the SAME DB-stored calculator formulas the interactive
 * "Edit Process Cost" calculator dialog uses, instead of re-implementing a
 * formula in TypeScript that happens to currently match. Behavior here is
 * byte-identical to the original execute() logic (see calculators.service.ts).
 */

export interface CalculatorFieldRow {
  id: string;
  field_name: string;
  field_type: string;
  default_value?: string | number | null;
  display_order?: number | null;
}

interface CalculatorFormulaRow {
  id: string;
  formula_name?: string | null;
  formula_expression?: string | null;
  execution_order?: number | null;
}

/**
 * The inverse error function: the x with erf(x) = y, for y strictly between -1 and 1. Newton's method on mathjs's erf, from a closed-form start
 * (Winitzki's approximation, within 2e-3), to machine precision in a few steps. Used by heat-conduction formulas, e.g. the time for a depth of sand
 * to reach a temperature: t = d^2 / (4 alpha erfinv(theta)^2).
 */
export function erfInverse(y: number): number {
  if (!Number.isFinite(y) || y <= -1 || y >= 1) throw new Error('ERFINV requires a value strictly between -1 and 1');
  if (y === 0) return 0;
  const a = 0.147;
  const ln = Math.log(1 - y * y);
  const t = 2 / (Math.PI * a) + ln / 2;
  let x = Math.sign(y) * Math.sqrt(Math.sqrt(t * t - ln / a) - t);
  for (let i = 0; i < 8; i++) {
    const step = ((erf(x) as number) - y) / ((2 / Math.sqrt(Math.PI)) * Math.exp(-x * x));
    x -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return x;
}

interface EvaluatorLogger {
  log: (message: string) => void;
  error: (message: string) => void;
  warn: (message: string) => void;
}

const noopLogger: EvaluatorLogger = { log: () => {}, error: () => {}, warn: () => {} };

// Replace all non-alphanumeric sequences with a single underscore, trim
// leading/trailing underscores — makes a human field name mathjs-safe.
export function normalizeFieldName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface EvaluateFormulasResult {
  // Keyed by both field/formula id AND field_name/formula_name, matching
  // the response shape the frontend already reads by name.
  results: Record<string, any>;
  // Final scope (normalized-name -> value) after every calculated field and
  // formula has evaluated — useful for a caller that wants a specific named
  // result directly instead of re-deriving it from `results`.
  scope: Record<string, any>;
}

export function evaluateCalculatorFormulas(
  fields: CalculatorFieldRow[],
  formulas: CalculatorFormulaRow[],
  inputValues: Record<string, any>,
  logger: EvaluatorLogger = noopLogger,
): EvaluateFormulasResult {
  const scope: Record<string, any> = { ...inputValues };

  // Normalize field values into scope (non-calculated fields only).
  fields.forEach((field) => {
    if (field.field_type === 'calculated') return;

    const given = inputValues[field.id] !== undefined ? inputValues[field.id] : inputValues[field.field_name];
    // A cleared box ('', or null) gives no value: read as 0 it made every speed it capped 0 and every time divided by it infinite.
    const val = given === '' || given === null || (typeof given === 'string' && given.trim() === '') ? undefined : given;

    if (val !== undefined && field.field_name) {
      const numericValue = field.field_type === 'number' || !isNaN(Number(val)) ? Number(val) : val;
      const normalizedName = normalizeFieldName(field.field_name);
      scope[normalizedName] = numericValue;
      logger.log(`Loaded field: "${field.field_name}" as "${normalizedName}" = ${numericValue}`);
    } else if (field.default_value !== undefined && field.default_value !== null) {
      const defaultValue = field.field_type === 'number' || !isNaN(Number(field.default_value))
        ? Number(field.default_value)
        : field.default_value;
      const normalizedName = normalizeFieldName(field.field_name);
      scope[normalizedName] = defaultValue;
      logger.log(`Loaded field (default): "${field.field_name}" as "${normalizedName}" = ${defaultValue}`);
    }
  });

  const results: Record<string, any> = {};

  // Excel-compatible custom functions.
  const customFunctions = {
    IF: (condition: boolean, trueValue: any, falseValue: any) => (condition ? trueValue : falseValue),
    LN: (value: number) => {
      if (value <= 0) throw new Error('LN function requires a positive value');
      return Math.log(value);
    },
    LOG: (value: number) => {
      if (value <= 0) throw new Error('LOG function requires a positive value');
      return Math.log10(value);
    },
    // Confirmed missing: Machining - Tapping's "Time per Use" formula
    // (CEIL({Machining Time})) threw "Undefined function CEIL" — mathjs has
    // no built-in CEIL (only lowercase ceil, not exposed to formula scope).
    CEIL: (value: number) => Math.ceil(value),
    // The inverse of erf (see erfInverse): heat-conduction formulas solve the error-function solution for time or depth.
    ERFINV: (value: number) => erfInverse(value),
  };
  Object.assign(scope, customFunctions);

  // Calculated fields, in display_order (dependency chain — a field can
  // reference an earlier-evaluated calculated field by name).
  const calculatedFields = fields
    .filter((field) => field.field_type === 'calculated')
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const fieldNameMap = new Map<string, string>();
  fields.forEach((f) => {
    if (f.field_name) fieldNameMap.set(f.field_name, normalizeFieldName(f.field_name));
  });
  const sortedFieldNames = Array.from(fieldNameMap.keys()).sort((a, b) => b.length - a.length);
  const fieldOfIdentifier = new Map(Array.from(fieldNameMap.entries()).map(([name, id]) => [id, name] as const));
  // The calculated fields that could not be calculated: a field that reads one says so, rather than "Undefined symbol".
  const failed = new Set<string>();
  /** What a formula lacks, in the calculator's field names. */
  const explain = (message: string): string => {
    const symbol = /Undefined symbol (\w+)/.exec(message)?.[1];
    if (!symbol) return message;
    const name = fieldOfIdentifier.get(symbol) ?? symbol;
    return failed.has(symbol) ? `needs ${name}, which could not be calculated` : `${name} has no value: enter it`;
  };
  /** A result that is not a finite number names the inputs at 0 it divided by (a cleared speed, a zero feed). */
  const finite = (fieldName: string, expression: string, result: unknown): unknown => {
    if (typeof result !== 'number' || Number.isFinite(result)) return result;
    const zeros = Array.from(new Set(Array.from(expression.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g), (m) => m[0])))
      .filter((id) => fieldOfIdentifier.has(id) && scope[id] === 0)
      .map((id) => fieldOfIdentifier.get(id)!);
    throw new Error(`${fieldName} is ${String(result)}${zeros.length > 0 ? `: ${zeros.join(', ')} ${zeros.length > 1 ? 'are' : 'is'} 0` : ''}`);
  };

  for (const field of calculatedFields) {
    try {
      if (!field.default_value) continue;

      let expression = String(field.default_value);
      if (expression.trim().startsWith('=')) {
        expression = expression.trim().substring(1).trim();
      }

      // {Field Name} -> normalized identifier.
      expression = expression.replace(/\{([^}]+)\}/g, (_match, fieldName: string) => {
        const trimmedName = fieldName.trim();
        const normalizedName = normalizeFieldName(trimmedName);
        logger.log(`Replacing "{${trimmedName}}" with "${normalizedName}"`);
        return normalizedName;
      });

      // Bare (non-braced) field-name references, longest-first to avoid
      // partial matches.
      for (const originalName of sortedFieldNames) {
        const normalizedName = fieldNameMap.get(originalName)!;
        if (originalName !== normalizedName) {
          const regex = new RegExp(`\\b${originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          const before = expression;
          expression = expression.replace(regex, normalizedName);
          if (before !== expression) logger.log(`Replacing bare "${originalName}" with "${normalizedName}"`);
        }
      }

      logger.log(`Original formula: "${field.default_value}"`);
      logger.log(`Normalized formula: "${expression}"`);

      const result = finite(field.field_name || field.id, expression, evaluate(expression, scope));

      if (field.field_name) {
        const normalizedName = normalizeFieldName(field.field_name);
        scope[normalizedName] = result;
      }

      results[field.id] = result;
      if (field.field_name) results[field.field_name] = result;
    } catch (e: any) {
      const message = explain(String(e?.message ?? e));
      logger.error(`✗ Error calculating field "${field.field_name}": ${message}`);
      if (field.field_name) failed.add(normalizeFieldName(field.field_name));
      results[field.id] = { error: message, value: null };
      if (field.field_name) results[field.field_name] = { error: message, value: null };
    }
  }

  // Standalone formulas (calculator_formulas table), in execution_order.
  const sortedFormulas = [...formulas].sort((a, b) => (a.execution_order || 0) - (b.execution_order || 0));

  for (const formula of sortedFormulas) {
    try {
      if (!formula.formula_expression) continue;

      let expression = formula.formula_expression.trim();
      if (expression.startsWith('=')) expression = expression.substring(1).trim();

      const result = finite(formula.formula_name || formula.id, expression, evaluate(expression, scope));

      if (formula.formula_name) scope[formula.formula_name] = result;

      results[formula.id] = result;
      if (formula.formula_name) results[formula.formula_name] = result;
    } catch (e: any) {
      const message = explain(String(e?.message ?? e));
      logger.error(`Error calculating formula ${formula.formula_name || 'unknown'}: ${message}`);
      results[formula.id] = { error: message, value: null };
      if (formula.formula_name) results[formula.formula_name] = { error: message, value: null };
    }
  }

  return { results, scope };
}
