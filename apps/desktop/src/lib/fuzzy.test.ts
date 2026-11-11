import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzy", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("spr", "Split Pane Right")).not.toBeNull();
    expect(fuzzyScore("xyz", "Split Pane Right")).toBeNull();
  });

  it("ranks word-start and consecutive matches first", () => {
    const items = ["Toggle Sidebar", "Split Down", "Split Right", "Settings"];
    expect(fuzzyFilter(items, "split r", (s) => s)[0]).toBe("Split Right");
    expect(fuzzyFilter(items, "set", (s) => s)[0]).toBe("Settings");
  });

  it("returns everything for an empty query", () => {
    expect(fuzzyFilter(["a", "b"], "  ", (s) => s)).toEqual(["a", "b"]);
  });
});
