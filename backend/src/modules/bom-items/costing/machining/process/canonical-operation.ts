/**
 * Maps a machining feature_graph_v2 entry (reference feature_type + geometric
 * variant, emitted by cad-engine/machining/machining_feature_recognizer.py) to
 * the real "Operation // FeatureType" label it corresponds to in the reference
 * operation catalog (memory/machining/operations_full__operations.csv).
 *
 * Every pairing below is verified at module load against the generated
 * catalog (reference-features.generated.ts) — a pairing the catalog does not
 * contain throws on import instead of shipping a fabricated label.
 *
 * Compound catalog chains are labelled by the operation the catalog attaches
 * to the feature itself, e.g. a counterbore is the MultiStepHole of
 * "Multistep Holemaking//MultiStepHole:Counterboring//SimpleHole".
 *
 * An operation the catalog gives a feature only as a step of the machine's
 * setup ("3 Axis Lathe:Setup:Rough Milling//Flat", which the generated
 * vocabulary names "Setup:Rough Milling") is labelled by the operation itself,
 * as the cost engine names it: "Rough Milling // Flat".
 */
import { isTurnedFamily } from '../../../../../domain/part-family';
import { isReferenceOperation } from '../../shared/reference-features.generated';

type MachiningRouteFamily = 'milling' | 'turning';

const MILLING_OPERATION_BY_FEATURE: Readonly<Record<string, string>> = {
  'SimpleHole:through': 'Drilling',
  'SimpleHole:blind': 'Drilling',
  'SimpleHole:cross': 'Drilling',
  'SimpleHole:pcd_pattern': 'Drilling',
  'SimpleHole:threaded': 'Tapping',
  'MultiStepHole:counterbore': 'Multistep Holemaking',
  'MultiStepHole:stepped': 'Step Drilling',
  'Edge:countersink': 'Countersinking',
  'Edge:chamfer': 'Chamfering',
  'Edge:round': 'Rounding',
  'PocketV2:default': 'Rough Milling',
  'Slot:straight': 'Slot Milling',
  'Slot:radial': 'Slot Milling',
  'Slot:groove': 'Groove Milling',
  // The operation the cost engine mills a keyway by (operation-sequencer.ts KEYWAY_MILLING), so the feature and its cost row carry one name
  // and a machine is judged by the operation it is priced on: the catalog gives "Obround Slot Milling//Keyway" to the mills, the 3 axis
  // lathes, MillTurn and Simultaneous Turning. The tolerance capability table links the operation to Milling (operation_capability_process,
  // migration 1120): that is the capability a keyway's tolerances are judged against (feature-tolerance.service.ts).
  'Keyway:default': 'Obround Slot Milling',
  // A flat milled on a turned diameter (cad-engine _classify_turned_flat): the catalog's "Rough Milling//Flat", a step of the setup on the
  // 3 axis lathes, MillTurn and the mills. It is the operation the cost engine mills a flat by (operation-sequencer.ts), and the tolerance
  // capability table links it to Milling.
  'Flat:default': 'Rough Milling',
  'Cutout:default': 'Perimeter Milling',
  'PlanarFace:default': 'Fine Finish Milling',
  'CurvedWall:default': 'Contouring',
  'CurvedSurface:default': 'Contouring',
  'Ring:outer_diameter': 'Rough Turning',
  'Ring:groove': 'Plunging',
};

// Turning routes (lathes, bar-feed variants, MillTurn) chamfer an edge with a
// live tool: the catalog's lathe rows carry "Mill Chamfering//Edge", not the
// milling-only "Chamfering//Edge". Every other feature resolves identically.
const TURNING_OPERATION_BY_FEATURE: Readonly<Record<string, string>> = {
  ...MILLING_OPERATION_BY_FEATURE,
  'Edge:chamfer': 'Mill Chamfering',
};

for (const table of [MILLING_OPERATION_BY_FEATURE, TURNING_OPERATION_BY_FEATURE]) {
  for (const [key, operation] of Object.entries(table)) {
    const featureType = key.split(':')[0];
    if (!isReferenceOperation('machining', featureType, operation) && !isReferenceOperation('machining', featureType, `Setup:${operation}`)) {
      throw new Error(`canonical-operation: "${operation} // ${featureType}" is not in the reference machining catalog`);
    }
  }
}

export function machiningRouteFamilyOf(cadFamily: string | null | undefined): MachiningRouteFamily {
  return isTurnedFamily(cadFamily) ? 'turning' : 'milling';
}

/** "Operation // FeatureType", or null when the feature has no mapped operation. */
export function resolveCanonicalOperation(
  featureType: string,
  variant: string | null | undefined,
  family: MachiningRouteFamily,
): string | null {
  const table = family === 'turning' ? TURNING_OPERATION_BY_FEATURE : MILLING_OPERATION_BY_FEATURE;
  const operation = table[`${featureType}:${variant ?? 'default'}`];
  return operation ? `${operation} // ${featureType}` : null;
}
