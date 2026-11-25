/**
 * The live cost line an edited process line is matched to, to pick its machine when the saved row has none (a line saved as a No Cost
 * Feature keeps its class but no HR Rates machine): first the line of the row's own machine class, then the line of the chosen operation,
 * then the category's first. A category can span several classes (Inspection holds the CMM station and the XRF analyzer): taking its
 * first line opened an XRF row on the inspection station and its calculator.
 */
export function engineLineForEdit<T extends { machineClass: string; process: string }>(
  liveForCategory: readonly T[],
  savedMachineClass: string | null | undefined,
  lineProcess: string | null | undefined,
): T | undefined {
  const ofClass = savedMachineClass ? liveForCategory.filter((l) => l.machineClass === savedMachineClass) : [];
  const pool = ofClass.length > 0 ? ofClass : liveForCategory;
  return (lineProcess ? pool.find((l) => l.process === lineProcess) : undefined) ?? pool[0];
}
