import { describe, expect, it } from "vitest";

import { deletionOrder, namesInWords, selectionState, toggleAll, toggleOne } from "@/lib/bom/selection";

describe("the select-all box", () => {
  it("reads none, some or all of the rows shown", () => {
    expect(selectionState(["a", "b"], new Set())).toBe("none");
    expect(selectionState(["a", "b"], new Set(["b"]))).toBe("some");
    expect(selectionState(["a", "b"], new Set(["a", "b", "hidden"]))).toBe("all");
    expect(selectionState([], new Set(["hidden"]))).toBe("none");
  });

  it("selects every row shown, or clears them when they all are selected, and leaves rows not shown alone", () => {
    expect([...toggleAll(["a", "b"], new Set(["b", "hidden"]))].sort()).toEqual(["a", "b", "hidden"]);
    expect([...toggleAll(["a", "b"], new Set(["a", "b", "hidden"]))]).toEqual(["hidden"]);
  });

  it("turns one row on and off without touching the set it was given", () => {
    const before = new Set(["a"]);
    expect([...toggleOne("b", before)]).toEqual(["a", "b"]);
    expect([...toggleOne("a", before)]).toEqual([]);
    expect([...before]).toEqual(["a"]);
  });
});

describe("deletionOrder", () => {
  const items = [
    { id: "asm", parentItemId: null }, { id: "sub", parentItemId: "asm" }, { id: "part1", parentItemId: "sub" }, { id: "part2", parentItemId: " sub " },
    { id: "other", parentItemId: "" },
  ];

  it("puts children before their parents, and keeps the list's order among equals", () => {
    expect(deletionOrder(items, new Set(["asm", "part2", "sub", "part1", "other"])).map(i => i.id)).toEqual(["part1", "part2", "sub", "asm", "other"]);
  });

  it("leaves out what is not selected and what is no longer in the list", () => {
    expect(deletionOrder(items, new Set(["sub", "gone"])).map(i => i.id)).toEqual(["sub"]);
  });

  it("does not loop on items that name each other as parent", () => {
    const loop = [{ id: "x", parentItemId: "y" }, { id: "y", parentItemId: "x" }];
    expect(deletionOrder(loop, new Set(["x", "y"])).map(i => i.id)).toEqual(["x", "y"]);
  });
});

describe("namesInWords", () => {
  it("writes a few names in full and counts the rest", () => {
    expect(namesInWords(["Bracket"])).toBe("Bracket");
    expect(namesInWords(["Bracket", "Shaft"])).toBe("Bracket and Shaft");
    expect(namesInWords(["Bracket", "Shaft", "Housing"])).toBe("Bracket, Shaft and Housing");
    expect(namesInWords(["Bracket", "Shaft", "Housing", "Cap", "Pin"])).toBe("Bracket, Shaft and 3 more");
    expect(namesInWords([])).toBe("");
  });
});
