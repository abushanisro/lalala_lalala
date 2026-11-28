import { describe, expect, it } from "vitest";

import { DEFAULT_INTAKE_MODE, INTAKE_BOX, INTAKE_MODES, INTAKE_SEND, intakeModeFrom, intakeModeOf } from "@/lib/intake/modes";

describe("the prompt's modes", () => {
  it("offers Build, Plan and Ask, each with a hint, a send label and a name for the box", () => {
    expect(INTAKE_MODES.map((m) => m.label)).toEqual(["Build", "Plan", "Ask"]);
    for (const m of INTAKE_MODES) {
      expect(m.hint.length).toBeGreaterThan(0);
      expect(INTAKE_SEND[m.key].length).toBeGreaterThan(0);
      expect(INTAKE_BOX[m.key].length).toBeGreaterThan(0);
    }
  });

  it("starts on Plan: nothing is created without a look unless the person chose Build", () => {
    expect(DEFAULT_INTAKE_MODE).toBe("plan");
    for (const saved of [null, undefined, "", "chat", "BUILD"]) expect(intakeModeFrom(saved)).toBe("plan");
  });

  it("reads a remembered mode", () => {
    expect(intakeModeFrom("build")).toBe("build");
    expect(intakeModeFrom("ask")).toBe("ask");
    expect(intakeModeOf("ask").label).toBe("Ask");
    expect(intakeModeOf("build").hint).toMatch(/at once/);
  });
});
