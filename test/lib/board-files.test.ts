import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BOARD_FILE_EXTENSIONS, BOARD_SET_ACCEPT, describeRejection, isBoardSetFile } from "@/lib/features/board-files";

// The BOM item dialog accepts a circuit board's board set (Gerber layers, drill file and report, Pick Place and BOM tables, or one .zip of
// them). Its board-file extensions are the file-role table's, which the backend generates from memory/Electronics/gerber_file_roles.csv:
// a role the table gains must be accepted here too.
describe("a board set in the BOM item dialog", () => {
  it("accepts every extension of the backend's file-role table", () => {
    const generated = readFileSync(join(__dirname, "../../backend/src/modules/bom-items/costing/pcb/board-graph/lookups/file-roles.generated.ts"), "utf8");
    const roles = [...generated.matchAll(/"extension": "([a-z0-9]+)"/g)].map((m) => m[1]);
    expect([...BOARD_FILE_EXTENSIONS].sort()).toEqual([...roles].sort());
  });

  it("takes the layers, drill data, tables and a .zip of them, and nothing else", () => {
    expect(["board.GTL", "board.gko", "board.TXT", "Pick Place.csv", "bom.xlsx", "set.zip"].every(isBoardSetFile)).toBe(true);
    expect(["part.step", "drawing.pdf", "photo.png", "drawing.dxf"].some(isBoardSetFile)).toBe(false);
    expect(BOARD_SET_ACCEPT).toContain(".gko");
  });
});

describe("a file the BOM item form refuses", () => {
  it("says it is too large, or names what the form takes, board files included", () => {
    expect(describeRejection([{ name: "huge.step", tooLarge: true }], 100)).toEqual({ title: "File too large", description: "huge.step: the limit is 100 MB per file." });
    const other = describeRejection([{ name: "photo.png", tooLarge: false }], 100);
    expect(other.title).toBe("File type not supported");
    expect(other.description).toMatch(/STEP .* DXF or DWG .* Gerber, drill and Pick Place files/);
  });
});
