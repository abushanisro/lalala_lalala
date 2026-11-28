import { describe, expect, it } from "vitest";

import type { DrawingReading } from "@/lib/api/drawing-readings";
import { carriesFiles, costable, gradeFor, intakeFileKind, isPicture, planBlockers, planPart, processGroupFor, shapeSummary, type IntakePlan, type PlanPart } from "@/lib/intake/plan";

const GROUPS = ["Die Casting", "Forging", "Machining", "Plastic Molding", "Sand Casting", "Sheet Metal"];
const bracket: DrawingReading = {
  isDrawing: true, partName: "MOUNTING BRACKET", partNumber: "TEST-BRKT-100", revision: "B", material: "AL 6061-T6", units: "mm", quantity: 2,
  process: { family: "machining", reason: "Note 3 states 'MACHINE FROM PLATE'." },
  shape: { kind: "block", lengthMm: 120, widthMm: 60, heightMm: 12 },
  holes: [{ diameterMm: 6.6, depthMm: null, count: 4, thread: null }, { diameterMm: 6, depthMm: 10, count: 2, thread: "M6x1 - 6H" }],
  tightestToleranceMm: 0.1, surfaceFinishRaUm: 3.2, notes: [], unsure: ["The drill depth of the tapped holes is not stated."],
};

describe("intakeFileKind", () => {
  it("sends drawings to the reader and CAD files to the import, and takes nothing else", () => {
    expect(["bracket.PNG", "scan.jpeg", "shaft.pdf", "photo.webp"].map(intakeFileKind)).toEqual(["drawing", "drawing", "drawing", "drawing"]);
    expect(["part.step", "PART.STP", "assembly.zip"].map(intakeFileKind)).toEqual(["cad", "cad", "cad"]);
    expect(["notes.docx", "model.sldprt", "noextension"].map(intakeFileKind)).toEqual([null, null, null]);
  });
});

describe("isPicture", () => {
  it("is true for a picture the page can show, and not for a PDF drawing or a CAD file", () => {
    expect(["bracket.PNG", "scan.jpeg", "photo.jpg", "part.webp", "Pasted image 1.png", "anim.gif"].map(isPicture)).toEqual([true, true, true, true, true, true]);
    expect(["shaft.pdf", "part.step", "assembly.zip", "noextension"].map(isPicture)).toEqual([false, false, false, false]);
  });
});

describe("shapeSummary", () => {
  it("says what the model will be built as", () => {
    expect(shapeSummary(bracket.shape, bracket.holes)).toBe("Block 120 × 60 × 12 mm, 6 holes");
    expect(shapeSummary({ kind: "sheet", lengthMm: 300, widthMm: 200.5, thicknessMm: 2 }, [{ diameterMm: 5, depthMm: null, count: 1, thread: null }])).toBe("Sheet 300 × 200.5 mm, 2 mm thick, 1 hole");
    expect(shapeSummary({ kind: "turned", segments: [{ diameterMm: 80, lengthMm: 15 }, { diameterMm: 40, lengthMm: 60 }], boreDiameterMm: 20 }, [])).toBe("Turned, ⌀80 × 75 mm in 2 steps, ⌀20 bore");
    expect(shapeSummary(null, [])).toBe("No overall size on the drawing");
  });
});

describe("processGroupFor", () => {
  it("names the catalog's group for a family that has exactly one, and leaves casting to the person", () => {
    expect(processGroupFor("machining", GROUPS)).toBe("Machining");
    expect(processGroupFor("sheet_metal", GROUPS)).toBe("Sheet Metal");
    expect(processGroupFor("plastic_molding", GROUPS)).toBe("Plastic Molding");
    expect(processGroupFor("casting", GROUPS)).toBeNull();
    expect(processGroupFor("other", GROUPS)).toBeNull();
    expect(processGroupFor(undefined, GROUPS)).toBeNull();
    expect(processGroupFor("forging", ["Machining"])).toBeNull();          // not in this catalog
  });
});

describe("gradeFor", () => {
  const grades = ["Generic Aluminum, ANSI 6061 (LD30)", "Aluminum, ANSI 6061", "Aluminum, ANSI 7050", "Generic Stainless Steel, 416", "Steel, AISI 4140"];
  it("finds the grade that carries the drawing's designation number, the plainest name first", () => {
    expect(gradeFor("AL 6061-T6", grades)).toBe("Aluminum, ANSI 6061");
    expect(gradeFor("SS 416", grades)).toBe("Generic Stainless Steel, 416");
    expect(gradeFor("4140 steel, hardened", grades)).toBe("Steel, AISI 4140");
  });

  it("does not guess: no designation number, or none in the database, is no grade", () => {
    expect(gradeFor("Aluminium", grades)).toBeNull();
    expect(gradeFor("AL 2024-T3", grades)).toBeNull();
    expect(gradeFor("6061", ["Steel 16061"])).toBeNull();                   // a number inside another number is not it
    expect(gradeFor(null, grades)).toBeNull();
  });
});

describe("planPart", () => {
  it("turns a reading into a part to create, with the process the drawing indicates and no grade until one is matched", () => {
    expect(planPart("bracket.png", bracket, GROUPS)).toEqual({
      file: "bracket.png", name: "MOUNTING BRACKET", partNumber: "TEST-BRKT-100", quantity: 2, materialRead: "AL 6061-T6", grade: null,
      processGroup: "Machining", processReason: "Note 3 states 'MACHINE FROM PLATE'.", shape: bracket.shape, holes: bracket.holes,
      unsure: ["The drill depth of the tapped holes is not stated."],
    });
  });

  it("names a part after its file when the drawing has no title block, and takes nothing from a file that is not a drawing", () => {
    expect(planPart("flange rev2.pdf", { ...bracket, partName: null, partNumber: null, quantity: null, process: null }, GROUPS))
      .toMatchObject({ name: "flange rev2", partNumber: "flange rev2", quantity: 1, processGroup: null, processReason: null });
    expect(planPart("cat.jpg", { ...bracket, isDrawing: false }, GROUPS)).toBeNull();
  });
});

describe("what a plan still needs", () => {
  const read = planPart("bracket.png", bracket, GROUPS);
  if (!read) throw new Error("the test drawing is a drawing");
  const part = (over: Partial<PlanPart> = {}): PlanPart => ({ ...read, grade: "Aluminum, ANSI 6061", ...over });
  const plan = (over: Partial<IntakePlan> = {}): IntakePlan =>
    ({ projectName: "Bracket", bomName: "From drawings", location: "India", annualVolume: null, batchSize: null, parts: [part()], cadFiles: [], ...over });

  it("costs a part that has a size, a process and a grade, and says which is missing otherwise", () => {
    expect(costable(part())).toEqual({ ok: true });
    const sizeless = costable(part({ shape: null }));
    expect(sizeless.ok ? "" : sizeless.why).toContain("no overall size");
    expect(costable(part({ processGroup: null }))).toEqual({ ok: false, why: "Choose the process to cost this part." });
    expect(costable(part({ grade: null }))).toEqual({ ok: false, why: "Choose the material grade to cost this part." });
  });

  it("is ready with names and, when anything is to be costed, a place of manufacture", () => {
    expect(planBlockers(plan())).toEqual([]);
    expect(planBlockers(plan({ projectName: " ", location: "" }))).toEqual(["Give the project a name.", "Choose where the parts are made."]);
    expect(planBlockers(plan({ location: "", parts: [part({ shape: null })] }))).toEqual([]);            // nothing to cost: no location needed
    expect(planBlockers(plan({ parts: [], cadFiles: [] }))).toEqual(["Nothing to create: no part was read and no CAD file was added."]);
    expect(planBlockers(plan({ parts: [], cadFiles: ["a.step"], location: "" }))).toEqual([]);
    expect(planBlockers(plan({ parts: [part({ name: "" })] }))).toEqual(["Every part needs a name and a part number."]);
  });
});

describe("a drag over the page", () => {
  it("is the prompt's to take only when it carries files, not selected text or a link", () => {
    expect(carriesFiles(["Files"])).toBe(true);
    expect(carriesFiles(["text/uri-list", "Files"])).toBe(true);
    expect(carriesFiles(["text/plain", "text/html"])).toBe(false);
    expect(carriesFiles([])).toBe(false);
    expect(carriesFiles(undefined)).toBe(false);
  });
});
