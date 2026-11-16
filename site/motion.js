// Page motion: scroll reveals, the reading progress bar, the hero's pointer
// effects and the motion switch. Everything here is decoration; the page
// reads the same without it.
//
// Motion is off ("calm") when the visitor switched it off, or when their
// system asks for reduced motion and they have not chosen. The <head> script
// sets the `calm` class before first paint; this file runs the switch.
(() => {
  const root = document.documentElement;
  const isCalm = () => root.classList.contains("calm");
  const listeners = new Set();
  /** Other scripts on the page ask this whether things may move. */
  window.wmuxMotion = { calm: isCalm, onChange: (fn) => listeners.add(fn) };

  // ------------------------------------------------------------- switch
  const toggle = document.querySelector(".motion-toggle");
  let chosen = null;
  try {
    chosen = localStorage.getItem("wmux-motion");
  } catch {
    // Storage can be blocked; the switch then lasts for this visit only.
  }
  const paintToggle = () => {
    if (!toggle) return;
    toggle.setAttribute("aria-pressed", String(!isCalm()));
    toggle.querySelector("span").textContent = isCalm() ? "Motion off" : "Motion on";
    toggle.title = isCalm() ? "Animations are off. Click to turn them on." : "Animations are on. Click to turn them off.";
    // Off only because of the system setting: point the switch out once.
    toggle.classList.toggle("nudge", isCalm() && !chosen);
  };
  toggle?.addEventListener("click", () => {
    const calm = !isCalm();
    root.classList.toggle("calm", calm);
    chosen = calm ? "off" : "on";
    try {
      localStorage.setItem("wmux-motion", chosen);
    } catch {
      // See above.
    }
    paintToggle();
    listeners.forEach((fn) => fn(calm));
  });
  paintToggle();

  // ------------------------------------------------------------ reveals
  const selector =
    ".hero .wrap > *, .section-head, .card, .split > *, .table-scroll, .callout, .roadmap li, .final .wrap > *, section > .wrap > .fineprint";
  const items = [...document.querySelectorAll(selector)];
  const show = (el) => el.classList.add("in");
  if ("IntersectionObserver" in window) {
    // Siblings arrive one after another rather than all at once.
    for (const el of items) {
      const group = el.matches(".card, .roadmap li") ? 70 : el.closest(".hero") ? 90 : 110;
      const index = [...el.parentElement.children].indexOf(el);
      el.style.setProperty("--d", `${Math.min(index, 8) * group}ms`);
    }
    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target);
          seen.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    items.forEach((el) => seen.observe(el));
    // Never leave content hidden if something prevents the observer from firing.
    window.addEventListener("load", () =>
      setTimeout(() => items.filter((el) => el.getBoundingClientRect().top < innerHeight).forEach(show), 1200),
    );
  } else {
    items.forEach(show);
  }

  // Headline: one word after another. Screen readers get the plain sentence.
  const h1 = document.querySelector(".hero h1");
  if (h1) {
    h1.setAttribute("aria-label", h1.textContent.replace(/\s+/g, " ").trim());
    let i = 0;
    const split = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part.trim()) {
              frag.append(part);
              continue;
            }
            const word = document.createElement("span");
            word.className = "w";
            word.setAttribute("aria-hidden", "true");
            word.style.setProperty("--i", i++);
            word.textContent = part;
            frag.append(word);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          split(child);
        }
      }
    };
    split(h1);
  }

  // ------------------------------------------- progress bar and nav spy
  const bar = document.querySelector(".progress");
  const links = [...document.querySelectorAll('.nav-links a[href^="#"]')];
  const targets = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  let ticking = false;
  const onScroll = () => {
    ticking = false;
    const max = root.scrollHeight - innerHeight;
    bar?.style.setProperty("--p", max > 0 ? Math.min(1, scrollY / max).toFixed(4) : "0");
    let current = null;
    for (const t of targets) if (t.getBoundingClientRect().top < innerHeight * 0.4) current = t;
    for (const a of links) a.classList.toggle("active", !!current && a.getAttribute("href") === `#${current.id}`);
  };
  addEventListener(
    "scroll",
    () => {
      if (!ticking) requestAnimationFrame(onScroll);
      ticking = true;
    },
    { passive: true },
  );
  onScroll();

  // ---------------------------------------------- pointer: cards, hero
  for (const card of document.querySelectorAll(".card")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  }

  const shot = document.querySelector(".hero .shot");
  if (shot) {
    shot.addEventListener("pointermove", (e) => {
      const r = shot.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      shot.style.setProperty("--gx", `${x * 100}%`);
      shot.style.setProperty("--gy", `${y * 100}%`);
      if (isCalm()) return;
      shot.style.setProperty("--ry", `${(x - 0.5) * 5}deg`);
      shot.style.setProperty("--rx", `${(0.5 - y) * 4}deg`);
    });
    shot.addEventListener("pointerleave", () => {
      shot.style.setProperty("--rx", "0deg");
      shot.style.setProperty("--ry", "0deg");
      shot.style.setProperty("--gy", "-30%");
    });
  }

  // ------------------------------------ hero background: a field of dots
  // Dots drift slowly and brighten near the pointer. Paused when the hero is
  // off screen, the tab is hidden, or motion is off.
  const canvas = document.querySelector(".hero-fx");
  const ctx = canvas?.getContext("2d");
  if (canvas && ctx) {
    const hero = canvas.parentElement;
    let w = 0;
    let h = 0;
    let dots = [];
    let pointer = null;
    let visible = true;
    let frame = 0;
    const color = () => getComputedStyle(root).getPropertyValue("--accent").trim() || "#7c8cff";
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = hero.clientWidth;
      h = hero.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(140, Math.round((w * h) / 11000));
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        r: 0.6 + Math.random() * 1.2,
      }));
    };
    const draw = () => {
      frame = 0;
      if (!visible || isCalm() || document.hidden) return;
      ctx.clearRect(0, 0, w, h);
      const c = color();
      for (const d of dots) {
        d.x = (d.x + d.vx + w) % w;
        d.y = (d.y + d.vy + h) % h;
        let near = 0;
        if (pointer) {
          const dist = Math.hypot(d.x - pointer.x, d.y - pointer.y);
          near = Math.max(0, 1 - dist / 190);
          if (near > 0) {
            ctx.globalAlpha = near * 0.35;
            ctx.strokeStyle = c;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(pointer.x, pointer.y);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 0.22 + near * 0.7;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r + near * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    const start = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    hero.addEventListener("pointerleave", () => (pointer = null));
    addEventListener("resize", resize);
    document.addEventListener("visibilitychange", start);
    listeners.add(start);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        start();
      }).observe(hero);
    }
    resize();
    start();
  }

  // The strip under the hero loops by showing its items twice.
  const track = document.querySelector(".marquee-track");
  if (track) {
    for (const item of [...track.children]) {
      const copy = item.cloneNode(true);
      copy.setAttribute("aria-hidden", "true");
      track.append(copy);
    }
  }
})();
