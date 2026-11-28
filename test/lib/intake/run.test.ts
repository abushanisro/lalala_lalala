import { describe, expect, it } from "vitest";

import type { IntakePlan, PlanPart } from "@/lib/intake/plan";
import { bomPath, partPath, runIntake, stepFile, type IntakeApi, type IntakeEvent, type PartOutcome } from "@/lib/intake/run";

const part = (file: string, over: Partial<PlanPart> = {}): PlanPart => ({
  file, name: file.replace(".png", ""), partNumber: `PN-${file}`, quantity: 2, materialRead: "AL 6061-T6", grade: "Aluminum, ANSI 6061", processGroup: "Machining",
  processReason: null, shape: { kind: "block", lengthMm: 120, widthMm: 60, heightMm: 12 }, holes: [], unsure: [], ...over,
});
const plan = (over: Partial<IntakePlan> = {}): IntakePlan =>
  ({ projectName: " Bracket job ", bomName: "From drawings", location: "India", annualVolume: 5000, batchSize: null, parts: [part("a.png")], cadFiles: [], ...over });
const file = (name: string) => new File(["x"], name);

/** A server that records what it was asked, in order. `fail` names a call to refuse. */
function server(fail?: (call: string) => string | null, analysis: boolean[] = [true]) {
  const calls: string[] = [];
  const say = <T>(call: string, answer: T): Promise<T> => {
    calls.push(call);
    const refusal = fail?.(call);
    return refusal ? Promise.reject(new Error(refusal)) : Promise.resolve(answer);
  };
  let item = 0, checks = 0;
  const api: IntakeApi = {
    createProject: name => say(`project ${name}`, { id: "P" }),
    createBom: (projectId, name) => say(`bom ${projectId} ${name}`, { id: "B" }),
    createItem: dto => say(`item ${dto.partNumber} qty ${dto.quantity} vol ${dto.annualVolume ?? "-"} grade ${dto.materialGrade ?? "-"}`, { id: `I${++item}` }),
    buildSolid: body => say(`solid ${body.name}`, { fileName: `${body.name} (from drawing).step`, stepBase64: btoa("ISO-10303-21;"), volumeMm3: 1, surfaceAreaMm2: 1,
      boundingBox: { length: 1, width: 1, height: 1, diagonal: 1 }, holesPlaced: 0, holesLeftOut: body.name.includes("tight") ? 2 : 0 }),
    uploadFiles: (id, files) => say(`upload ${id} ${[files.file2d?.name, files.file3d?.name].filter(Boolean).join(" + ")}`, null),
    setProcessGroup: (id, group) => say(`group ${id} ${group}`, null),
    analyse: id => say(`analyse ${id}`, { status: { ready: analysis[Math.min(checks++, analysis.length - 1)] ?? true, missing: ["cad_features"] } }),
    applyScenario: (id, request) => say(`apply ${id} ${request.location} ${request.route.mode} ${request.materialGrade} vol ${request.annualVolume ?? "-"} batch ${request.batchSize ?? "-"}`, null),
    importCad: (bomId, f) => say(`import ${bomId} ${f.name}`, null),
  };
  return { api, calls };
}
const run = (p: IntakePlan, s: ReturnType<typeof server>, names = ["a.png", "b.png", "asm.zip"]) => {
  const events: IntakeEvent[] = [];
  return runIntake(p, new Map(names.map(n => [n, file(n)])), s.api, e => events.push(e), () => Promise.resolve()).then(result => ({ result, events }));
};

describe("runIntake", () => {
  it("creates the project and its BOM, then takes a drawing all the way to a cost, in the order the engines need", async () => {
    const s = server();
    const { result, events } = await run(plan(), s);
    expect(s.calls).toEqual([
      "project Bracket job", "bom P From drawings",
      "item PN-a.png qty 2 vol 5000 grade Aluminum, ANSI 6061",
      "solid PN-a.png", "upload I1 a.png + PN-a.png (from drawing).step",
      "group I1 Machining", "analyse I1", "apply I1 India auto Aluminum, ANSI 6061 vol 5000 batch -",
    ]);
    expect(result).toEqual({ projectId: "P", bomId: "B", cadImported: 0, parts: [{ file: "a.png", itemId: "I1", costed: true, detail: "" }] });
    expect(events.at(-1)).toEqual({ key: "part:a.png", title: "a", state: "done", detail: "Costed from a model built from the drawing (approximate)." });
  });

  it("creates a part it cannot cost with its drawing, and does not analyse or cost it", async () => {
    const s = server();
    const { result } = await run(plan({ parts: [part("a.png", { shape: null }), part("b.png", { grade: null })] }), s);
    expect(s.calls.slice(2)).toEqual([
      "item PN-a.png qty 2 vol 5000 grade Aluminum, ANSI 6061", "upload I1 a.png",
      "item PN-b.png qty 2 vol 5000 grade -", "solid PN-b.png", "upload I2 b.png + PN-b.png (from drawing).step",
    ]);
    expect(result.parts.map(p => [p.costed, p.detail])).toEqual([
      [false, "The drawing gives no overall size, so no model can be built: the part is created without a cost."], [false, "Choose the material grade to cost this part."]]);
  });

  it("goes on to the next part when one fails, and says where it stopped", async () => {
    const s = server(call => (call === "solid PN-a.png" ? "The CAD engine did not answer." : null));
    const { result, events } = await run(plan({ parts: [part("a.png"), part("b.png")] }), s);
    expect(result.parts).toEqual([
      { file: "a.png", itemId: "I1", costed: false, detail: "Stopped while building the 3D model: The CAD engine did not answer." },
      { file: "b.png", itemId: "I2", costed: true, detail: "" },
    ]);
    expect(events.filter(e => e.state === "failed")).toHaveLength(1);
  });

  it("stops at once when the project cannot be created: nothing else is attempted", async () => {
    const s = server(call => (call.startsWith("project") ? "You do not have permission." : null));
    await expect(run(plan(), s)).rejects.toThrow("You do not have permission.");
    expect(s.calls).toEqual(["project Bracket job"]);
  });

  it("asks for the analysis again while it is not ready, and gives up after three tries", async () => {
    const ready = server(undefined, [false, true]);
    expect((await run(plan(), ready)).result.parts[0]?.costed).toBe(true);
    expect(ready.calls.filter(c => c.startsWith("analyse"))).toHaveLength(2);
    const never = server(undefined, [false]);
    const { result } = await run(plan(), never);
    expect(never.calls.filter(c => c.startsWith("analyse"))).toHaveLength(3);
    expect(result.parts[0]).toMatchObject({ costed: false, detail: "Stopped while analysing the model: The analysis is not complete (cad_features)." });
    expect(never.calls.some(c => c.startsWith("apply"))).toBe(false);
  });

  it("waits out a server that says it is busy and asks again, and treats any other refusal as a failure at once", async () => {
    let busy = 2;
    const s = server();
    const real = { ...s.api };
    s.api.uploadFiles = (id, files) => (busy-- > 0 ? Promise.reject(Object.assign(new Error("Too many requests"), { status: 429 })) : real.uploadFiles(id, files));
    expect((await run(plan(), s)).result.parts[0]?.costed).toBe(true);
    expect(busy).toBe(-1);                                       // refused twice, taken the third time

    const refused = server();
    refused.api.uploadFiles = () => Promise.reject(Object.assign(new Error("File type not allowed"), { status: 400 }));
    expect((await run(plan(), refused)).result.parts[0]).toMatchObject({ costed: false, detail: "Stopped while attaching the files: File type not allowed" });
  });

  it("says when holes did not fit the model, and sends CAD files to the import after the parts", async () => {
    const s = server();
    const { result } = await run(plan({ batchSize: 500, parts: [part("a.png", { partNumber: "tight" })], cadFiles: ["asm.zip", "missing.step"] }), s);
    expect(result.parts[0]).toMatchObject({ costed: true, detail: "2 holes do not fit the model and are not in the cost." });
    expect(s.calls.at(-2)).toBe("apply I1 India auto Aluminum, ANSI 6061 vol 5000 batch 500");
    expect(s.calls.at(-1)).toBe("import B asm.zip");
    expect(result.cadImported).toBe(1);
  });
});

describe("partPath", () => {
  const made = (parts: PartOutcome[]) => ({ projectId: "p1", bomId: "b1", parts, cadImported: 0 });
  const outcome = (itemId: string | null, costed: boolean): PartOutcome => ({ file: `${itemId ?? "none"}.png`, itemId, costed, detail: "" });

  it("is the Manufacturing Intelligence page of the first costed part, whatever came before it", () => {
    expect(partPath(made([outcome("i1", false), outcome("i2", true), outcome("i3", true)]))).toBe("/projects/p1/bom/b1/items/i2/manufacturing-intelligence");
  });

  it("is the first part that was created when none has a cost", () => {
    expect(partPath(made([outcome(null, false), outcome("i2", false)]))).toBe("/projects/p1/bom/b1/items/i2/manufacturing-intelligence");
  });

  it("is nothing when no part was made here, and the BOM is where to go", () => {
    expect(partPath(made([]))).toBeNull();
    expect(partPath(made([outcome(null, false)]))).toBeNull();
    expect(bomPath(made([]))).toBe("/projects/p1/bom/b1");
  });
});

describe("stepFile", () => {
  it("is the built STEP as an uploadable file under the name that says where it came from", async () => {
    const made = stepFile({ fileName: "TEST-100 (from drawing).step", stepBase64: btoa("ISO-10303-21;") });
    expect(made.name).toBe("TEST-100 (from drawing).step");
    expect(await made.text()).toBe("ISO-10303-21;");
  });
});
