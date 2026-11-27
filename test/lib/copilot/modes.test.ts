import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { COPILOT_MODES, copilotModeFrom, copilotModeOf, DEFAULT_COPILOT_MODE } from "@/lib/copilot/modes";

describe("copilot modes", () => {
  it("offers Ask, Deep dive and Plan, each with a hint and a placeholder", () => {
    expect(COPILOT_MODES.map((m) => m.label)).toEqual(["Ask", "Deep dive", "Plan"]);
    for (const mode of COPILOT_MODES) {
      expect(mode.hint.length).toBeGreaterThan(0);
      expect(mode.placeholder.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_COPILOT_MODE).toBe("ask");
  });

  it("sends exactly the modes the server accepts", () => {
    const dto = readFileSync(path.resolve(__dirname, "../../../backend/src/modules/copilot/dto/chat.dto.ts"), "utf8");
    const accepted = /COPILOT_MODES = \[([^\]]+)\]/.exec(dto)?.[1]?.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(accepted).toEqual(COPILOT_MODES.map((m) => m.key));
  });

  it("reads a saved mode, and falls back to Ask for anything else", () => {
    expect(copilotModeFrom("plan")).toBe("plan");
    expect(copilotModeFrom("deep_dive")).toBe("deep_dive");
    for (const saved of [null, undefined, "", "build", "PLAN"]) expect(copilotModeFrom(saved)).toBe("ask");
  });

  it("finds a mode's label and hint", () => {
    expect(copilotModeOf("plan").label).toBe("Plan");
    expect(copilotModeOf("ask").hint).toBe("A short answer");
  });
});
