// Prototype for BUG.md option 2: move each rendered page out of the single
// document <svg> into its own <svg>, wrapped in a div with
// `content-visibility: auto`. The original <svg> stays in #typst-app but is
// hidden, so typst-dom keeps working on it without painting it.
(() => {
  if (window.__SPLIT_MODE === "underlay") return underlay();
  const app = document.getElementById("typst-app");
  const doc = app.querySelector("svg.typst-doc");
  const [, , vbWidth] = doc.getAttribute("viewBox").split(" ").map(Number);
  const scale = Number(doc.getAttribute("width")) / vbWidth;
  const ns = "http://www.w3.org/2000/svg";
  const resources = new XMLSerializer().serializeToString(
    document.getElementById("typst-svg-resources"),
  );

  const host = document.createElement("div");
  host.id = "split-pages";
  host.style.background = getComputedStyle(app).backgroundColor;
  let count = 0;
  const pending = [];
  const t0 = performance.now();
  for (const page of Array.from(doc.querySelectorAll(":scope > g.typst-page"))) {
    const width = Number(page.getAttribute("data-page-width"));
    const height = Number(page.getAttribute("data-page-height"));
    const x = Number(page.getAttribute("data-x"));

    const wrap = document.createElement("div");
    wrap.style.cssText =
      `content-visibility: auto; contain-intrinsic-size: auto ${width * scale}px auto ${height * scale}px;` +
      `width: ${width * scale}px; height: ${height * scale}px; margin: 0 0 ${5 * scale}px ${x * scale}px; background: #fff`;

    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "typst-doc");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", `${width * scale}`);
    svg.setAttribute("height", `${height * scale}`);

    // Pages are clipped to their own box by the <svg> viewport, so the
    // per-page clip-path and translate are dropped.
    const clone = page.cloneNode(true);
    clone.removeAttribute("transform");
    clone.removeAttribute("clip-path");

    if (window.__SPLIT_MODE === "img") {
      // Draw the glyphs from an <img>, which Chrome rasterises once into a
      // cached bitmap, and keep only the transparent .tsel text overlay live
      // for selection. The <img> gets its own copy of the glyph definitions,
      // since it cannot see the document's #typst-svg-resources.
      const glyphs = clone.cloneNode(true);
      for (const fo of Array.from(glyphs.querySelectorAll("foreignObject"))) fo.remove();
      const source =
        `<svg xmlns="${ns}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}">` +
        `${resources}${new XMLSerializer().serializeToString(glyphs)}</svg>`;
      const img = document.createElement("img");
      img.src = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
      img.style.cssText = `position: absolute; width: ${width * scale}px; height: ${height * scale}px`;
      let bitmap = img;
      if (window.__SPLIT_BITMAP) {
        // Rasterise once on the CPU into a software-backed canvas, so
        // scrolling only composites an uploaded bitmap.
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(width * scale * devicePixelRatio);
        canvas.height = Math.ceil(height * scale * devicePixelRatio);
        canvas.style.cssText = img.style.cssText;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        pending.push(img.decode().then(() => ctx.drawImage(img, 0, 0, canvas.width, canvas.height)));
        bitmap = canvas;
      }
      for (const use of Array.from(clone.querySelectorAll("use, path, image"))) {
        if (!use.closest("foreignObject")) use.remove();
      }
      wrap.style.position = "relative";
      svg.style.position = "absolute";
      wrap.append(bitmap);
    }
    svg.append(clone);
    wrap.append(svg);
    host.append(wrap);
    count++;
  }
  doc.style.display = "none";
  app.after(host);
  return Promise.all(pending).then(() => ({ pages: count, scale, bitmaps: pending.length, rasterMs: Math.round(performance.now() - t0), canvasMB: Math.round([...host.querySelectorAll("canvas")].reduce((a, c) => a + c.width * c.height * 4, 0) / 1e6) }));
})();

// Keep the document <svg> live and untouched, so every feature that reads its
// structure or geometry still works. CSS stops it painting glyphs, shapes and
// images, and a layer of per-page CPU bitmaps underneath draws them instead.
function underlay() {
  const app = document.getElementById("typst-app");
  const doc = app.querySelector("svg.typst-doc");
  const [, , vbWidth] = doc.getAttribute("viewBox").split(" ").map(Number);
  const scale = Number(doc.getAttribute("width")) / vbWidth;
  const ns = "http://www.w3.org/2000/svg";
  const resources = new XMLSerializer().serializeToString(
    document.getElementById("typst-svg-resources"),
  );

  const style = document.createElement("style");
  style.textContent =
    ".typst-page use:not(foreignObject *), .typst-page path:not(foreignObject *)," +
    " .typst-page image:not(foreignObject *) { visibility: hidden }" +
    " .typst-page-inner { fill: none }";
  document.head.append(style);

  const layer = document.createElement("div");
  // typst-dom treats #typst-app's first child as the document <svg> and
  // replaces it on rerender, so the layer sits beside #typst-app instead.
  layer.style.cssText =
    `position: absolute; left: ${app.offsetLeft}px; top: ${app.offsetTop}px; pointer-events: none`;
  doc.style.position = "relative";
  // #typst-app paints the preview background, which would cover the layer.
  const main = document.getElementById("typst-container-main");
  main.style.backgroundColor = getComputedStyle(app).backgroundColor;
  app.style.setProperty("background-color", "transparent", "important");

  const t0 = performance.now();
  const pending = [];
  for (const page of Array.from(doc.querySelectorAll(":scope > g.typst-page"))) {
    const width = Number(page.getAttribute("data-page-width"));
    const height = Number(page.getAttribute("data-page-height"));
    const x = Number(page.getAttribute("data-x"));
    const y = Number(page.getAttribute("data-y"));

    const glyphs = page.cloneNode(true);
    glyphs.removeAttribute("transform");
    glyphs.removeAttribute("clip-path");
    for (const fo of Array.from(glyphs.querySelectorAll("foreignObject"))) fo.remove();
    const source =
      `<svg xmlns="${ns}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}">` +
      `${resources}${new XMLSerializer().serializeToString(glyphs)}</svg>`;
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale * devicePixelRatio);
    canvas.height = Math.ceil(height * scale * devicePixelRatio);
    canvas.style.cssText =
      `position: absolute; left: ${x * scale}px; top: ${y * scale}px;` +
      `width: ${width * scale}px; height: ${height * scale}px; background: #fff`;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    pending.push(img.decode().then(() => ctx.drawImage(img, 0, 0, canvas.width, canvas.height)));
    layer.append(canvas);
  }
  app.before(layer);
  return Promise.all(pending).then(() => ({
    pages: pending.length,
    scale,
    rasterMs: Math.round(performance.now() - t0),
  }));
}
