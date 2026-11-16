// The three things on the page a visitor can play with: the session-restore
// simulator, the working command palette and the theme comparison. They are
// illustrations made of HTML, not real terminals. With motion off they still
// work, but text appears at once instead of being typed out.
(() => {
  const calm = () => window.wmuxMotion?.calm() ?? false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, calm() ? 0 : ms));
  const whenSeen = (el, fn) => {
    if (!("IntersectionObserver" in window)) return fn();
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        fn();
      },
      { threshold: 0.35 },
    );
    io.observe(el);
  };

  // ------------------------------------------------- session restore demo
  const demo = document.querySelector("[data-restore-demo]");
  if (demo) {
    const panes = { server: demo.querySelector('[data-pane="server"]'), agent: demo.querySelector('[data-pane="agent"]') };
    const state = demo.querySelector(".demo-state");
    const off = demo.querySelector(".demo-off");
    const [shutdownBtn, reopenBtn] = demo.querySelectorAll(".demo-controls button");
    const busy = demo.querySelector(".demo-tab i");
    const MAX_LINES = 11;
    // A newer run cancels an older one that is still typing.
    let run = 0;
    let ticker = 0;

    const line = (pane, text, cls) => {
      const el = document.createElement("span");
      if (cls) el.className = cls;
      el.textContent = text;
      panes[pane].append(el);
      while (panes[pane].children.length > MAX_LINES) panes[pane].firstChild.remove();
      return el;
    };
    /** Type `text` after a prompt, one character at a time. */
    const type = async (pane, prompt, text, id) => {
      const el = line(pane, prompt, "prompt");
      for (const ch of text) {
        if (id !== run) return;
        el.textContent += ch;
        await sleep(28 + Math.random() * 40);
      }
    };
    const clock = () => new Date().toLocaleTimeString([], { hour12: false });
    const FILES = ["src/App.tsx", "src/cart.ts", "src/checkout.tsx", "src/styles.css", "src/orders.ts"];
    const tick = () => {
      clearInterval(ticker);
      ticker = setInterval(() => {
        if (document.hidden) return;
        line("server", `${clock()} hmr ${FILES[Math.floor(Math.random() * FILES.length)]}`);
      }, 1700);
    };
    const setState = (name, label) => {
      demo.dataset.state = name;
      state.textContent = label;
      busy.classList.toggle("busy", name === "on");
    };

    const server = async (id, rerun) => {
      if (rerun) line("server", "↻ Re-running: pnpm dev", "note");
      else await type("server", "PS C:\\dev\\shop> ", "pnpm dev", id);
      await sleep(450);
      if (id !== run) return;
      line("server", "  VITE v8.3.8 ready in 412 ms", "ok");
      line("server", "  ➜ http://localhost:5173/");
      tick();
    };
    const agent = async (id, resume) => {
      if (resume) {
        line("agent", "Resuming agent session:", "note");
        line("agent", "  claude --resume 3f9a2c1e", "note");
        await sleep(700);
        if (id !== run) return;
        line("agent", "● Session resumed", "ok");
        line("agent", "> ▍", "prompt");
        return;
      }
      await type("agent", "PS C:\\dev\\shop> ", "claude", id);
      for (const [text, wait] of [
        ["● Reading src/cart.ts", 600],
        ["● Editing src/cart.ts (+18 −4)", 900],
        ["● Running tests: 42 passed", 1100],
        ["Done. Anything else?", 500],
      ]) {
        await sleep(wait);
        if (id !== run) return;
        line("agent", text, text.startsWith("●") ? "" : "ok");
      }
      line("agent", "> ▍", "prompt");
    };

    const boot = () => {
      const id = ++run;
      for (const p of Object.values(panes)) p.replaceChildren();
      setState("on", "Running");
      shutdownBtn.disabled = false;
      reopenBtn.disabled = true;
      void server(id, false);
      void agent(id, false);
    };
    shutdownBtn.addEventListener("click", () => {
      run++;
      clearInterval(ticker);
      setState("off", "PC is off");
      off.innerHTML = "<b>The PC is off.</b>Every process is gone. Nothing is running.";
      shutdownBtn.disabled = true;
      reopenBtn.disabled = false;
      reopenBtn.focus({ preventScroll: true });
    });
    reopenBtn.addEventListener("click", async () => {
      const id = ++run;
      reopenBtn.disabled = true;
      setState("starting", "Starting…");
      off.innerHTML = "<b>Starting Wmux…</b>Reading the saved session.";
      // What was on screen before comes back dimmed, above a marker.
      for (const p of Object.values(panes)) for (const el of p.children) el.className = "old";
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      await sleep(1100);
      if (id !== run) return;
      setState("on", "Restored");
      for (const name of Object.keys(panes)) line(name, `── session restored · ${stamp} ──`, "mark");
      await sleep(500);
      if (id !== run) return;
      void server(id, true);
      await agent(id, true);
      if (id === run) shutdownBtn.disabled = false;
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && demo.dataset.state === "on") tick();
    });
    whenSeen(demo, boot);
  }

  // ------------------------------------------------------ command palette
  const palette = document.querySelector("[data-palette]");
  if (palette) {
    // Titles, categories and default shortcuts as they are in the app.
    const COMMANDS = [
      ["Pane", "Split Pane Right", "Ctrl Shift D"],
      ["Pane", "Split Pane Down", "Ctrl Shift E"],
      ["Pane", "Maximize / Restore Pane", "Ctrl Shift Enter"],
      ["Pane", "Swap Pane Left", "Ctrl Alt Shift ←"],
      ["Pane", "Close Pane", ""],
      ["Workspace", "New Workspace", "Ctrl Shift N"],
      ["Workspace", "Open Folder as Workspace…", "Ctrl Shift O"],
      ["Workspace", "Duplicate Workspace", ""],
      ["Workspace", "Next Workspace", "Ctrl Tab"],
      ["Terminal", "New Terminal Tab", "Ctrl Shift T"],
      ["Terminal", "Restart Terminal", "Ctrl Shift R"],
      ["Terminal", "Search Terminal Output", "Ctrl Shift F"],
      ["Terminal", "Clear Terminal", "Ctrl Shift K"],
      ["View", "Toggle Sidebar", "Ctrl Shift B"],
      ["View", "Toggle Light / Dark Theme", ""],
      ["View", "Increase Font Size", "Ctrl ="],
      ["Preferences", "Open Settings", "Ctrl ,"],
      ["Preferences", "Keyboard Shortcuts", ""],
      ["Preferences", "Check for Updates", ""],
    ];
    const input = palette.querySelector("input");
    const list = palette.querySelector("ul");
    const out = palette.querySelector("output");
    let selected = 0;
    let shown = [];
    let touched = false;

    /** Positions of the query's letters in `title`, in order, or null. */
    const match = (title, query) => {
      const hay = title.toLowerCase();
      const at = hay.indexOf(query);
      if (at >= 0) return Array.from(query, (_, i) => at + i);
      const hits = [];
      let from = 0;
      for (const ch of query) {
        if (ch === " ") continue;
        const i = hay.indexOf(ch, from);
        if (i < 0) return null;
        hits.push(i);
        from = i + 1;
      }
      return hits;
    };
    const render = () => {
      const query = input.value.trim().toLowerCase();
      shown = COMMANDS.map((c) => ({ c, hits: query ? match(c[1], query) : [] })).filter((x) => x.hits);
      selected = Math.min(selected, Math.max(0, shown.length - 1));
      list.replaceChildren();
      if (!shown.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "No matching command";
        list.append(li);
        return;
      }
      shown.forEach(({ c, hits }, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(i === selected));
        const cat = document.createElement("small");
        cat.textContent = c[0];
        const title = document.createElement("span");
        [...c[1]].forEach((ch, at) => {
          if (hits.includes(at)) {
            const m = document.createElement("mark");
            m.textContent = ch;
            title.append(m);
          } else title.append(ch);
        });
        const keys = document.createElement("span");
        keys.className = "keysq";
        for (const k of c[2] ? c[2].split(" ") : []) {
          const kbd = document.createElement("kbd");
          kbd.textContent = k;
          keys.append(kbd, " ");
        }
        li.append(cat, title, keys);
        li.addEventListener("pointermove", () => {
          if (selected === i) return;
          selected = i;
          for (const [j, el] of [...list.children].entries()) el.setAttribute("aria-selected", String(j === i));
        });
        li.addEventListener("click", () => runCommand(i));
        list.append(li);
      });
      const current = list.children[selected];
      if (current) {
        // Scroll the list itself; scrollIntoView would move the whole page.
        const box = list.getBoundingClientRect();
        const row = current.getBoundingClientRect();
        if (row.top < box.top) list.scrollTop -= box.top - row.top + 6;
        else if (row.bottom > box.bottom) list.scrollTop += row.bottom - box.bottom + 6;
      }
    };
    const runCommand = (i) => {
      const item = shown[i];
      if (!item) return;
      const li = list.children[i];
      li.classList.add("ran");
      setTimeout(() => li.classList.remove("ran"), 260);
      out.textContent = `Runs “${item.c[1]}”`;
    };
    input.addEventListener("input", () => {
      selected = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      touched = true;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
        render();
      } else if (e.key === "Enter") {
        runCommand(selected);
      } else if (e.key === "Escape") {
        input.value = "";
        selected = 0;
        render();
      }
    });
    input.addEventListener("pointerdown", () => (touched = true));
    render();
    // Show what it does by typing a query once, unless the visitor got there first.
    whenSeen(palette, async () => {
      if (calm()) return;
      await sleep(600);
      for (const ch of "split") {
        if (touched) return;
        input.value += ch;
        selected = 0;
        render();
        await sleep(170);
      }
    });
  }

  // -------------------------------------------------- theme and accent
  const compare = document.querySelector(".compare");
  if (compare) {
    const range = compare.querySelector("input");
    const set = () => compare.style.setProperty("--pos", `${range.value}%`);
    range.addEventListener("input", set);
    set();
    // A short sweep shows that the divider can be dragged.
    whenSeen(compare, async () => {
      if (calm()) return;
      let moved = false;
      range.addEventListener("pointerdown", () => (moved = true), { once: true });
      range.addEventListener("keydown", () => (moved = true), { once: true });
      const start = performance.now();
      const step = (now) => {
        const t = (now - start) / 1800;
        if (moved || t >= 1) return;
        range.value = String(50 + Math.sin(t * Math.PI * 2) * 22);
        set();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  const swatches = [...document.querySelectorAll(".swatches button")];
  for (const button of swatches) {
    button.addEventListener("click", () => {
      document.documentElement.style.setProperty("--accent", button.style.getPropertyValue("--c"));
      for (const b of swatches) b.setAttribute("aria-pressed", String(b === button));
    });
  }
})();
