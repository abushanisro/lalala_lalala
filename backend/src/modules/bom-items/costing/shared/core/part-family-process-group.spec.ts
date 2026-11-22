import * as fs from 'fs';
import * as path from 'path';

import { MACHINING_FAMILIES, isMachiningFamily } from '../../../../../domain/part-family';
import {
  MACHINED_FAMILY_HINT, NO_CAD_EXTRACTOR_FAMILIES, costedProcessGroups, familiesAnalysedForHint, familiesOfProcessGroup, familyHintOfProcessGroup,
  processChoiceConflict,
} from './part-family-process-group';

describe('the family hint a process group is analysed with', () => {
  it('is "machined" for Machining: the geometry picks milled, turned or mill-turn, a shaft is not forced to milled', () => {
    expect(familiesOfProcessGroup('Machining')).toEqual(['milled', 'turned', 'mill_turn']);
    expect(familyHintOfProcessGroup('Machining')).toBe('machined');
  });

  it('still names the one family of a group costed as a single family, machining or not', () => {
    expect(familyHintOfProcessGroup('Multi-Spindle Machining')).toBe('turned');
    expect(familyHintOfProcessGroup('2-Model Machining')).toBe('two_model');
    expect(familyHintOfProcessGroup('Sheet Metal')).toBe('sheet_metal');
    expect(familyHintOfProcessGroup('Sheet Metal Roll Forming')).toBe('sheet_metal');
    expect(familyHintOfProcessGroup('Sand Casting')).toBe('sand_cast');
  });

  it('names the first family of a group costed as several families that are not all machining (Casting is analysed as a die casting)', () => {
    expect(familyHintOfProcessGroup('Casting')).toBe('die_cast');
  });

  it('is none for a group with no cost model, or with no CAD extractor, or no group at all', () => {
    expect(familyHintOfProcessGroup('Sheet Plastic')).toBeUndefined();
    expect(familyHintOfProcessGroup('Assembly')).toBeUndefined();
    expect(familyHintOfProcessGroup('Part Assembly')).toBeUndefined();
    expect(familyHintOfProcessGroup(null)).toBeUndefined();
    expect(familyHintOfProcessGroup('')).toBeUndefined();
  });

  // The rule is by what a group is costed as, not by its name: a group that joins COSTED_AS_FAMILIES as every machining family gets the
  // hint without a line here.
  it('follows one rule for every costed group: "machined" exactly when it is costed as several families, all of them machining', () => {
    for (const group of costedProcessGroups()) {
      const families = familiesOfProcessGroup(group).filter((f) => !NO_CAD_EXTRACTOR_FAMILIES.has(f));
      const severalMachining = families.length > 1 && families.every((f) => isMachiningFamily(f));
      expect([group, familyHintOfProcessGroup(group)]).toEqual([group, severalMachining ? MACHINED_FAMILY_HINT : families[0]]);
    }
  });

  it('"machined" is the cad-engine\'s own hint, and no family', () => {
    const py = fs.readFileSync(path.resolve(__dirname, '../../../../../../../cad-engine/shared/part_family.py'), 'utf-8');
    expect(py).toMatch(new RegExp(`^MACHINED_HINT = "${MACHINED_FAMILY_HINT}"$`, 'm'));
    expect(isMachiningFamily(MACHINED_FAMILY_HINT)).toBe(false);
    expect(familiesOfProcessGroup('Machining')).not.toContain(MACHINED_FAMILY_HINT);
  });
});

describe('the families an analysis run with a hint may store', () => {
  it('is the hinted family for a hint that names one', () => {
    expect(familiesAnalysedForHint('sheet_metal')).toEqual(['sheet_metal']);
    expect(familiesAnalysedForHint('turned')).toEqual(['turned']);
  });

  it('is any machining family for the two hints that say only "machined"', () => {
    expect(familiesAnalysedForHint('machined')).toEqual([...MACHINING_FAMILIES]);
    expect(familiesAnalysedForHint('two_model')).toEqual([...MACHINING_FAMILIES]);
  });
});

describe('processChoiceConflict', () => {
  it('names the Process the geometry calls for when the chosen one disagrees', () => {
    expect(processChoiceConflict({ family: 'sheet_metal', geometricFamily: 'milled' })).toBe(
      "This part's Process is Sheet Metal, but its geometry reads as Machining (milled). Set its Process to Machining; reanalyzing as Sheet Metal will not change this.",
    );
  });

  it('says nothing when they agree, are of one process group, or either is unknown', () => {
    expect(processChoiceConflict({ family: 'sheet_metal', geometricFamily: 'sheet_metal' })).toBeNull();
    expect(processChoiceConflict({ family: 'milled', geometricFamily: 'turned' })).toBeNull(); // both Machining
    expect(processChoiceConflict({ family: 'sheet_metal' })).toBeNull(); // an analysis from an older engine
    expect(processChoiceConflict({ family: 'sheet_metal', geometricFamily: 'something_new' })).toBeNull();
    expect(processChoiceConflict(undefined)).toBeNull();
  });
});
