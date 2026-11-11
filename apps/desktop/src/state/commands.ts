// Command registry: the single source for the command palette and keyboard
// shortcuts. Shortcut defaults deliberately avoid plain Ctrl+<letter> combos
// (Ctrl+D = EOF, Ctrl+W = delete word, Ctrl+R = history search, ...) so they
// never steal input from shells; Ctrl+Shift+<letter> is reserved for the app,
// following the Windows Terminal convention.
import * as terminals from "../terminal/registry";
import {
  closeWorkspace,
  focusDirection,
  openFolderAsWorkspace,
  updateSettings,
  withFocusedTerminal,
} from "./actions";
import { activeWorkspace, useStore } from "./store";

export interface Command {
  id: string;
  title: string;
  category: string;
  defaultKey?: string;
  /** Hidden from the palette (e.g. Ctrl+1..9). */
  hidden?: boolean;
  run: () => void | Promise<void>;
}

const st = () => useStore.getState();

const staticCommands: Command[] = [
  { id: "palette.show", title: "Show Command Palette", category: "View", defaultKey: "Ctrl+Shift+P", run: () => st().setOverlay({ kind: "palette" }) },
  { id: "workspace.new", title: "New Workspace", category: "Workspace", defaultKey: "Ctrl+Shift+N", run: () => void st().createWorkspace() },
  { id: "workspace.openFolder", title: "Open Folder as Workspace…", category: "Workspace", defaultKey: "Ctrl+Shift+O", run: openFolderAsWorkspace },
  { id: "workspace.close", title: "Close Workspace", category: "Workspace", defaultKey: "Ctrl+Shift+W", run: () => closeWorkspace() },
  { id: "workspace.rename", title: "Rename Workspace", category: "Workspace", run: () => st().setRenaming(st().activeWorkspaceId) },
  { id: "workspace.duplicate", title: "Duplicate Workspace", category: "Workspace", run: () => { const id = st().activeWorkspaceId; if (id) st().duplicateWorkspace(id); } },
  { id: "workspace.togglePin", title: "Pin / Unpin Workspace", category: "Workspace", run: () => { const id = st().activeWorkspaceId; if (id) st().togglePin(id); } },
  { id: "workspace.settings", title: "Workspace Settings…", category: "Workspace", run: () => { const id = st().activeWorkspaceId; if (id) st().setOverlay({ kind: "workspace", workspaceId: id }); } },
  { id: "workspace.next", title: "Next Workspace", category: "Workspace", defaultKey: "Ctrl+Tab", run: () => st().cycleWorkspace(1) },
  { id: "workspace.prev", title: "Previous Workspace", category: "Workspace", defaultKey: "Ctrl+Shift+Tab", run: () => st().cycleWorkspace(-1) },

  { id: "terminal.new", title: "New Terminal Tab", category: "Terminal", defaultKey: "Ctrl+Shift+T", run: () => st().newTerminalTab() },
  { id: "terminal.close", title: "Close Terminal Tab", category: "Terminal", defaultKey: "Ctrl+Shift+Q", run: () => withFocusedTerminal((id) => st().closeSurface(id)) },
  { id: "terminal.restart", title: "Restart Terminal", category: "Terminal", defaultKey: "Ctrl+Shift+R", run: () => withFocusedTerminal((id) => void terminals.restart(id)) },
  { id: "terminal.kill", title: "Kill Terminal Process Tree", category: "Terminal", run: () => withFocusedTerminal((id) => void terminals.kill(id)) },
  { id: "terminal.clear", title: "Clear Terminal", category: "Terminal", defaultKey: "Ctrl+Shift+K", run: () => withFocusedTerminal(terminals.clear) },
  { id: "terminal.search", title: "Search Terminal Output", category: "Terminal", defaultKey: "Ctrl+Shift+F", run: () => withFocusedTerminal((id) => st().setSearchSurface(id)) },
  { id: "terminal.selectAll", title: "Select All Terminal Output", category: "Terminal", defaultKey: "Ctrl+Shift+A", run: () => withFocusedTerminal(terminals.selectAll) },
  { id: "terminal.nextTab", title: "Next Terminal Tab", category: "Terminal", defaultKey: "Ctrl+PageDown", run: () => st().cycleTab(1) },
  { id: "terminal.prevTab", title: "Previous Terminal Tab", category: "Terminal", defaultKey: "Ctrl+PageUp", run: () => st().cycleTab(-1) },

  { id: "pane.splitRight", title: "Split Pane Right", category: "Pane", defaultKey: "Ctrl+Shift+D", run: () => st().splitFocused("horizontal") },
  { id: "pane.splitDown", title: "Split Pane Down", category: "Pane", defaultKey: "Ctrl+Shift+E", run: () => st().splitFocused("vertical") },
  { id: "pane.close", title: "Close Pane", category: "Pane", run: () => { const ws = activeWorkspace(st()); if (ws?.focusedPaneId) st().closePane(ws.focusedPaneId); } },
  { id: "pane.zoom", title: "Maximize / Restore Pane", category: "Pane", defaultKey: "Ctrl+Shift+Enter", run: () => st().toggleZoom() },
  { id: "pane.focusLeft", title: "Focus Pane Left", category: "Pane", defaultKey: "Ctrl+Alt+ArrowLeft", run: () => focusDirection("left") },
  { id: "pane.focusRight", title: "Focus Pane Right", category: "Pane", defaultKey: "Ctrl+Alt+ArrowRight", run: () => focusDirection("right") },
  { id: "pane.focusUp", title: "Focus Pane Up", category: "Pane", defaultKey: "Ctrl+Alt+ArrowUp", run: () => focusDirection("up") },
  { id: "pane.focusDown", title: "Focus Pane Down", category: "Pane", defaultKey: "Ctrl+Alt+ArrowDown", run: () => focusDirection("down") },

  { id: "view.toggleSidebar", title: "Toggle Sidebar", category: "View", defaultKey: "Ctrl+Shift+B", run: () => st().setUi({ sidebarCollapsed: !st().ui.sidebarCollapsed }) },
  { id: "view.fontBigger", title: "Increase Font Size", category: "View", defaultKey: "Ctrl+=", run: () => updateSettings({ fontSize: Math.min(32, st().settings.fontSize + 1) }) },
  { id: "view.fontSmaller", title: "Decrease Font Size", category: "View", defaultKey: "Ctrl+-", run: () => updateSettings({ fontSize: Math.max(8, st().settings.fontSize - 1) }) },
  { id: "view.fontReset", title: "Reset Font Size", category: "View", defaultKey: "Ctrl+0", run: () => updateSettings({ fontSize: 13 }) },
  { id: "view.themeToggle", title: "Toggle Light / Dark Theme", category: "View", run: () => updateSettings({ theme: st().settings.theme === "light" ? "dark" : "light" }) },
  { id: "settings.open", title: "Open Settings", category: "Preferences", defaultKey: "Ctrl+,", run: () => st().setOverlay({ kind: "settings" }) },
  { id: "settings.keyboard", title: "Keyboard Shortcuts", category: "Preferences", run: () => st().setOverlay({ kind: "settings", tab: "keyboard" }) },

  ...Array.from({ length: 9 }, (_, i): Command => ({
    id: `workspace.go${i + 1}`,
    title: `Switch to Workspace ${i + 1}`,
    category: "Workspace",
    defaultKey: `Ctrl+${i + 1}`,
    hidden: true,
    run: () => st().activateWorkspaceIndex(i),
  })),
];

/** All commands, including dynamic ones (per workspace, per shell profile). */
export function getCommands(): Command[] {
  const s = st();
  const dynamic: Command[] = [
    ...s.workspaces.map(
      (w): Command => ({
        id: `workspace.switch:${w.id}`,
        title: `Switch to Workspace: ${w.name}`,
        category: "Workspace",
        run: () => s.setActiveWorkspace(w.id),
      }),
    ),
    ...s.profiles.map(
      (p): Command => ({
        id: `terminal.newWith:${p.id}`,
        title: `New Terminal: ${p.name}`,
        category: "Terminal",
        run: () => {
          s.newTerminalTab();
          const id = focusedTerminalAfterCreate();
          if (id) s.setSurfaceProfile(id, p.id);
        },
      }),
    ),
  ];
  return [...staticCommands, ...dynamic];
}

function focusedTerminalAfterCreate(): string | undefined {
  const ws = activeWorkspace(st());
  const pane = ws?.panes.find((p) => p.id === ws.focusedPaneId);
  return pane?.activeSurfaceId ?? undefined;
}

export function commandById(id: string): Command | undefined {
  return staticCommands.find((c) => c.id === id);
}

export const bindableCommands = staticCommands;

/** commandId -> accelerator, merging user overrides over defaults. */
export function effectiveBindings(overrides: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of staticCommands) {
    const key = c.id in overrides ? overrides[c.id] : c.defaultKey;
    if (key) map.set(c.id, key);
  }
  return map;
}

const CODE_NAMES: Record<string, string> = {
  Equal: "=", Minus: "-", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";",
  Quote: "'", BracketLeft: "[", BracketRight: "]", Backquote: "`", Space: "Space",
  NumpadAdd: "=", NumpadSubtract: "-",
};

/** Normalized accelerator for a keyboard event, or null for bare modifiers. */
export function eventToAccelerator(e: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const { code } = e;
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = code.slice(6);
  else if (code in CODE_NAMES) key = CODE_NAMES[code]!;
  else if (code === "NumpadEnter") key = "Enter";
  else key = code || e.key;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Win");
  parts.push(key);
  return parts.join("+");
}

/** Display form, e.g. "Ctrl+Shift+P" -> ["Ctrl", "Shift", "P"]. */
export function acceleratorParts(acc: string): string[] {
  return acc.split("+").map((p) => p.replace(/^Arrow/, "") || "+");
}
