import { describe, expect, it, vi } from "vitest";

// Keep the test free of DOM/xterm/Tauri dependencies.
vi.mock("../terminal/registry", () => ({}));
vi.mock("./actions", () => ({
  closeWorkspace: vi.fn(),
  focusDirection: vi.fn(),
  openFolderAsWorkspace: vi.fn(),
  updateSettings: vi.fn(),
  withFocusedTerminal: vi.fn(),
}));
import { bindableCommands, effectiveBindings, eventToAccelerator } from "./commands";

const ev = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}, key = "") => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("keyboard shortcuts", () => {
  it("normalizes events to accelerators independent of shifted characters", () => {
    expect(eventToAccelerator(ev("KeyP", { ctrlKey: true, shiftKey: true }, "P"))).toBe("Ctrl+Shift+P");
    expect(eventToAccelerator(ev("Digit3", { ctrlKey: true }, "3"))).toBe("Ctrl+3");
    expect(eventToAccelerator(ev("Equal", { ctrlKey: true, shiftKey: true }, "+"))).toBe("Ctrl+Shift+=");
    expect(eventToAccelerator(ev("ArrowLeft", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+ArrowLeft");
    expect(eventToAccelerator(ev("ShiftLeft", { shiftKey: true }, "Shift"))).toBeNull();
  });

  it("has no duplicate default bindings", () => {
    const keys = bindableCommands.map((c) => c.defaultKey).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never binds plain Ctrl+letter (reserved for shells)", () => {
    for (const c of bindableCommands) {
      if (c.defaultKey) expect(c.defaultKey).not.toMatch(/^Ctrl\+[A-Z]$/);
    }
  });

  it("applies user overrides and unbinding", () => {
    const m = effectiveBindings({ "palette.show": "Ctrl+Alt+P", "pane.splitDown": "" });
    expect(m.get("palette.show")).toBe("Ctrl+Alt+P");
    expect(m.has("pane.splitDown")).toBe(false);
    expect(m.get("pane.splitRight")).toBe("Ctrl+Shift+D");
  });
});
