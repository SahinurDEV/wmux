// Reveals sections as they scroll into view. The hidden starting state only
// applies when <html> has the `js` class, which is set in <head>.
(() => {
  const selector =
    ".hero .wrap > *, .section-head, .card, .split > *, .table-scroll, .callout, .roadmap li, .final .wrap > *, section > .wrap > .fineprint";
  const items = [...document.querySelectorAll(selector)];
  const show = (el) => el.classList.add("in");
  if (!("IntersectionObserver" in window)) {
    items.forEach(show);
    return;
  }
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
  window.addEventListener("load", () => setTimeout(() => items.filter((el) => el.getBoundingClientRect().top < innerHeight).forEach(show), 1200));
})();