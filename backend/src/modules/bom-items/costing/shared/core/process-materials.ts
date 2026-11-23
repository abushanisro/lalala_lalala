// The material a process prices when the part's grade is not one of its own (user decision 2026-11-20: Apply never fails, every process
// route is costed). Each memory/<process> catalog holds its own materials with the process data its engine reads: a die-casting alloy's
// clamping pressure, a forging steel's flow stress, a resin's melt temperatures, a bar's stock price. A grade from another catalog has none
// of it, so the process prices its closest own material instead and says so; the part's own grade is not changed.
import { injectionMoldabilityGap, type MoldabilityMaterial } from '../../../../raw-materials/material-moldability';
import { ADDITIVE, RAPID_PROTOTYPING } from '../../additive/additive-domain';
import { BAR_TUBE_PROCESS_GROUP } from '../../bar-tube/bar-tube-route';
import { isSiliconeGrade } from '../../plastic-molding/process/process-tree';
import { ROTO_BLOW_PROCESS_GROUP } from '../../roto-blow/roto-blow-route';
import { CASTING_MATERIAL_GROUP } from '../../casting/casting-reference.service';
import { INVESTMENT_PROCESS_GROUP } from '../../casting/investment/investment-reference';
import { COMPOSITES_PROCESS_GROUP } from '../../composites/composites-route';
import { FORGING_PROCESS_GROUP } from '../../forging/forging-route';
import { POWDER_METAL_PROCESS_GROUP } from '../../powder-metal/powder-metal-route';
import { ROLL_FORMING_PROCESS_GROUP } from './part-family-process-group';

/**
 * The raw_materials group each part family's engine prices from, for the engines that price only their own materials. Machining and sheet
 * metal are not here: they price any grade from its own row (a PETG part is machined as PETG).
 */
export const PROCESS_OWN_MATERIAL_GROUP: Readonly<Record<string, string>> = {
  die_cast: CASTING_MATERIAL_GROUP.die_casting,
  sand_cast: CASTING_MATERIAL_GROUP.sand_casting,
  investment_cast: INVESTMENT_PROCESS_GROUP,
  forged: FORGING_PROCESS_GROUP,
  powder_metal: POWDER_METAL_PROCESS_GROUP,
  composite: COMPOSITES_PROCESS_GROUP,
  additive: ADDITIVE.materialGroup,
  bar_tube: BAR_TUBE_PROCESS_GROUP,
  roto_blow: ROTO_BLOW_PROCESS_GROUP,
  plastic_molded: 'Plastic & Rubber',
};

/**
 * Process groups costed as another group's family that price from materials of their own: a Rapid Prototyping part is priced by the additive
 * engine, from memory/Rapid prototyping's materials, not Additive Manufacturing's.
 */
const PROCESS_GROUP_OWN_MATERIAL_GROUP: Readonly<Record<string, string>> = {
  [RAPID_PROTOTYPING.processGroup]: RAPID_PROTOTYPING.materialGroup,
  // A roll formed part is analysed as sheet metal and priced from memory/Sheet metal roll forming's materials (their strengths are its feasibility).
  [ROLL_FORMING_PROCESS_GROUP]: ROLL_FORMING_PROCESS_GROUP,
};

/** The raw_materials group a part's engine prices from (its Process's own, else its family's); undefined when it prices any grade. */
export function ownMaterialGroup(family: string, processGroup: string | null | undefined): string | undefined {
  return (processGroup ? PROCESS_GROUP_OWN_MATERIAL_GROUP[processGroup] : undefined) ?? PROCESS_OWN_MATERIAL_GROUP[family];
}

/**
 * Families whose engine resolves the grade with the ranked material search (resolveMaterialForFamily), not by exact name: a grade the
 * search lands inside the group is the engine's own and is priced as given.
 */
const RANKED_SEARCH_FAMILIES: ReadonlySet<string> = new Set(['plastic_molded']);

export interface ProcessMaterial {
  name: string;
  grade: string | null;
  materialType: string | null;
  densityKgM3: number | null;
  /** What the molding engine judges a material by (material-moldability.ts): read for Plastic & Rubber's rows (enginePrices). */
  molding?: Omit<MoldabilityMaterial, 'grade' | 'materialType'>;
}

/** A raw_materials row the part's grade resolves to anywhere (the ranked search). */
export interface OwnMaterial {
  name: string | null;
  grade: string | null;
  materialGroup: string | null;
  materialType: string | null;
  densityKgM3: number | null;
}

export interface PricedGrade {
  /** The grade the process prices: the part's own, or its closest material of the process. */
  grade: string;
  /** Said to the user when the process prices another material than the part's; null when it prices the part's own. */
  note: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when the material is the grade: its name or grade, case-insensitively (the rule every engine matches a grade with). */
export function isMaterialNamed(m: { name: string | null; grade: string | null }, grade: string): boolean {
  return same(m.name, grade) || same(m.grade, grade);
}

/**
 * Whether `family`'s engine can price a material of its group, so that the material can stand in for a grade the process cannot use.
 * Plastic Molding prices from Plastic & Rubber, which also holds 3D-printing resins and powders and machining stock that no molding engine
 * prices: one of them chosen as the closest material priced a PA66 part as a printing resin at 240 USD/kg. A molding material is one the
 * injection engine can mold, by the rule it judges every material with (material-moldability.ts; a silicone by its cure time). Every other
 * group is its engine's own catalog.
 */
export function enginePrices(family: string, m: ProcessMaterial): boolean {
  if (family !== 'plastic_molded') return true;
  return !!m.molding && injectionMoldabilityGap({ ...m.molding, grade: m.name, materialType: m.materialType }, isSiliconeGrade(m.name)) === null;
}

type Closeness = 'grade' | 'variant' | 'material type' | 'nearest density' | 'unplaced';

/**
 * A material named as `name` with a qualifier after it, as the reference data names a material's variants: "Generic Acetal, Copolymer" is a
 * variant of "Generic Acetal". The name ends at a word: "Generic Nylon, Type 66" is no variant of "Generic Nylon, Type 6".
 */
function isVariantOf(m: { name: string | null; grade: string | null }, name: string): boolean {
  const base = name.trim().toLowerCase();
  return [m.name, m.grade].some((x) => !!x && x.toLowerCase().startsWith(base) && /^[\s,(]/.test(x.slice(base.length)));
}

/** The material type every one of the grade's rows has; null when they differ or none is known. */
function sharedMaterialType(own: readonly OwnMaterial[]): string | null {
  const first = own[0]?.materialType ?? null;
  return first && own.every((o) => same(o.materialType, first)) ? first : null;
}

/** The lower median of the densities known: the one the others are the least far from on average. Null when none is known. */
function medianDensity(densities: readonly (number | null)[]): number | null {
  const known = densities.filter((d): d is number => d != null).sort((a, b) => a - b);
  return known.length > 0 ? known[Math.floor((known.length - 1) / 2)] : null;
}

/**
 * The process's material closest to the part's grade, in one pass: one the grade names, then a variant of it, then one of its material type,
 * then the nearest density, then the first by name. `own` is what the search found the grade to be: its row, or the rows it fits equally
 * well when it cannot tell them apart, or none. An ambiguous grade's rows are equally likely the part's material, so any of their names
 * counts, their material type when they all have one, and the median of their densities, the least far from theirs on average.
 *
 * A variant comes before the material type because the reference data does not type a material alike in every group: "Acetal" is a
 * Thermoplastic in Machining's rows and an Acetal in Plastic & Rubber's, where a part named POM by its symbol had to land.
 *
 * A grade none of that places among the process's materials ('unplaced': no name, type or density to compare) is priced as the material of
 * median density. Nothing is known of what the grade is, so its weight, which the material is priced by, is the least off on average as the
 * median's. The first by name, which this used to be, said nothing of the grade: in Plastic & Rubber it was a printing resin at 240 USD/kg.
 * Null only when the process has no materials.
 */
export function closestProcessMaterial(own: readonly OwnMaterial[], materials: readonly ProcessMaterial[]): { material: ProcessMaterial; by: Closeness } | null {
  if (materials.length === 0) return null;
  const names = own.flatMap((o) => [o.name, o.grade]).filter((n): n is string => !!n);
  const type = sharedMaterialType(own);
  const kind = (m: ProcessMaterial) =>
    names.some((n) => isMaterialNamed(m, n)) ? 0 : names.some((n) => isVariantOf(m, n)) ? 1 : same(m.materialType, type) ? 2 : 3;
  const distance = (m: ProcessMaterial, to: number | null) => (to != null && m.densityKgM3 != null ? Math.abs(m.densityKgM3 - to) : Infinity);
  // The closest material to a density `to`, by kind first, then by name. Two unknown distances are equal (Infinity - Infinity is not a number).
  const closestTo = (to: number | null) => materials.reduce((b, m) => {
    const closer = kind(m) - kind(b) || (distance(m, to) === distance(b, to) ? 0 : distance(m, to) - distance(b, to)) || m.name.localeCompare(b.name);
    return closer < 0 ? m : b;
  });
  const density = medianDensity(own.map((o) => o.densityKgM3));
  const best = closestTo(density);
  if (kind(best) === 0) return { material: best, by: 'grade' };
  if (kind(best) === 1) return { material: best, by: 'variant' };
  if (kind(best) === 2) return { material: best, by: 'material type' };
  if (Number.isFinite(distance(best, density))) return { material: best, by: 'nearest density' };
  return { material: closestTo(medianDensity(materials.map((m) => m.densityKgM3))), by: 'unplaced' };
}

const kgM3 = (d: number) => `${Math.round(d)} kg/m³`;

/** What the note says the grade is, and why the stand-in is its closest material. */
function substituteNote(grade: string, processLabel: string, group: string, own: readonly OwnMaterial[], closest: { material: ProcessMaterial; by: Closeness }): string {
  const { material, by } = closest;
  const choose = `Choose a ${processLabel} material in Material Grade to price another.`;
  if (by === 'unplaced') {
    const unknown = own.length === 0
      ? `No material on file matches "${grade}", so its material type and density are unknown`
      : `Nothing on file relates "${grade}" to a ${processLabel} material by name, material type or density`;
    const density = material.densityKgM3 != null ? ` (${kgM3(material.densityKgM3)})` : '';
    return `${unknown}: priced as "${material.name}", the ${processLabel} material of median density${density}, whose weight is the least off on average. ${choose}`;
  }
  const type = sharedMaterialType(own);
  const densities = own.map((o) => o.densityKgM3).filter((d): d is number => d != null);
  const [lo, hi] = [Math.min(...densities), Math.max(...densities)];
  const span = densities.length === 0 ? 'density unknown' : lo === hi ? kgM3(lo) : `${Math.round(lo)} to ${kgM3(hi)}`;
  const what = own.length > 1
    ? `"${grade}" fits ${own.length} materials on file equally well (${type ? `${type}, ` : ''}${span})${by === 'grade' ? '' : `, none of them a ${processLabel} material`}`
    : own[0]?.materialGroup === group
      ? `"${grade}" is "${own[0].name ?? own[0].grade ?? ''}" on file, which ${processLabel} cannot price`
      : `"${grade}" is not a ${processLabel} material`;
  const base = own.flatMap((o) => [o.name, o.grade]).find((n) => !!n && isVariantOf(material, n));
  const why = by === 'grade' ? (own.length > 1 ? 'one of them' : 'the same grade')
    : by === 'variant' ? `a variant of "${base ?? ''}"`
    : by === 'material type' ? `the same material type, ${material.materialType ?? ''}`
    : 'nearest density';
  return `${what}: priced as "${material.name}", its closest ${processLabel} material (${why}). ${choose}`;
}

/**
 * The grade `family`'s engine prices (see the file comment). `materials` are the process group's rows; `own` is what the ranked search found
 * the part's grade to be: its row, the rows it fits equally well when it is ambiguous, or none. A family that prices any grade, or a grade of
 * the group, is priced as given; any other is priced as its closest material the engine can price (enginePrices), with a note saying so.
 */
export function pricedGradeFor(input: {
  family: string;
  /** The part's Process when it prices from materials of its own (ownMaterialGroup). */
  processGroup?: string | null;
  processLabel: string;
  grade: string;
  own: readonly OwnMaterial[];
  materials: readonly ProcessMaterial[];
}): PricedGrade {
  const { family, processLabel, grade, own, materials } = input;
  const group = ownMaterialGroup(family, input.processGroup);
  if (!group || materials.some((m) => isMaterialNamed(m, grade))) return { grade, note: null };
  const placed = own.length === 1 ? own[0] : null;
  const placedRow = placed?.materialGroup === group ? materials.find((m) => isMaterialNamed(m, placed.name ?? '') || isMaterialNamed(m, placed.grade ?? '')) : undefined;
  if (placed?.materialGroup === group && (!placedRow || enginePrices(family, placedRow))) {
    // The search placed the grade in the group: an exact-name engine needs the row's own name; a ranked-search engine finds it as given.
    // A row the engine cannot price ("PA 66 GF30" on a nylon with no injection data on file) is the search's guess, not the user's
    // choice of row, and gets a stand-in the engine prices like any other grade.
    return { grade: RANKED_SEARCH_FAMILIES.has(family) ? grade : (placed.name ?? placed.grade ?? grade), note: null };
  }
  const closest = closestProcessMaterial(own, materials.filter((m) => enginePrices(family, m)));
  if (!closest) return { grade, note: null };
  return { grade: closest.material.name, note: substituteNote(grade, processLabel, group, own, closest) };
}
