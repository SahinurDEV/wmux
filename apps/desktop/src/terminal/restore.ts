// Pure helpers for bringing a terminal back after a restart: what the shell
// integration reports, and which command (if any) to type into the new shell.
import type { AgentRecord } from "../lib/ipc";

/** Private OSC used by Wmux shell integration (see shells.rs). */
export const WMUX_OSC = 7717;

export type ShellReport = { type: "prompt" } | { type: "command"; command: string };

/** Parse the payload of `OSC 7717`: `P` (prompt shown) or `C;<base64 utf-8>`. */
export function parseShellReport(data: string): ShellReport | null {
  if (data === "P") return { type: "prompt" };
  if (!data.startsWith("C;")) return null;
  try {
    const bytes = Uint8Array.from(atob(data.slice(2)), (c) => c.charCodeAt(0));
    const command = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return command.trim() ? { type: "command", command } : null;
  } catch {
    return null;
  }
}

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** The agent's native resume command, or null if it cannot be resumed safely. */
export function resumeCommand(agent: AgentRecord | null | undefined): string | null {
  // The id is typed into a shell: accept nothing but plain id characters.
  if (!agent || !SESSION_ID.test(agent.sessionId)) return null;
  if (agent.kind === "claude") return `claude --resume ${agent.sessionId}`;
  if (agent.kind === "codex") return `codex resume ${agent.sessionId}`;
  return null;
}

/**
 * A remembered command line that can be typed back as-is. Multi-line input
 * is skipped: sending it line by line would run something different.
 */
export function rerunnableCommand(command: string | null | undefined): string | null {
  const cmd = command?.trim();
  if (!cmd || cmd.length > 4000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(cmd)) return null;
  return cmd;
}

/** What to type into a restored terminal, honoring the user's settings. */
export function restoreAction(
  saved: { agent: AgentRecord | null; runningCommand: string | null },
  settings: { resumeAgentSessions: boolean; rerunCommands: boolean },
): { kind: "agent" | "command"; command: string } | null {
  const resume = settings.resumeAgentSessions ? resumeCommand(saved.agent) : null;
  if (resume) return { kind: "agent", command: resume };
  const cmd = rerunnableCommand(saved.runningCommand);
  if (!cmd) return null;
  // Starting an agent is the "command" that was running; without its session
  // id (or with resume turned off) re-running it would open an unrelated
  // conversation, so leave the terminal at the prompt instead.
  if (/^(claude|codex)(\.\w+)?(\s|$)/i.test(cmd)) return null;
  return settings.rerunCommands ? { kind: "command", command: cmd } : null;
}
