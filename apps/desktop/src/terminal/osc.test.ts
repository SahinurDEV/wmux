import { describe, expect, it } from "vitest";
import { parseOsc7, parseOsc9 } from "./osc";

describe("OSC cwd parsing", () => {
  it("parses Windows Terminal OSC 9;9 with and without quotes", () => {
    expect(parseOsc9('9;"C:\\Users\\dev\\My Project"')).toBe("C:\\Users\\dev\\My Project");
    expect(parseOsc9("9;C:\\src")).toBe("C:\\src");
    expect(parseOsc9('9;"\\\\server\\share\\dir"')).toBe("\\\\server\\share\\dir");
  });

  it("ignores other OSC 9 subcommands and junk", () => {
    expect(parseOsc9("4;1;50")).toBeNull();
    expect(parseOsc9("9;not a path")).toBeNull();
  });

  it("parses OSC 7 file URLs", () => {
    expect(parseOsc7("file://host/C:/Users/dev/a%20b")).toBe("C:\\Users\\dev\\a b");
    expect(parseOsc7("file://host/c/Users/dev")).toBe("C:\\Users\\dev");
  });

  it("rejects Linux paths and non-file URLs", () => {
    expect(parseOsc7("file://wsl/home/dev")).toBeNull();
    expect(parseOsc7("https://example.com/")).toBeNull();
    expect(parseOsc7("::::")).toBeNull();
  });
});
