import { describe, expect, it } from "vitest";
import { agentActivity, agentName, mostUrgent, OUTPUT_QUIET_MS } from "./agents";

const agent = (kind: string, status: string | null = null) => ({ kind, pid: 1, sessionId: null, cwd: null, status });

describe("agentActivity", () => {
  it("trusts the status an agent reports", () => {
    expect(agentActivity(agent("claude", "idle"), undefined, 0)).toBe("idle");
    expect(agentActivity(agent("claude", "busy"), undefined, 0)).toBe("working");
    expect(agentActivity(agent("claude", "waiting_for_permission"), undefined, 0)).toBe("waiting");
    // A reported "idle" wins over terminal noise such as a spinner redraw.
    expect(agentActivity(agent("claude", "idle"), 1000, 1001)).toBe("idle");
    // An unknown status means the agent is doing something.
    expect(agentActivity(agent("claude", "compacting"), undefined, 0)).toBe("working");
  });

  it("falls back to recent terminal output", () => {
    const now = 100_000;
    expect(agentActivity(agent("codex"), now - 500, now)).toBe("working");
    expect(agentActivity(agent("codex"), now - OUTPUT_QUIET_MS - 1, now)).toBe("idle");
    expect(agentActivity(agent("codex"), undefined, now)).toBe("idle");
  });
});

describe("mostUrgent", () => {
  it("puts waiting before working before idle", () => {
    expect(mostUrgent(["idle", "working", "waiting"])).toBe("waiting");
    expect(mostUrgent(["idle", "working"])).toBe("working");
    expect(mostUrgent(["idle"])).toBe("idle");
    expect(mostUrgent([])).toBeNull();
  });
});

describe("agentName", () => {
  it("names known agents and passes unknown kinds through", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("gemini")).toBe("Gemini CLI");
    expect(agentName("something-new")).toBe("something-new");
  });
});
