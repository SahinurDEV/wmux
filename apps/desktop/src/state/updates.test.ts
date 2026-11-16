import { describe, expect, it } from "vitest";
import { updateLabel, type UpdateState } from "./updates";

const info = (canInstall: boolean) => ({ version: "1.2.0", currentVersion: "1.1.0", notes: null, canInstall, downloadPage: "https://example.test" });
const state = (patch: Partial<UpdateState>): UpdateState => ({ status: "available", info: info(true), progress: null, ...patch });

describe("updateLabel", () => {
  it("shows nothing when no update is on offer", () => {
    expect(updateLabel(state({ status: "idle", info: null }))).toBeNull();
    expect(updateLabel(state({ status: "checking", info: null }))).toBeNull();
  });

  it("offers to install, or only announces for copies that cannot update themselves", () => {
    expect(updateLabel(state({}))).toBe("Update to v1.2.0");
    expect(updateLabel(state({ info: info(false) }))).toBe("v1.2.0 available");
  });

  it("shows download progress when the size is known", () => {
    expect(updateLabel(state({ status: "downloading" }))).toBe("Downloading update…");
    expect(updateLabel(state({ status: "downloading", progress: 0.426 }))).toBe("Downloading update… 43%");
    expect(updateLabel(state({ status: "installing" }))).toBe("Installing update…");
  });
});
