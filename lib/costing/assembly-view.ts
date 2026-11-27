import { withRow, withoutRow, type RowVocabulary, type TableRow } from '@/lib/costing/joint-table';
import type { BOMItem, CostSummaryDto } from '@/lib/api/hooks/useBOMItems';

export type AssemblySummary = NonNullable<CostSummaryDto['assembly']>;
export type AssemblyJointView = AssemblySummary['joints'][number];

/** The scenario keys of the assembly settings (backend assembly-cost.service.ts ASSEMBLY_ROUTE_KEY, assembly-joints.ts ASSEMBLY_JOINTS_KEY). */
export const ASSEMBLY_SCENARIO_KEYS = {
  route: 'assemblyRoute',
  joints: 'assemblyJoints',
} as const;

/** A measure a joint can carry, as the joint table stores it (backend assembly-joints.ts parseJointRow). */
export type JointField = 'operation' | 'count' | 'lengthMm' | 'throatMm' | 'depthMm' | 'areaMm2' | 'weldMaterial' | 'gas' | 'position' | 'wireDiameterMm' | 'timeS' | 'prep' | 'cleanUp';

/** One row of the Cost Guide's joint table, as stored under assemblyJoints. */
export type JointRow = TableRow<JointField>;

/** What the fastening time table gives each Mechanical Assembly operation (backend AssemblyBreakdown.operationTimes). */
export type OperationTimes = NonNullable<AssemblySummary['operationTimes']>;

/**
 * A joint type as the dialog offers it: an Assembly process and, where the process has several operations (memory/Assembly's
 * operations.csv: a mechanical fastening, an ultrasonic joint), one of them, so a press fit is picked as a press fit. `required` are the
 * measures its calculator needs, `optional` the ones it can also take.
 */
interface JointKind { process: string; operation?: string; label: string; required: JointField[]; optional: JointField[] }

const MECHANICAL = 'Mechanical Assembly';
const ULTRASONIC = 'Ultrasonic Welding';
/** The engineer's own operation (backend assembly-joints.ts USER_DEFINED_OPERATION): no table can time it. */
const OWN_OPERATION = 'User-Defined Operation';
/** The operation the engine takes for a row that names none (backend assembly-route.ts). */
const DEFAULT_OPERATION: Readonly<Record<string, string>> = { [MECHANICAL]: 'Screw Tighten - Manual', [ULTRASONIC]: 'weld' };

const fastening = (operation: string, label: string): JointKind => ({ process: MECHANICAL, operation, label, required: ['count'], optional: ['timeS'] });
const ultrasonic = (operation: string, label: string): JointKind => ({ process: ULTRASONIC, operation, label, required: ['count'], optional: ['lengthMm'] });
const SEAM: JointField[] = ['prep', 'cleanUp'];

const JOINT_KINDS: readonly JointKind[] = [
  fastening('Screw Tighten - Manual', 'Screw, hand driven'),
  fastening('Screw Tighten - Power', 'Screw, power driven'),
  fastening('Press Fit', 'Press fit'),
  fastening('Snap Fit', 'Snap fit'),
  fastening('Nut Insert', 'Nut insert'),
  fastening('Tab Bend', 'Tab bend'),
  fastening('Rivet', 'Rivet, at the assembly bench'),
  fastening(OWN_OPERATION, 'Another fastening, by its time'),
  { process: 'Rivet', label: 'Rivet, at a riveting station', required: ['count', 'timeS'], optional: [] },
  { process: 'Threaded Insert', label: 'Threaded insert', required: ['count'], optional: [] },
  { process: 'Lock Bolt', label: 'Lock bolt', required: ['count'], optional: [] },
  { process: 'MIG Welding', label: 'MIG weld', required: ['count', 'lengthMm', 'throatMm'], optional: ['weldMaterial', 'gas', 'wireDiameterMm', ...SEAM] },
  { process: 'TIG Welding', label: 'TIG weld', required: ['count', 'lengthMm', 'throatMm'], optional: ['weldMaterial', 'gas', 'position', ...SEAM] },
  { process: 'Spot Welding', label: 'Spot welds', required: ['count'], optional: [] },
  { process: 'Electron Beam Welding', label: 'Electron beam weld', required: ['count', 'lengthMm', 'depthMm'], optional: [...SEAM] },
  { process: 'Laser Welding', label: 'Laser weld', required: ['count', 'lengthMm', 'depthMm'], optional: [...SEAM] },
  ultrasonic('weld', 'Ultrasonic weld'),
  ultrasonic('stake', 'Ultrasonic stake'),
  ultrasonic('insertion', 'Ultrasonic insertion'),
  { process: 'Adhesive Bonding', label: 'Adhesive bond', required: ['count', 'areaMm2'], optional: [] },
  { process: 'Fay Sealing', label: 'Fay sealing', required: ['count', 'areaMm2'], optional: [] },
  { process: 'Fillet Sealing', label: 'Fillet sealing', required: ['count', 'lengthMm'], optional: [] },
  { process: 'Cap Sealing', label: 'Cap sealing', required: ['count'], optional: [] },
];

const keyOf = (k: Pick<JointKind, 'process' | 'operation'>) => (k.operation ? `${k.process}: ${k.operation}` : k.process);
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The type of a row: its process, and its operation where the process has several (none, or one the engine does not know: the engine's default). */
function kindOfRow(row: JointRow): JointKind | undefined {
  const ofProcess = JOINT_KINDS.filter((k) => k.process === row.process);
  const named = typeof row.operation === 'string' ? ofProcess.find((k) => k.operation !== undefined && sameText(k.operation, row.operation as string)) : undefined;
  return named ?? ofProcess.find((k) => k.operation === undefined || k.operation === DEFAULT_OPERATION[row.process]);
}

/** The choices of a text measure (backend assembly-joints.ts). */
const JOINT_CHOICES: Readonly<Partial<Record<JointField, readonly string[]>>> = {
  weldMaterial: ['Steel', 'Aluminum', 'Stainless Steel'],
  gas: ['Argon', 'Argon CO2 Mix', 'Hydrogen'],
  position: ['Flat', 'Horizontal', 'Overhead'],
};

const JOINT_FIELD_LABELS: Readonly<Record<JointField, string>> = {
  operation: 'Operation', count: 'Count', lengthMm: 'Length (mm, each)', throatMm: 'Throat (mm)', depthMm: 'Penetration (mm)', areaMm2: 'Area (mm², each)',
  weldMaterial: 'Material', gas: 'Gas', position: 'Position', wireDiameterMm: 'Wire (mm)', timeS: 'Time (s, each)', prep: 'Edge prep', cleanUp: 'Clean up',
};
/** The measures the dialog shows and prunes; the operation is part of the joint type, so it is kept on the row as the type sets it. */
const JOINT_MEASURES = (Object.keys(JOINT_FIELD_LABELS) as JointField[]).filter((f) => f !== 'operation');

/**
 * What a joint of each type takes: the Cost Guide's joint dialog.
 *
 * `times` is what the fastening time table gives each mechanical operation (the summary's operationTimes). An operation it has no time for
 * (memory/Assembly names press fit, tab bend and the rest and times none of them) needs the engineer's time per joint, so such a joint cannot
 * be saved uncosted; one it has a time for can still take the engineer's own. `derived`: a joint found in a part's threaded holes stays a
 * mechanical fastening, so only those types are offered for it.
 */
export function jointVocabulary(times?: OperationTimes | null, derived = false): RowVocabulary<JointField> {
  /** The table's time for a mechanical row's operation: null when it has none, undefined when not told (or not a mechanical fastening). */
  const tableTime = (row: JointRow): number | null | undefined => {
    const k = kindOfRow(row);
    if (k?.process !== MECHANICAL) return undefined;
    if (k.operation === OWN_OPERATION) return null;
    return times?.find((t) => t.operation === k.operation)?.timeS;
  };
  const needsTime = (row: JointRow) => tableTime(row) === null;
  const kinds = derived ? JOINT_KINDS.filter((k) => k.process === MECHANICAL) : JOINT_KINDS;
  return {
    fields: JOINT_MEASURES,
    kinds: kinds.map((k) => ({ process: k.process, key: keyOf(k), label: k.label })),
    kindOf: (row) => { const k = kindOfRow(row); return k ? keyOf(k) : row.process; },
    required: (row) => { const k = kindOfRow(row); return !k ? ['count'] : needsTime(row) ? [...k.required, 'timeS'] : k.required; },
    optional: (row) => { const k = kindOfRow(row); return !k ? [] : needsTime(row) ? k.optional.filter((f) => f !== 'timeS') : k.optional; },
    choices: (field) => JOINT_CHOICES[field] ?? null,
    label: (field) => JOINT_FIELD_LABELS[field],
    placeholder: (field, row) => {
      const time = field === 'timeS' ? tableTime(row) : undefined;
      return typeof time === 'number' ? `${time}, the fastening time table's` : undefined;
    },
    flags: new Set<JointField>(SEAM),
    // A joint of another type keeps its name and count; the rest belongs to the old type.
    rekind: (row, key) => {
      const k = JOINT_KINDS.find((x) => keyOf(x) === key);
      return {
        id: row.id, process: k?.process ?? key, ...(k?.operation ? { operation: k.operation } : {}),
        ...(row.label ? { label: row.label } : {}), count: typeof row.count === 'number' ? row.count : 1,
      };
    },
  };
}

/**
 * A derived joint switched on or off. Off is a row of its id with enabled: false; back on, that row keeps any edit made to it (and is
 * dropped when it held nothing else).
 */
export function withDerivedEnabled(table: readonly JointRow[], joint: Pick<AssemblyJointView, 'id' | 'process' | 'operation' | 'count'>, enabled: boolean): JointRow[] {
  const existing = table.find((r) => r.id === joint.id);
  if (enabled) {
    if (!existing) return [...table];
    const { enabled: _off, ...rest } = existing;
    const edited = Object.keys(rest).some((k) => !['id', 'process', 'operation', 'count'].includes(k)) || rest.operation !== joint.operation || rest.count !== joint.count;
    return edited ? withRow(table, rest) : withoutRow(table, joint.id);
  }
  return withRow(table, { ...(existing ?? { id: joint.id, process: joint.process, ...(joint.operation ? { operation: joint.operation } : {}), count: joint.count }), enabled: false });
}

/** A joint's measures as one line ("2 x 300 mm, 4 mm throat, Steel"). */
export function jointMeasures(j: Pick<AssemblyJointView, 'count' | 'lengthMm' | 'throatMm' | 'depthMm' | 'areaMm2' | 'weldMaterial' | 'gas' | 'position' | 'timeS'>): string {
  return [
    j.lengthMm != null ? `${j.count} x ${j.lengthMm} mm` : j.areaMm2 != null ? `${j.count} x ${j.areaMm2.toLocaleString('en-US')} mm²` : `${j.count}`,
    j.throatMm != null ? `${j.throatMm} mm throat` : null,
    j.depthMm != null ? `${j.depthMm} mm deep` : null,
    j.weldMaterial, j.gas, j.position,
    j.timeS != null ? `${j.timeS} s each` : null,
  ].filter(Boolean).join(', ');
}

/**
 * Whether an item is costed as an assembly (backend material-resolution.service.ts resolveEffectiveFamily): its Process is Assembly, or it is
 * an assembly or sub-assembly with no Process of its own.
 */
export function isAssemblyItem(item: Pick<BOMItem, 'itemType' | 'scenarioOverrides'> | null | undefined): boolean {
  if (!item) return false;
  const group = item.scenarioOverrides?.processGroup;
  if (typeof group === 'string' && group.trim() !== '') return group === 'Assembly';
  return item.itemType === 'assembly' || item.itemType === 'sub_assembly';
}
