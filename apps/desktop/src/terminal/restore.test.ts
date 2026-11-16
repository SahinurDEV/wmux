import { describe, expect, it } from "vitest";
import { parseShellReport, rerunnableCommand, restoreAction, resumeCommand } from "./restore";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const claude = { kind: "claude", sessionId: "e447e639-4a2b-43b7-9a58-3839af532169", cwd: "C:\\src" };
const on = { resumeAgentSessions: true, rerunCommands: true };

describe("parseShellReport", () => {
  it("reads prompt and command reports", () => {
    expect(parseShellReport("P")).toEqual({ type: "prompt" });
    expect(parseShellReport(`C;${b64("npm run dev")}`)).toEqual({ type: "command", command: "npm run dev" });
    expect(parseShellReport(`C;${b64("echo héllo ✓")}`)).toEqual({ type: "command", command: "echo héllo ✓" });
  });
  it("ignores malformed reports", () => {
    expect(parseShellReport("")).toBeNull();
    expect(parseShellReport("X")).toBeNull();
    expect(parseShellReport("C;not base64!!")).toBeNull();
    expect(parseShellReport(`C;${b64("   ")}`)).toBeNull();
  });
});

describe("resumeCommand", () => {
  it("uses each agent's native resume command", () => {
    expect(resumeCommand(claude)).toBe("claude --resume e447e639-4a2b-43b7-9a58-3839af532169");
    expect(resumeCommand({ ...claude, kind: "codex" })).toBe("codex resume e447e639-4a2b-43b7-9a58-3839af532169");
  });
  it("never builds a command from an unsafe id or unknown agent", () => {
    expect(resumeCommand({ ...claude, sessionId: "abcdefgh; calc.exe" })).toBeNull();
    expect(resumeCommand({ ...claude, sessionId: "$(whoami)-1234" })).toBeNull();
    expect(resumeCommand({ ...claude, kind: "mystery" })).toBeNull();
    expect(resumeCommand(null)).toBeNull();
  });
});

describe("rerunnableCommand", () => {
  it("accepts single-line commands only", () => {
    expect(rerunnableCommand("  npm run dev ")).toBe("npm run dev");
    expect(rerunnableCommand("foreach ($x in 1..3) {\n  $x\n}")).toBeNull();
    expect(rerunnableCommand("a\u001b[2Jb")).toBeNull();
    expect(rerunnableCommand("")).toBeNull();
    expect(rerunnableCommand(null)).toBeNull();
  });
});

describe("restoreAction", () => {
  it("prefers resuming the agent over re-running its launch command", () => {
    expect(restoreAction({ agent: claude, runningCommand: "claude" }, on)).toEqual({
      kind: "agent",
      command: "claude --resume e447e639-4a2b-43b7-9a58-3839af532169",
    });
  });
  it("re-runs an ordinary command", () => {
    expect(restoreAction({ agent: null, runningCommand: "npm run dev" }, on)).toEqual({
      kind: "command",
      command: "npm run dev",
    });
  });
  it("respects the settings", () => {
    const off = { resumeAgentSessions: false, rerunCommands: false };
    expect(restoreAction({ agent: claude, runningCommand: "npm run dev" }, off)).toBeNull();
    expect(restoreAction({ agent: null, runningCommand: "npm run dev" }, { ...on, rerunCommands: false })).toBeNull();
  });
  it("does not start a fresh agent conversation in place of a lost one", () => {
    expect(restoreAction({ agent: null, runningCommand: "claude" }, on)).toBeNull();
    expect(restoreAction({ agent: null, runningCommand: "codex --model x" }, on)).toBeNull();
    expect(restoreAction({ agent: claude, runningCommand: "claude" }, { ...on, resumeAgentSessions: false })).toBeNull();
    expect(restoreAction({ agent: null, runningCommand: "claudette --help" }, on)?.command).toBe("claudette --help");
  });
});
