// The tooling of a roll forming line (memory/Sheet metal roll forming), each costed by its calculator and spread over the job; kept out of the
// piece cost and written on Apply (route-tooling.ts). The data has no formula for either; the models are the engine's own, agreed with the user
// 2026-11-22 and disclosed on the quote:
//   - the mill's rolls: toolingMultiplier_Standard (toolingMultiplier_Panel for a panel profile; the Cost Guide's multiplier when set) x the strip
//     width x the roll stations, with profit and SG&A; one set lasts toolLifeByMaterial's parts for the material's type;
//   - the punch press's progressive die and the cut-off press's die (a compact die model): design and assembly hours at the tool shop's rates,
//     die shoes from dieShoeSizes (tool steel and their machining at cncMillingRates), the standard components of each punched feature
//     (componentStandardCosts), the cut-off blade or scissor inserts (toolingComponentAttributes), tuning on the cut-off die, heat treatment
//     when its variable says so, with profit and SG&A; a die lasts numPartsPerTool parts (its re-sharpening is a line stoppage).
// Pure: the tool shop's rates and tool steel come in from the caller.
import { stepRow, type DieStation } from './roll-forming-features';

import type { RollFormPart } from './roll-forming-part';
import type { SandReference } from '../casting/sand/sand-reference';
import type { ToolShop } from '../casting/tool-shop';
import type { CalcSeed, ReferenceCalcRun } from '../shared/calculators/reference-calculator';
import type { KitRow, RouteKit } from '../shared/calculators/route-kit';

export const RF_TOOL_CALC = { rolls: 'Roll Forming - Roll Tooling', die: 'Roll Forming - Press Die' } as const;

/** A tool the line needs: an investment kept out of the piece cost, spread over the job (null when not costed, with why in `detail`). */
export interface RollFormingTool {
  key: 'roll-tooling' | 'punch-die' | 'cut-off-die';
  description: string;
  detail: string;
  /** One tool, USD; null when not costed. */
  costUsd: number | null;
  /** The tools the job wears out (one tool x copies), USD; null when not costed or the job has no volume. */
  investmentUsd: number | null;
  /** The investment over the job's parts, USD per part; null when not costed or the job has no volume. */
  perPartUsd: number | null;
  /** Parts the investment is spread over (annual volume x production life); null when not costed or the job has no volume. */
  amortizationParts: number | null;
  /** Tools the job wears out; null when not costed or the job has no volume. */
  copies: number | null;
  /** Parts one tool makes; null when not known. */
  toolLife: number | null;
  run: ReferenceCalcRun | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().toLowerCase() : '');

/** Spread over the job: copies = ceil(parts / life); the investment and its share of each part. */
function amortise(costUsd: number, toolLife: number | null, parts: number | null): Pick<RollFormingTool, 'investmentUsd' | 'perPartUsd' | 'amortizationParts' | 'copies'> {
  if (!(parts != null && parts > 0) || !(toolLife != null && toolLife > 0)) return { investmentUsd: null, perPartUsd: null, amortizationParts: null, copies: null };
  const copies = Math.max(1, Math.ceil(parts / toolLife - 1e-9));
  const investment = costUsd * copies;
  return { investmentUsd: r2(investment), perPartUsd: Math.round((investment / parts) * 10000) / 10000, amortizationParts: parts, copies };
}

/** toolLifeByMaterial's row of a material type ("Galv. Steel" is filed as Galvanized Steel), or null. */
export function toolLifeRow(ref: SandReference, materialType: string | null): KitRow | null {
  const want = text(materialType) === 'galv. steel' ? 'galvanized steel' : text(materialType);
  return want ? ref.table('toolLifeByMaterial').find((r) => text(r['Material Type']) === want) ?? null : null;
}

/** The mill's rolls: one set for the profile's stations, its life by the material's type. */
export function rollTooling(inp: {
  kit: RouteKit; ref: SandReference; stripWidthMm: number; stations: number; panel: boolean; multiplierOverride: number | null; materialType: string | null;
  amortizationParts: number | null;
}): { tool: RollFormingTool; warnings: string[] } {
  const { kit, ref } = inp;
  const warnings: string[] = [];
  const name = inp.panel ? 'toolingMultiplier_Panel' : 'toolingMultiplier_Standard';
  const multiplier: CalcSeed | undefined = inp.multiplierOverride != null
    ? kit.seed(inp.multiplierOverride, `${inp.multiplierOverride} (Cost Guide rollFormToolingMultiplier; the data's ${name} is ${ref.number(name) ?? '?'})`)
    : ref.number(name) != null ? { ...kit.variable(name)!, source: `${kit.variable(name)!.source}: ${inp.panel ? 'a panel profile' : 'a standard profile'}` } : undefined;
  const description = `Roll forming rolls (${inp.stations} station${inp.stations === 1 ? '' : 's'}${inp.panel ? ', panel' : ''})`;
  const run = kit.run(RF_TOOL_CALC.rolls, null, { tooling_multiplier: multiplier, roll_stations: kit.seed(inp.stations, `${inp.stations} roll stations (Roll Forming - Stations)`) });
  if (!('run' in run)) {
    return {
      tool: { key: 'roll-tooling', description, detail: `Not costed: ${run.reasons.join('; ')}`, costUsd: null, investmentUsd: null, perPartUsd: null, amortizationParts: null, copies: null, toolLife: null, run: null },
      warnings: [`The roll tooling is not costed: ${run.reasons.join('; ')}.`],
    };
  }
  const row = toolLifeRow(ref, inp.materialType);
  const life = row != null ? Number(row['Num Parts Per Tool']) : ref.number('numPartsPerTool');
  if (row == null) warnings.push(`The roll tooling's life is numPartsPerTool (${ref.number('numPartsPerTool') ?? '?'} parts): toolLifeByMaterial has no row for ${inp.materialType ?? 'the material\'s type'}.`);
  const spread = amortise(run.sec, life, inp.amortizationParts);
  if (spread.investmentUsd == null) warnings.push('The roll tooling is not spread over the job: the scenario has no annual volume and production life.');
  return {
    tool: {
      key: 'roll-tooling', description,
      detail: `${r2(run.run.outputs['Tool Subtotal'] ?? 0)} USD (multiplier ${multiplier?.value ?? '?'} x ${r2(inp.stripWidthMm)} mm strip x ${inp.stations} stations) with profit and SG&A; `
        + `one set lasts ${life != null ? Math.round(life).toLocaleString('en-US') : '?'} parts (${row != null ? `toolLifeByMaterial ${String(row['Material Type'])}` : 'numPartsPerTool'}); `
        + `${spread.copies ?? '?'} set(s) over ${inp.amortizationParts ?? '?'} parts. The rule is the engine's (the data has no roll tooling formula), agreed 2026-11-22.`,
      costUsd: r2(run.sec), ...spread, toolLife: life, run: run.run,
    },
    warnings,
  };
}

/** A die's plan (mm, the larger side first) and the steel of its inserts (mm³), with how each is found. */
export interface DiePlan {
  lengthMm: number;
  widthMm: number;
  insertVolumeMm3: number;
  basis: string;
}

/**
 * The progressive die: along the strip punchDieBlockLengthAllowance plus each station's largest feature (its pitch), across the strip
 * punchDieBlockWidthAllowance more than the strip. No inserts beyond its standard components.
 */
export function punchDiePlan(ref: SandReference, stripWidthMm: number, stations: readonly DieStation[]): DiePlan | null {
  const attrs = componentAttributes(ref);
  const along = attrs('punchDieBlockLengthAllowance');
  const across = attrs('punchDieBlockWidthAllowance');
  if (along == null || across == null) return null;
  const l = along + stations.reduce((s, st) => s + st.maxSizeMm, 0);
  const w = stripWidthMm + across;
  return {
    lengthMm: Math.max(l, w), widthMm: Math.min(l, w), insertVolumeMm3: 0,
    basis: `${stations.length} station(s) along the strip (punchDieBlockLengthAllowance ${along} mm + each station's largest feature), the ${r2(stripWidthMm)} mm strip + punchDieBlockWidthAllowance ${across} mm across`,
  };
}

/**
 * The cut-off die: cutOffDieBlockLengthAllowance plus its inserts along the strip, the section's width plus cutOffDieBlockWidthAllowance
 * across. Its inserts (toolingComponentAttributes) are blocks as wide as the section plus their width adder: a blade cut-off's blade
 * (bladeThickness, as tall as the section plus bladeAllowanceGap), blade holder and static die insert; a scissor cut-off's static and crop die
 * inserts. The data gives no insert height: the blade holder's (bladeHolderHeight) is used for every block but the blade.
 */
export function cutOffDiePlan(ref: SandReference, section: RollFormPart['section'], cutOff: 'scissor' | 'blade'): DiePlan | null {
  const a = componentAttributes(ref);
  const along = a('cutOffDieBlockLengthAllowance');
  const across = a('cutOffDieBlockWidthAllowance');
  const height = a('bladeHolderHeight');
  if (along == null || across == null || height == null) return null;
  const w = section.widthMm;
  const block = (len: string, adder: string) => {
    const l = a(len);
    const add = a(adder);
    return l != null && add != null ? { l, volume: l * (w + add) * height } : null;
  };
  let inserts: { l: number; volume: number }[];
  let basis: string;
  if (cutOff === 'blade') {
    const t = a('bladeThickness');
    const gap = ref.number('bladeAllowanceGap') ?? 0;
    const bladeAdder = a('blade_widthAdder');
    const blade = t != null && bladeAdder != null ? { l: t, volume: t * (w + bladeAdder) * (section.heightMm + gap) } : null;
    const holderLen = a('bladeHolderLength');
    const holder = holderLen != null && bladeAdder != null ? { l: holderLen, volume: holderLen * (w + bladeAdder) * height } : null;
    const insert = block('cutOffBladeStaticDieInsertLength', 'cutOffBladeStaticDieInsert_widthAdder');
    inserts = [blade, holder, insert].filter((x): x is { l: number; volume: number } => x != null);
    basis = 'the blade, its holder and the static die insert';
  } else {
    const insert = block('cutOffScissorStaticDieInsertLength', 'cutOffScissorStaticDieInsert_widthAdder');
    const crop = block('cutOffCropDieInsertLength', 'cutOffCropDieInsert_widthAdder');
    inserts = [insert, crop].filter((x): x is { l: number; volume: number } => x != null);
    basis = 'the static and crop die inserts';
  }
  const l = along + inserts.reduce((s, i) => s + i.l, 0);
  const width = w + across;
  return {
    lengthMm: Math.max(l, width), widthMm: Math.min(l, width), insertVolumeMm3: inserts.reduce((s, i) => s + i.volume, 0),
    basis: `${basis} (toolingComponentAttributes; ${height} mm high, bladeHolderHeight) along cutOffDieBlockLengthAllowance ${along} mm, the ${r2(w)} mm section + cutOffDieBlockWidthAllowance ${across} mm across`,
  };
}

/** A toolingComponentAttributes value by name, or null. */
function componentAttributes(ref: SandReference): (name: string) => number | null {
  const rows = ref.table('toolingComponentAttributes');
  return (name) => {
    const v = rows.find((r) => r.Name === name)?.Value;
    return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
  };
}

/** A press die (the progressive die or the cut-off die) by the compact die model, spread over the job at numPartsPerTool parts a die. */
export function pressDie(inp: {
  kit: RouteKit; ref: SandReference; kind: 'punch' | 'cut-off'; cutOff: 'scissor' | 'blade'; plan: DiePlan | null; punchedFeatures: number;
  toolShop: ToolShop | null; amortizationParts: number | null;
}): { tool: RollFormingTool; warnings: string[] } {
  const { kit, ref } = inp;
  const cut = inp.kind === 'cut-off';
  const key = cut ? 'cut-off-die' : 'punch-die';
  const description = cut ? `Cut-off die (${inp.cutOff === 'blade' ? 'blade' : 'scissor'})` : `Punch press progressive die (${inp.punchedFeatures} punched feature${inp.punchedFeatures === 1 ? '' : 's'})`;
  const notCosted = (why: string) => ({
    tool: { key, description, detail: `Not costed: ${why}`, costUsd: null, investmentUsd: null, perPartUsd: null, amortizationParts: null, copies: null, toolLife: null, run: null } as RollFormingTool,
    warnings: [`The ${description.toLowerCase()} is not costed: ${why}.`],
  });
  const shop = inp.toolShop;
  if (!shop) return notCosted('the tool shop (Digital Factory USA Default: its rates and tool steel) is not on file');
  const density = shop.toolSteel.densityKgM3;
  if (!(density != null && density > 0)) return notCosted(`the density of the tool shop's ${shop.toolSteel.name} is not on file`);
  if (!inp.plan) return notCosted('toolingComponentAttributes lacks the die block allowances');
  const plan = inp.plan;
  const shoe = [...ref.table('dieShoeSizes')]
    .filter((r) => Number.isFinite(Number(r['Length (mm)'])) && Number.isFinite(Number(r['Width (mm)'])))
    .sort((a, b) => Number(a['Length (mm)']) - Number(b['Length (mm)']))
    .find((r) => Number(r['Length (mm)']) >= plan.lengthMm - 1e-9 && Number(r['Width (mm)']) >= plan.widthMm - 1e-9) ?? null;
  if (!shoe) return notCosted(`dieShoeSizes has no shoe for a ${r2(plan.lengthMm)} x ${r2(plan.widthMm)} mm die`);
  const shoeL = Number(shoe['Length (mm)']);
  const shoeW = Number(shoe['Width (mm)']);
  const shoeT = Number(shoe['Upper Shoe Thickness (mm)']) + Number(shoe['Lower Shoe Thickness (mm)']);
  const shoeKg = (shoeL * shoeW * shoeT * density) / 1e9;
  const shoeArea = 2 * shoeL * shoeW;
  const milling = stepRow(ref.table('cncMillingRates'), 'Area (mm^2)', shoeArea);
  const component = (name: string) => kit.lookupSeed('componentStandardCosts', ref.table('componentStandardCosts').find((r) => r.Name === name), 'Cost (USD)', ['Name']);
  const variableSum = (names: readonly string[]) => {
    const values = names.map((n) => [n, ref.number(n)] as const);
    return kit.seed(values.reduce((s, [, v]) => s + (v ?? 0), 0), values.map(([n, v]) => `${n} ${v ?? 0}`).join(' + '));
  };
  const heatName = cut ? 'cutOffToolingHeatTreat' : 'punchToolingHeatTreat';
  const heat = ref.flag(heatName) === true;
  const tuning = cut ? ref.number('percentTuning') ?? 0 : 0;
  const prefix = cut ? 'cutOff' : 'punch';
  const run = kit.run(RF_TOOL_CALC.die, null, {
    design_rate: kit.seed(shop.designUsdPerHr, `tool shop ${shop.name}: designRateUsdPerHr`),
    assembly_rate: kit.seed(shop.assemblyUsdPerHr, `tool shop ${shop.name}: assemblyRateUsdPerHr`),
    shoe_steel_kg: kit.seed(shoeKg, `dieShoeSizes ${shoeL} x ${shoeW} mm (upper ${String(shoe['Upper Shoe Thickness (mm)'])} + lower ${String(shoe['Lower Shoe Thickness (mm)'])} mm) at ${shop.toolSteel.name}'s ${density} kg/m³, for a ${r2(plan.lengthMm)} x ${r2(plan.widthMm)} mm die: ${plan.basis}`),
    shoe_area_mm2: kit.seed(shoeArea, `the two shoes' ${shoeL} x ${shoeW} mm faces`),
    profiling_rate: kit.lookupSeed('cncMillingRates', milling, 'Profiling Rate (mm^2 / hr)', ['Area (mm^2)']),
    machining_rate: kit.seed(shop.machiningUsdPerHr, `tool shop ${shop.name}: machiningRateUsdPerHr`),
    steel_price: kit.seed(shop.toolSteel.usdPerKg, `${shop.toolSteel.name} (tool shop ${shop.name}'s default tool material)`),
    punched_features: kit.seed(inp.punchedFeatures, cut ? 'the cut-off die punches no feature' : 'the features the progressive die punches'),
    punch_cost: component('piercePunchStandard'),
    button_cost: component('dieButton'),
    retainer_cost: component('piercePunchRetainerStandard'),
    stripper_pin_cost: component('stripperPinAssy'),
    insert_steel_kg: kit.seed((plan.insertVolumeMm3 * density) / 1e9, plan.insertVolumeMm3 > 0 ? `${plan.basis.split(' (')[0]} at ${density} kg/m³` : 'no inserts beyond the standard components'),
    heat_treat: kit.seed(heat ? 1 : 0, `${heatName} ${ref.text(heatName) ?? '(not set)'}`),
    other_costs: variableSum([`${prefix}CarryingTotalCost`, `${prefix}FreightCost`, `${prefix}GageCost`, `${prefix}ToolingWeldingCost`]),
    tuning: kit.seed(tuning, cut ? `percentTuning ${tuning} (the cut-off die)` : 'no tuning on the progressive die (percentTuning is the cut-off press\'s)'),
  });
  if (!('run' in run)) return notCosted(run.reasons.join('; '));
  const life = ref.number('numPartsPerTool');
  const spread = amortise(run.sec, life, inp.amortizationParts);
  const warnings = spread.investmentUsd == null ? [`The ${description.toLowerCase()} is not spread over the job: the scenario has no annual volume and production life.`] : [];
  return {
    tool: {
      key, description,
      detail: `Compact die model: design, assembly, ${shoeL} x ${shoeW} mm die shoes (${r2(shoeKg)} kg of ${shop.toolSteel.name}), ${cut ? plan.basis.split(' (')[0] : `${inp.punchedFeatures} punch set(s)`}`
        + `${tuning ? `, ${r2(tuning * 100)} % tuning` : ''}${heat ? ', heat treated' : ''}, with profit and SG&A; one die lasts ${life != null ? Math.round(life).toLocaleString('en-US') : '?'} parts (numPartsPerTool), `
        + `${spread.copies ?? '?'} die(s) over ${inp.amortizationParts ?? '?'} parts. The die model is the engine's (agreed 2026-11-22).`,
      costUsd: r2(run.sec), ...spread, toolLife: life, run: run.run,
    },
    warnings,
  };
}
