import { describe, expect, it } from "vitest";

import type { DrawingReading } from "@/lib/api/drawing-readings";
import { applyAnswer, hollowProne, matchChoice, narrative, needKey, nextNeed, questionFor, sizeFrom, type Lists } from "@/lib/intake/conversation";
import type { IntakePlan, PlanPart } from "@/lib/intake/plan";

const LISTS: Lists = {
  groups: ["Die Casting", "Forging", "Machining", "Plastic Molding", "Roto & Blow Molding", "Sand Casting", "Sheet Metal", "Stock Machining"],
  grades: ["ABS, General Purpose", "ABS, High Impact", "PC/ABS Blend", "Polypropylene, Homopolymer", "Aluminum, ANSI 6061", "Generic Aluminum, ANSI 6061 (LD30)"],
  locations: ["India", "USA", "Germany"],
};
const part = (over: Partial<PlanPart> = {}): PlanPart => ({
  file: "mirror.png", name: "Car side mirror cover", partNumber: "mirror", quantity: 1, materialRead: null, grade: null, processGroup: null,
  processReason: null, shape: null, holes: [], unsure: [], ...over,
});
const plan = (parts: PlanPart[], over: Partial<IntakePlan> = {}): IntakePlan =>
  ({ projectName: "Mirror", bomName: "Parts from drawings", location: "", annualVolume: null, batchSize: null, parts, cadFiles: [], ...over });
const block = { kind: "block", lengthMm: 250, widthMm: 120, heightMm: 90 } as const;
const shell = { kind: "shell", lengthMm: 250, widthMm: 120, heightMm: 90, wallMm: 2.5 } as const;

describe("nextNeed", () => {
  it("asks for a part's process, then its size, then whether it is hollow, then its material, then where it is made", () => {
    expect(nextNeed(plan([part()]), [])).toEqual({ kind: "process", part: "mirror.png" });
    expect(nextNeed(plan([part({ processGroup: "Plastic Molding" })]), [])).toEqual({ kind: "size", part: "mirror.png" });
    expect(nextNeed(plan([part({ processGroup: "Plastic Molding", shape: block })]), [])).toEqual({ kind: "wall", part: "mirror.png" });
    expect(nextNeed(plan([part({ processGroup: "Plastic Molding", shape: shell })]), [])).toEqual({ kind: "grade", part: "mirror.png" });
    expect(nextNeed(plan([part({ processGroup: "Plastic Molding", shape: shell, grade: "ABS, General Purpose" })]), [])).toEqual({ kind: "location", part: null });
    expect(nextNeed(plan([part({ processGroup: "Plastic Molding", shape: shell, grade: "ABS, General Purpose" })], { location: "India" }), [])).toBeNull();
  });

  it("asks whether a part is hollow only when it is moulded or cast and known as a block, and only once", () => {
    expect([null, "Machining", "Sheet Metal", "Forging"].map(hollowProne)).toEqual([false, false, false, false]);
    expect(["Plastic Molding", "Die Casting", "Sand Casting", "Casting Investment", "Roto & Blow Molding"].map(hollowProne)).toEqual([true, true, true, true, true]);
    expect(nextNeed(plan([part({ processGroup: "Machining", shape: block })]), [])).toEqual({ kind: "grade", part: "mirror.png" });
    const settled = [needKey({ kind: "wall", part: "mirror.png" })];
    expect(nextNeed(plan([part({ processGroup: "Die Casting", shape: block })]), settled)).toEqual({ kind: "grade", part: "mirror.png" });   // said to be solid: its other questions go on
  });

  it("asks nothing more about a part the person skipped a question for, and does not ask where when no part can be costed", () => {
    const skipped = [needKey({ kind: "size", part: "mirror.png" })];
    expect(nextNeed(plan([part({ processGroup: "Plastic Molding" })]), skipped)).toBeNull();
    const two = plan([part({ processGroup: "Plastic Molding" }), part({ file: "b.png", name: "Bracket" })]);
    expect(nextNeed(two, skipped)).toEqual({ kind: "process", part: "b.png" });
  });

  it("does not ask again where the parts are made once that was skipped", () => {
    const ready = plan([part({ processGroup: "Machining", shape: block, grade: "Aluminum, ANSI 6061" })]);
    expect(nextNeed(ready, [needKey({ kind: "location", part: null })])).toBeNull();
  });
});

describe("questionFor", () => {
  it("offers the processes of the family the drawing points to, with the one it means as the pick and its reason", () => {
    const q = questionFor({ kind: "process", part: "mirror.png" }, plan([part()]), LISTS, { family: "plastic_molding", reason: "The form is a moulded cover." });
    expect(q.text).toBe("Which process makes Car side mirror cover?");
    expect(q.options.map(o => o.value)).toEqual(["Plastic Molding", "Roto & Blow Molding"]);
    expect(q.pick).toBe("Plastic Molding");
    expect(q.options[0]).toEqual({ value: "Plastic Molding", why: "The form is a moulded cover." });
    expect(q.choices).toEqual(LISTS.groups);
  });

  it("offers the casting processes with no pick, and the common processes when the drawing points to none", () => {
    const casting = questionFor({ kind: "process", part: "mirror.png" }, plan([part()]), LISTS, { family: "casting", reason: "Cast boss." });
    expect(casting.options.map(o => o.value)).toEqual(["Die Casting", "Sand Casting"]);
    expect(casting.pick).toBeNull();
    const none = questionFor({ kind: "process", part: "mirror.png" }, plan([part()]), LISTS, null);
    expect(none.options.map(o => o.value)).toEqual(["Machining", "Sheet Metal", "Plastic Molding", "Die Casting", "Sand Casting", "Forging"]);
    expect(none.pick).toBeNull();
  });

  it("offers the grades the drawing's material names, the exact one as the pick; with no material, it asks to search", () => {
    const named = questionFor({ kind: "grade", part: "mirror.png" }, plan([part({ materialRead: "AL 6061-T6", processGroup: "Machining" })]), LISTS);
    expect(named.pick).toBe("Aluminum, ANSI 6061");
    expect(named.options.map(o => o.value)).toEqual(["Aluminum, ANSI 6061", "Generic Aluminum, ANSI 6061 (LD30)"]);
    expect(named.options[0]?.why).toBe('The drawing says "AL 6061-T6".');
    const silent = questionFor({ kind: "grade", part: "mirror.png" }, plan([part({ processGroup: "Plastic Molding" })]), LISTS);
    expect(silent.options).toEqual([]);
    expect(silent.pick).toBeNull();
    expect(silent.hint).toMatch(/names no material/);
    expect(silent.choices).toEqual(LISTS.grades);
  });

  it("asks a size in the person's own words, and the place from the list", () => {
    const size = questionFor({ kind: "size", part: "mirror.png" }, plan([part({ processGroup: "Plastic Molding" })]), LISTS);
    expect(size.options).toEqual([]);
    expect(size.choices).toEqual([]);
    expect(size.skip).toBe("Skip, and the part is created without a cost.");
    const where = questionFor({ kind: "location", part: null }, plan([part()]), LISTS);
    expect(where.options.map(o => o.value)).toEqual(["India", "USA", "Germany"]);
    expect(where.skip).toBe("Skip, and the parts are created without a cost.");
  });

  it("asks whether a moulded part is hollow, offering Solid, and says a skip costs it as a block", () => {
    const wall = questionFor({ kind: "wall", part: "mirror.png" }, plan([part({ processGroup: "Plastic Molding", shape: block })]), LISTS);
    expect(wall.text).toBe("Is Car side mirror cover hollow?");
    expect(wall.hint).toMatch(/Type its wall thickness in mm/);
    expect(wall.options).toEqual([{ value: "Solid", why: "Not hollow: it is costed as the solid block." }]);
    expect(wall.pick).toBeNull();
    expect(wall.skip).toBe("Skip, and it is costed as a solid block.");
  });
});

describe("matchChoice", () => {
  it("takes the same text whatever its case, or the only choice holding every word typed", () => {
    expect(matchChoice("plastic molding", LISTS.groups)).toEqual({ value: "Plastic Molding" });
    expect(matchChoice("  pc abs ", LISTS.grades)).toEqual({ value: "PC/ABS Blend" });
    expect(matchChoice("abs", LISTS.grades)).toEqual({ error: 'Several match "abs": ABS, General Purpose; ABS, High Impact; PC/ABS Blend. Type more of the name.' });
    expect(matchChoice("titanium", LISTS.grades)).toEqual({ error: 'Nothing here is called "titanium".' });
    expect(matchChoice("  ", LISTS.grades)).toEqual({ error: "Choose an answer, or type one." });
  });
});

describe("sizeFrom", () => {
  it("reads three numbers as a block, largest first, in millimetres", () => {
    expect(sizeFrom("120 x 250 x 90", null)).toEqual({ kind: "block", lengthMm: 250, widthMm: 120, heightMm: 90 });
    expect(sizeFrom("250×120×90 mm", "Plastic Molding")).toEqual(block);
    expect(sizeFrom("250, 120, 90", null)).toEqual(block);
    expect(sizeFrom("about 25 cm by 12 cm by 9 cm", null)).toEqual(block);
    expect(sizeFrom('10" x 5" x 2"', null)).toEqual({ kind: "block", lengthMm: 254, widthMm: 127, heightMm: 50.8 });
  });

  it("reads a sheet when the process is sheet metal, and a round part from a diameter and a length", () => {
    expect(sizeFrom("300 x 200 x 2", "Sheet Metal")).toEqual({ kind: "sheet", lengthMm: 300, widthMm: 200, thicknessMm: 2 });
    expect(sizeFrom("⌀40 x 120", "Machining")).toEqual({ kind: "turned", segments: [{ diameterMm: 40, lengthMm: 120 }], boreDiameterMm: null });
    expect(sizeFrom("dia 40 length 120", null)).toEqual({ kind: "turned", segments: [{ diameterMm: 40, lengthMm: 120 }], boreDiameterMm: null });
  });

  it("does not read the word in as inches, and refuses what is not a size", () => {
    expect(sizeFrom("size in mm: 250 120 90", null)).toEqual(block);
    for (const typed of ["big", "250 x 120", "0 x 10 x 10", "1 2 3 4", "99999 x 10 x 10"]) expect(sizeFrom(typed, null)).toBeNull();
  });
});

describe("applyAnswer", () => {
  const q = (kind: "process" | "size" | "wall" | "grade" | "location", p: IntakePlan) => questionFor({ kind, part: kind === "location" ? null : "mirror.png" }, p, LISTS);

  it("sets the process (and forgets a grade chosen for another one), the size, the grade and the place", () => {
    const start = plan([part({ grade: "Aluminum, ANSI 6061" })]);
    const processed = applyAnswer(start, q("process", start), "plastic molding");
    expect(processed).toMatchObject({ said: "Plastic Molding", plan: { parts: [{ processGroup: "Plastic Molding", grade: null }] } });
    if ("error" in processed) throw new Error(processed.error);
    const sized = applyAnswer(processed.plan, q("size", processed.plan), "250 x 120 x 90");
    expect(sized).toMatchObject({ said: "Block 250 × 120 × 90 mm", plan: { parts: [{ shape: block }] } });
    if ("error" in sized) throw new Error(sized.error);
    const graded = applyAnswer(sized.plan, q("grade", sized.plan), "ABS, High Impact");
    expect(graded).toMatchObject({ said: "ABS, High Impact", plan: { parts: [{ grade: "ABS, High Impact" }] } });
    if ("error" in graded) throw new Error(graded.error);
    expect(applyAnswer(graded.plan, q("location", graded.plan), "india")).toMatchObject({ said: "India", plan: { location: "India" } });
  });

  it("makes a block a shell from its wall thickness, keeps it a block when it is solid, and refuses a wall that leaves nothing hollow", () => {
    const sized = plan([part({ processGroup: "Plastic Molding", shape: block })]);
    expect(applyAnswer(sized, q("wall", sized), "2.5 mm")).toMatchObject({ said: "Hollow 250 × 120 × 90 mm, 2.5 mm wall", plan: { parts: [{ shape: shell }] } });
    expect(applyAnswer(sized, q("wall", sized), "solid")).toEqual({ plan: sized, said: "Solid" });
    // Holes the drawing gave stay with the part, so the cost's note can say they are not in the shell.
    const holed = plan([part({ processGroup: "Plastic Molding", shape: block, holes: [{ diameterMm: 4, depthMm: null, count: 4, thread: null }] })]);
    expect(applyAnswer(holed, q("wall", holed), "2.5")).toMatchObject({ plan: { parts: [{ shape: shell, holes: [{ count: 4 }] }] } });
    expect(applyAnswer(sized, q("wall", sized), "60")).toEqual({ error: "A wall of 60 mm leaves nothing hollow in a part 120 mm wide and 90 mm high." });
    expect(applyAnswer(sized, q("wall", sized), "thin")).toEqual({ error: "Type the wall thickness in mm, like 2.5, or choose Solid." });
  });

  it("says why an answer cannot be used, and leaves the plan as it was", () => {
    const start = plan([part({ processGroup: "Plastic Molding" })]);
    expect(applyAnswer(start, q("size", start), "quite big")).toEqual({ error: expect.stringMatching(/does not read as a size/) as string });
    expect(applyAnswer(start, q("grade", start), "unobtainium")).toEqual({ error: 'Nothing here is called "unobtainium".' });
  });
});

describe("narrative", () => {
  const reading = (over: Partial<DrawingReading> = {}): DrawingReading => ({
    isDrawing: true, partName: "Car side mirror cover", partNumber: null, revision: null, material: null, units: null, quantity: null,
    process: { family: "plastic_molding", reason: "The form is a thin moulded cover." }, shape: null, holes: [], tightestToleranceMm: null,
    surfaceFinishRaUm: null, notes: [], unsure: [], ...over,
  });

  it("says what the part is, what indicates its process, and what the picture does not give", () => {
    expect(narrative(reading(), "mirror.png")).toBe("This is Car side mirror cover. The form is a thin moulded cover. It names no material. It gives no overall size.");
  });

  it("gives the material and the size when the drawing has them, and what was not clear", () => {
    const text = narrative(reading({ partNumber: "BRKT-1", material: "AL 6061-T6", process: null, shape: block, unsure: ["The drill depth is not stated."] }), "b.png");
    expect(text).toBe("This is Car side mirror cover (BRKT-1). Material on the drawing: AL 6061-T6. Overall: Block 250 × 120 × 90 mm. Not clear to me: The drill depth is not stated.");
  });

  it("says when a file is not a part at all", () => {
    expect(narrative(reading({ isDrawing: false }), "cat.png")).toBe("cat.png is not a drawing or a picture of a manufactured part, so it is left out.");
  });
});
