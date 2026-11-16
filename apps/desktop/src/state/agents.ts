// What the UI shows about coding agents running in terminals. Detection
// itself happens in the backend (src-tauri/src/agents.rs).
import type { AgentInfo } from "../lib/ipc";

export type AgentActivity = "working" | "waiting" | "idle";

const NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  aider: "Aider",
};

export function agentName(kind: string): string {
  return NAMES[kind] ?? kind;
}

/** How long after its last output an agent without its own status still counts as working. */
export const OUTPUT_QUIET_MS = 3000;

/**
 * What an agent is doing. Agents that report a status (Claude Code) are taken
 * at their word; for the others, recent terminal output means "working".
 */
export function agentActivity(agent: AgentInfo, lastOutputAt: number | undefined, now: number): AgentActivity {
  const status = agent.status?.toLowerCase();
  if (status) {
    if (status === "idle") return "idle";
    if (/wait|permission|approval|input|blocked/.test(status)) return "waiting";
    return "working";
  }
  return lastOutputAt !== undefined && now - lastOutputAt < OUTPUT_QUIET_MS ? "working" : "idle";
}

const URGENCY: AgentActivity[] = ["waiting", "working", "idle"];

/** The activity that most needs attention among several agents, or null if there are none. */
export function mostUrgent(activities: AgentActivity[]): AgentActivity | null {
  return URGENCY.find((a) => activities.includes(a)) ?? null;
}

export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  working: "working",
  waiting: "waiting for you",
  idle: "idle",
};
