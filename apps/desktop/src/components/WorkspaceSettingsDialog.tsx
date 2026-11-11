import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { errorMessage } from "../lib/ipc";
import { pickDirectory } from "../state/actions";
import { ACCENTS } from "../state/settings";
import { useStore } from "../state/store";
import { Button, Modal, cx, inputClass } from "./ui";

/** Parse KEY=VALUE lines. Returns an error message for invalid lines. */
export function parseEnv(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { env, error: `Line ${i + 1}: expected KEY=VALUE` };
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_().-]*$/.test(key)) return { env, error: `Line ${i + 1}: invalid variable name "${key}"` };
    env[key] = line.slice(eq + 1);
  }
  return { env, error: null };
}

export function WorkspaceSettingsDialog({ workspaceId }: { workspaceId: string }) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const profiles = useStore((s) => s.profiles);
  const close = () => useStore.getState().setOverlay(null);
  const [name, setName] = useState(ws?.name ?? "");
  const [color, setColor] = useState(ws?.color ?? ACCENTS[0]!);
  const [cwd, setCwd] = useState(ws?.cwd ?? "");
  const [shell, setShell] = useState(ws?.shellProfileId ?? "");
  const [startup, setStartup] = useState((ws?.startupCommands ?? []).join("\n"));
  const [envText, setEnvText] = useState(
    Object.entries(ws?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  if (!ws) return null;
  const parsed = parseEnv(envText);

  const save = () => {
    if (parsed.error || !name.trim()) return;
    useStore.getState().updateWorkspace(ws.id, {
      name: name.trim().slice(0, 80),
      color,
      cwd: cwd.trim() || null,
      shellProfileId: shell || null,
      startupCommands: startup.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()),
      env: parsed.env,
    });
    close();
  };

  return (
    <Modal
      title="Workspace settings"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={save} disabled={!!parsed.error || !name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Color">
          <div className="flex gap-1.5">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={cx("h-5 w-5 rounded-full", color === c && "ring-2 ring-fg/60 ring-offset-2 ring-offset-elev")}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>
        <Field label="Project directory" hint="New terminals in this workspace start here.">
          <div className="flex gap-2">
            <input className={cx(inputClass, "font-mono text-xs")} value={cwd} placeholder="C:\src\my-project" onChange={(e) => setCwd(e.target.value)} />
            <Button
              onClick={() =>
                void pickDirectory(cwd || null)
                  .then((d) => d && setCwd(d))
                  .catch((e) => useStore.getState().toast("error", errorMessage(e)))
              }
            >
              <FolderOpen size={13} className="inline" />
            </Button>
          </div>
        </Field>
        <Field label="Shell">
          <select className={inputClass} value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="">Use default</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Startup commands" hint="One per line. Typed into the workspace's first terminal when the workspace opens.">
          <textarea
            className={cx(inputClass, "h-20 resize-y py-1.5 font-mono text-xs")}
            value={startup}
            placeholder={"git status\npnpm dev"}
            onChange={(e) => setStartup(e.target.value)}
          />
        </Field>
        <Field label="Environment variables" hint="KEY=VALUE per line, applied to new terminals. Do not store secrets here; values are saved unencrypted.">
          <textarea
            className={cx(inputClass, "h-20 resize-y py-1.5 font-mono text-xs", parsed.error && "border-danger")}
            value={envText}
            placeholder={"NODE_ENV=development"}
            onChange={(e) => setEnvText(e.target.value)}
          />
          {parsed.error && <div className="mt-1 text-xs text-danger">{parsed.error}</div>}
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}
