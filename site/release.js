// Points the download buttons at the newest release's installer and shows its
// version. Without JavaScript, or if GitHub cannot be reached, every link
// still goes to the releases page, which always has the latest files.
(async () => {
  try {
    const res = await fetch("https://api.github.com/repos/SahinurDEV/wmux/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return;
    const release = await res.json();
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    if (!/^v\d+\.\d+\.\d+/.test(tag)) return;

    for (const el of document.querySelectorAll("[data-version]")) el.textContent = tag;

    // Only ever link to files that GitHub itself serves for this repository.
    const prefix = "https://github.com/SahinurDEV/wmux/releases/download/";
    const assets = (Array.isArray(release.assets) ? release.assets : []).filter(
      (a) => typeof a.browser_download_url === "string" && a.browser_download_url.startsWith(prefix),
    );
    const find = (re) => assets.find((a) => re.test(a.name))?.browser_download_url;
    const files = { setup: find(/-setup\.exe$/i), msi: find(/\.msi$/i), zip: find(/portable.*\.zip$/i) };

    if (files.setup) {
      for (const el of document.querySelectorAll("[data-download]")) el.href = files.setup;
    }
    for (const el of document.querySelectorAll("[data-asset]")) {
      const url = files[el.dataset.asset];
      if (url) el.href = url;
    }
  } catch {
    // Offline or rate-limited: the static links already work.
  }
})();
