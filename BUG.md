# Bug: preview scroll stutter on Intel GPU with Mesa

This file hands off an open investigation into scroll stutter in the Typst preview. The candidate causes come from reading code on macOS. The figures in "Measurements on macOS (Apple M1)" come from scripted runs on an M1 machine. Nothing has been measured on the affected Ubuntu machine yet. Each cause listed is a hypothesis until the tests in "Next steps" confirm or reject it.

## Symptom

The Typst preview *webview* in the tinymist VS Code extension stutters when scrolling. It was first observed on Ubuntu with an Intel graphics processing unit (GPU) running the Mesa driver. Nothing yet shows that it is specific to that platform. The stutter disappears when VS Code renders on the central processing unit (CPU). It appears during continuous scrolling with no pauses, and also around pauses. Turning off `tinymist.preview.partialRendering` (default `true`) made no difference.

## Architecture

The preview has two layers of frontend code.

- `tools/typst-preview-frontend/src/` is the preview frontend. `ws.ts` sets up the document and event wiring, `typst.ts` adds hover and link handlers, and `typst.css` holds the styles.
- `tools/typst-dom/src/` is the Document Object Model (DOM) renderer library. `typst-doc.mts` owns the render queue and wheel/zoom handling. `typst-doc.svg.mts` implements Scalable Vector Graphics (SVG) mode, `typst-doc.canvas.mts` implements canvas mode, and `typst-patch.svg.mts` does SVG diff patching.

The document renders as one large `<svg>` inside `#typst-app`. Every glyph is an *outline path* (`<path>`) referenced through `<use>`, never as text. Each page carries a `clip-path`, and each glyph has the Cascading Style Sheets (CSS) rule `transform: matrix(1,0,0,1,var(--o),0)` from `typst.css`.

With *partial rendering* on, off-screen pages become `<canvas>` elements inside `<foreignObject>` at `pixelPerPt = 3` (`typst-doc.mts:91`). An A4 page comes out at roughly 1785×2526 px. The user's test with partial rendering off rules these canvases out as the main cause.

## Candidate causes during continuous scrolling

No tinymist JavaScript runs during a continuous scroll. The scroll listener at `tools/typst-preview-frontend/src/ws.ts:78-80` is *debounced* by 500 ms, so it fires only after scrolling stops. Most of the work during a scroll is therefore Chromium *rasterising* newly exposed *tiles*.

1. **Vector rasterisation.** This is the leading hypothesis. Every newly exposed tile requires drawing every glyph path that falls inside it. The suspicion is that GPU path rasterisation under Mesa on Intel hardware costs more than CPU rasterisation of the same content. A small GPU memory budget would also make Chromium evict off-screen tiles and redraw them when they return. Both fit "smooth on CPU, stutters on GPU".
2. **Non-passive wheel listener.** `tools/typst-dom/src/typst-doc.mts:332` registers `wheel` on `window` with `passive: false`, so the handler near line 300 can implement Ctrl+wheel zoom. A *non-passive listener* forces Chromium to send each wheel event to the main thread and wait for it before scrolling. Any busy period on the main thread then delays the scroll. Making the listener passive would break Ctrl+wheel zoom and trackpad pinch-zoom, so this fix is not trivial.
3. **Hover repaints.** `.typst-text:hover` changes glyph fill in `typst.css`, and `tools/typst-preview-frontend/src/typst.ts:102` adds a `hover` class on `mousemove`. The suspicion is that, with the pointer over the preview during a scroll, text passing under it triggers repaints.

## Separate issue: full redraw 500 ms after every scroll pause

This issue applies with partial rendering on and off. It adds a hitch after each pause, but it does not explain stutter during continuous scrolling.

- `ws.ts:78-80` calls `addViewportChange()` 500 ms after scrolling stops.
- `tools/typst-dom/src/typst-doc.mts:390` treats `viewport-change` as needing a rerender. As a result, `rerender()` and `rescale()` run at `typst-doc.mts:429-433` even when the document is unchanged.
- `decorateSvgElement` (`tools/typst-dom/src/typst-doc.svg.mts:726-768`) builds a fresh `<rect class="typst-page-inner">` and `<clipPath id="typst-page-clip-N">` for every page. It also rebuilds the outer rect and the cursor circle.
- `patchRoot` calls `preReplaceNonSVGElements` (`tools/typst-dom/src/typst-patch.svg.mts:79-134`), which removes every non-`<g>` child of the root `<svg>` and inserts the new copies without an equality check.

Every page references its `clipPath` by id, so replacing those nodes invalidates paint for every page and forces full re-rasterisation. The proposed fix keeps an existing node when the new one passes `isEqualNode`, and replaces only the nodes that changed. It needs a new case in `tools/typst-dom/src/typst-patch.test.mts`.

## Other minor items

- `tinymist.preview.invertColors` applies `filter: invert(...) hue-rotate(...)` to `.typst-doc`. When it is enabled, the *compositor* applies a filter to the whole document layer on every frame. Check whether the affected user has it enabled.
- The `.typst-svg-cursor` blink animation repaints its own small region every 1.2 s. Its cost is minor.

## Next steps on the Ubuntu machine

Run these in order. Steps 1 to 4 are tests, and step 5 is a fix to make whatever the tests show.

1. **Disable GPU rasterisation.** Launch `code --disable-gpu-rasterization`, which keeps GPU compositing but rasterises on the CPU. Smooth scrolling here means cause 1 dominates.
2. **Paint flashing.** Run "Developer: Open Webview Developer Tools" from the command palette with the preview focused. In the Rendering tab, enable *paint flashing*, then scroll continuously. Text flashing under the pointer points to cause 3. Repeat with the pointer off the preview, scrolling by keyboard (j/k or the arrow keys, `ws.ts:195-225`). The whole page flashing about 0.5 s after each stop confirms the separate redraw issue. The console logs `parse … ms, rerender … ms, total … ms` for each rerender.
3. **Performance trace.** In the Performance tab, record a short scroll. Long raster tasks on the GPU thread point to cause 1. Wheel input waiting on a busy main thread points to cause 2.
4. **Canvas render mode.** typst-dom has a canvas render mode (`typst-doc.canvas.mts`) that draws each page to a bitmap once, so scrolling only composites finished images. The preview never enables it, because `createSvgDocument` in `ws.ts` (near line 56) does not pass `renderMode`. Pass `renderMode: "canvas"` there, rebuild with `yarn build:preview`, and compare. Text selection and some cursor features only work in SVG mode, so this is a diagnostic build only.
5. **Fix the redraw after each pause.** Apply the `isEqualNode` fix from the section above, whatever the other tests show.

## Measurements on macOS (Apple M1)

These measurements come from an Apple M1 machine, not the affected Ubuntu machine. The "Limits" list below records where the setup differs from the user's.

### Setup

- Server: tinymist v0.15.8, using the binary from the installed VS Code extension, launched as `tinymist preview --no-open --partial-rendering <true|false> --data-plane-host 127.0.0.1:23625 main.typ`.
- Test document: 50 A4 pages of lorem text in 40 sections, with an equation and a 4×4 table in each section.
- Browser: Google Chrome rather than the VS Code *Electron* webview, in a 1200×950 window with `devicePixelRatio` 2. The Chrome DevTools Protocol drove the browser.
- Input: `Input.synthesizeScrollGesture` with the mouse-wheel source.
- Continuous phase: one 20,000 px scroll at 2000 px/s, lasting about 10 s.
- Pause phase: five 1,500 px scrolls, each followed by a 1.2 s pause. Each pause is longer than the 500 ms debounce.
- Instrumentation: a full Chrome trace was recorded. Scroll smoothness comes from Chrome's own `ScrollJankV4` trace events. Main-thread frame rate comes from a `requestAnimationFrame` loop. Post-pause blocking comes from *Long Animation Frame* entries.

### Results

| Partial rendering | Chrome flags | Main-thread frames during continuous scroll | Janky scroll frames | Main-thread block after each pause |
| --- | --- | --- | --- | --- |
| on | none | 60/s | 0 / 600 | 63–76 ms |
| on | `--disable-gpu-rasterization` | 60/s | 0 / 600 | 50–148 ms |
| on | `--disable-gpu` | 60/s | 0 / 601 | 51–72 ms |
| off | none | 6/s | 0 / 599 | 134–166 ms |
| off | `--disable-gpu-rasterization` | 6/s | 0 / 600 | 134–175 ms |
| off | `--disable-gpu` | 6/s | 0 / 601 | 130–162 ms |

### Findings

1. **Scrolling stayed smooth.** All six configurations scrolled smoothly by Chrome's *jank* metric. Every scroll frame landed on the next *vsync* (vertical sync), 16.7 ms apart on this 60 Hz display. The stutter did not reproduce on the M1.
2. **Partial rendering off saturates the main thread.** With partial rendering off, the renderer main thread managed 6 frames per second during scrolling, whatever the GPU flags. Each main frame took about 250 ms. About 67 ms of that was `Paint`, and about 160 ms was `Layerize` (`PaintArtifactCompositor::Update`). The compositor still carried the scroll on the M1, but a slower CPU has less margin. This fits the Ubuntu report that turning partial rendering off made no difference. The reason Chrome repaints during a compositor-driven scroll is not yet known.
3. **The redraw after each pause is confirmed.** Each pause produced exactly one long main-thread frame. It lasted 130–175 ms with partial rendering off and 50–148 ms with it on, mostly 60–76 ms. The JavaScript `rerender` timing logged only 2–11 ms of that. Most of the cost is therefore Chrome repainting after the DOM replacement, which is consistent with the `clipPath` replacement theory above. The long frame landed after each scroll ended, so it did not register as scroll jank.
4. **GPU rasterisation is cheap on the M1.** With partial rendering on, `RasterTask` events totalled 17 ms over the whole run. With `--disable-gpu-rasterization`, raster tasks totalled about 2 s, and single tasks on background threads took up to 419 ms. Scrolling still showed no jank. Cause 1, GPU rasterisation under Mesa, cannot be tested on the M1.
5. **The non-passive wheel listener cost little.** The first wheel event of each gesture reached the main thread within 1–16 ms. Chrome blocks only on the first wheel event of a scroll sequence, so cause 2 added little delay here.

### Limits

- Chrome stood in for the VS Code Electron webview.
- Input was synthetic wheel scrolling at a fixed speed, not a real trackpad.
- The jank metric does not count *checkerboarding*, where tiles show blank because they are not yet rasterised.
- Cause 3 (hover repaints) is untested, because synthetic wheel input never moves the pointer.
- The standalone command-line interface (CLI) defaults to partial rendering off, whereas VS Code defaults to on.

## Results

Record each measurement here as it comes in, with the exact command or settings that produced it.

### Chrome reproduction on the affected machine (2026-10-09)

The stutter reproduces outside VS Code. The machine has an Intel Raptor Lake-P GPU with Mesa 23.2.1, under a Wayland session on Ubuntu 22.04.5. The test serves `scroll-bench/doc.typ` (45 A4 pages, 195,110 glyph `<use>` elements) with the tinymist 0.15.8 binary from the VS Code extension:

```sh
tinymist preview scroll-bench/doc.typ --no-open --host 127.0.0.1:23700 --partial-rendering false
```

`scroll-bench/bench.mjs` launches Google Chrome 154 with `--ozone-platform=wayland` and a fresh profile. It drives a 12,000 px synthetic wheel scroll through the Chrome DevTools Protocol (CDP) and records a trace. `swaps.py` measures intervals between compositor swaps, which are the frames the user sees. `threads.py` counts tasks longer than 50 ms on each thread:

```sh
SPEED=1000 TRACE=t.json node scroll-bench/bench.mjs <label> http://127.0.0.1:23700/ [chrome flags]
python3 scroll-bench/swaps.py t.json <label>; python3 scroll-bench/threads.py t.json <label>
```

At 1000 px/s, two runs per configuration:

| Configuration | Compositor fps | Gaps > 100 ms | `CrGpuMain` tasks > 50 ms | `doUpdate` mid-scroll |
| --- | --- | --- | --- | --- |
| default (GPU raster) | 33.5, 33.6 | 39, 38 | 45 (4.8 s total, max 149 ms), 42 (4.8 s, max 201 ms) | 2, 2 |
| `--disable-gpu-rasterization` | 57.0 | 2 | 0 | 0 |

The second `--disable-gpu-rasterization` run was lost to a harness bug. At 2000 px/s the pattern held but was noisier: 7–9 gaps over 100 ms with GPU raster, 2 without.

Two separate problems show in the traces.

**GPU raster blocks the GPU main thread.** With GPU raster on, `CrGpuMain` spends 100–310 ms at a time in `RasterDecoderImpl::DoEndRasterCHROMIUM::Flush`, rasterising glyph paths. Display swaps queue behind those flushes, so the compositor misses frames even though the scroll itself runs off the main thread. With `--disable-gpu-rasterization`, raster moves to the renderer's worker threads and `CrGpuMain` has no long tasks. This confirms cause 1. The user's `~/.local/bin/code` wrapper already passes `--disable-gpu-rasterization` as a workaround.

**The renderer main thread is saturated in every configuration.** During the scroll each main frame takes 500–870 ms, nearly all in `Paint` and `Layerize`, while `PaintInvalidator` reports only 5 invalidations per frame. The cause of the per-frame repaint is still open. Cull-rect updates as the scroll offset moves are the likely trigger, since `CullRectUpdate` runs in every slow frame. Glyphs reach the paint step as separate `<use>` instances, each with its own `x` translation. That makes the paint chunk count, and so the cost of `Layerize`, scale with the glyph count. This was not measured directly. The `transform: matrix(1,0,0,1,var(--o),0)` rule in `typst.css` is excluded, because `--o` is never set and the rule computes to `none`.

The saturated main thread feeds the "redraw after each pause" issue. Scroll events reach the page once per main frame, so frames over 500 ms let the 500 ms debounce in `ws.ts` fire during a continuous scroll. With GPU raster on, `doUpdate` ran twice mid-scroll in every run. Each of those main frames took 2.2–2.5 s, with about 383,000 `PaintInvalidator` calls after the `typst-page-inner` rects and clip paths were rebuilt.

Hover is excluded as a cause. With `pointer-events: none` forced on everything under `#typst-app`, the main thread still produced 13 frames over 50 ms out of 29.

### Step 5: `isEqualNode` fix (2026-10-09)

`preReplaceNonSVGElements` in `tools/typst-dom/src/typst-patch.svg.mts` now patches the leading run of non-`<g>` children in place. It keeps each old node that passes `isEqualNode` and swaps only the changed ones. Runs after the first `<g>` are still replaced, because `changeViewPerspective` gives them no stable position. In the root `<svg>`, every decoration sits in the leading run: one outer rect, then a rect and a `<clipPath>` per page. `typst-patch.svg.test.mts` covers the change, and two of its four cases fail on the old code.

Both builds come from the same commit with `yarn build:preview`. Each is served as a static file on its own port, with `tinymist preview` providing the data plane on 23625. Each run jumps `#typst-container-main` 2400 px five times, with 1.5 s pauses (`JUMP=1 PAUSES=5`), so the 500 ms debounce fires after every jump:

| Build | Paint invalidations | Main frames over 1 s |
| --- | --- | --- |
| base | 1,457,959 | 3 (1357–1394 ms) |
| fixed | 383,238 | 1 (1013 ms) |

A `MutationObserver` shows what changed. On every rerender the base build removed and re-inserted 45 `<clipPath>` nodes and 46 rects. On the rerenders that changed nothing, the fixed build left the DOM untouched. Both builds made a frame of 300–350 ms after every jump, which is Chrome painting the newly exposed area.

The remaining storm in the fixed build is one real geometry change, on the first rerender after load. The first render measures `#typst-container-main` before its vertical scrollbar appears. `decorateSvgElement` derives `heightMargin = 5 × maxWidth / container.width`, so the margin changes when the scrollbar narrows the container. On this machine the width went from about 1118 px to 1103 px, and the document height from 38124.56 to 38127.75 units. Every page's `transform` then moves, and all of them are repainted. A fix would measure the container once the scrollbar is present, or round the margin so small width changes leave it unchanged.

These runs used a headless sway, so no window appeared on the desktop. Chrome's own `--headless` mode always falls back to SwiftShader, which hides the GPU problem. Under sway, Chrome still reports the Intel GPU with GPU rasterisation enabled:

```sh
mkdir -m 700 -p /tmp/swayrt   # socket paths are limited to 108 characters
printf 'output HEADLESS-1 resolution 1200x1000@60Hz\ndefault_border none\n' > sway.conf
XDG_RUNTIME_DIR=/tmp/swayrt WLR_BACKENDS=headless WLR_RENDERER=gles2 \
  WLR_RENDER_DRM_DEVICE=/dev/dri/renderD128 WLR_LIBINPUT_NO_DEVICES=1 \
  sway --unsupported-gpu -c sway.conf &
XDG_RUNTIME_DIR=/tmp/swayrt WAYLAND_DISPLAY=wayland-1 JUMP=1 PAUSES=5 TRACE=t.json \
  node scroll-bench/bench.mjs fixed http://127.0.0.1:23802/
```

Scrolling under sway cannot be compared with the windowed runs above. `Input.synthesizeScrollGesture` never returns there. The fallback sends `Input.dispatchMouseEvent` wheel events at 60 Hz, and Chrome treats each of those as the start of a new scroll. Each event then blocks on the non-passive `wheel` listener, and the compositor fell to 4.5–6 fps both with and without GPU raster. The jump mode avoids input altogether, so it measures only the rerender cost.

### Test 1: `--disable-gpu-rasterization`

- Scrolling behaviour: _pending_ in VS Code. In Chrome, compositor fps rose from 33.5 to 57.0 and gaps over 100 ms fell from 38–39 to 2 (see above).
- Notes: _pending_

### Test 2: Paint flashing

- Pointer over preview, continuous scroll: _pending_
- Pointer off preview, keyboard scroll: _pending_
- Full-page flash about 0.5 s after each pause: _pending_
- Console `parse` / `rerender` / `total` timings: _pending_

### Test 3: Performance trace

- Raster tasks on the GPU thread: confirmed in Chrome. 42–45 `CrGpuMain` tasks over 50 ms per run, up to 310 ms each.
- Wheel input waiting on the main thread: _pending_. The `wheel` handler itself ran for 1.0 ms in total during a scroll. Whether input waited behind the 500–870 ms main frames was not measured.

### Test 4: Canvas render mode

- Scrolling compared with SVG mode: _pending_
- Notes: _pending_

These four results decide which cause gets fixed first. The redraw fix in step 5 stands on its own and is worth shipping whatever they show.

### Per-page prototypes (2026-10-09)

`scroll-bench/split.js` restructures the rendered preview in the browser, with no typst-dom changes. It hides the document `<svg>` and moves each page into its own `<svg>`, inside a div with `content-visibility: auto`. Glyph `<use>` references still resolve against the shared `#typst-svg-resources`. Text selection never touches the glyphs. Each of the 2,800 text runs carries a transparent HTML `.tsel` overlay in a `<foreignObject>`, so selection survives any change to how the glyphs are drawn.

Each run scrolls `#typst-container-main` from a `requestAnimationFrame` loop at 1000 px/s for 12 s (`RAF=1`), under headless sway on the Intel GPU. Script-driven scrolling needs the main thread on every frame, so the frame count measures main-thread and GPU throughput together. It does not measure compositor smoothness under real input. Two runs per row gave matching results; the table shows the first:

| Variant (`SPLIT=`) | Raster | Frames in 12 s | Main thread busy | `CrGpuMain` busy |
| --- | --- | --- | --- | --- |
| original | GPU | 50 | 12.3 s | 4.7 s |
| original | CPU | 51 | 12.2 s | 0 |
| `1`: one `<svg>` per page | GPU | 146 | 0.85 s | 11.2 s |
| `1`: one `<svg>` per page | CPU | 664 | 1.0 s | 0 |
| `img`: page drawn by `<img>`, `.tsel` overlay live | GPU | 146 | 0.05 s | 11.3 s |
| `img`: page drawn by `<img>`, `.tsel` overlay live | CPU | 712 | 0.10 s | 0 |
| `bitmap`: `<img>` drawn once into a CPU canvas, `.tsel` overlay live | GPU | 724 | 0 | 0 |
| `bitmap`: `<img>` drawn once into a CPU canvas, `.tsel` overlay live | CPU | 724 | 0 | 0 |

Splitting the document removes the main-thread cost, and the GPU becomes the limit. Chrome keeps an SVG `<img>` as a vector recording and rasterises it on the GPU tile by tile, so the `img` variant hits the same 11 s of GPU work. Only a real bitmap removes it. In the `bitmap` variant, each page is drawn once into a canvas created with `willReadFrequently: true`, which Chrome backs in software. Scrolling then composites uploaded textures at 60 fps, with no task over 50 ms on any thread, whether GPU raster is on or off. A `Range` across four `.tsel` runs still returned the expected text.

The bitmaps cost time and memory up front. Rasterising all 45 pages took 3335–3346 ms on the main thread (about 74 ms per page), and the canvases hold 357 MB (7.9 MB per A4 page at a 1103 px document width). A real implementation needs these parts:

- **Bitmap window.** Rasterise visible pages plus a margin during idle time, and release bitmaps far from the viewport. Chrome cannot decode an SVG image in a worker, so the 74 ms per page lands on the main thread, in idle slices.
- **Hidden model.** Keep patching one hidden document `<svg>` as today, so the backend protocol and `typst-patch` stay unchanged. Re-rasterise only pages whose `<g>` the patch changed. The model must stay laid out (`visibility: hidden`, not `display: none`), because cursor and jump code calls `getBBox` and `getScreenCTM` on glyphs.
- **Overlay.** A per-page `<svg>` holds the `.tsel` runs, link rects and the cursor. The `.typst-text:hover` glyph recolouring cannot work on a bitmap and would become an overlay highlight.
- **Zoom.** Show the stale bitmap scaled while visible pages re-rasterise at the new scale.

### Bitmap underlay (2026-10-09)

The `underlay` variant (`SPLIT=underlay`) needs no separate overlay. It leaves the document `<svg>` in place and changes it only through CSS: glyph `<use>` elements, shape paths and images outside `<foreignObject>` get `visibility: hidden`, and `.typst-page-inner` gets `fill: none`. A layer of per-page CPU canvases sits underneath, positioned from each page's `data-x` and `data-y`. Hidden elements keep their geometry, so `getBBox`, `getScreenCTM` and `getBoundingClientRect` return the same values as before. Two details came out of building it:

- The layer must sit outside `#typst-app`. typst-dom treats the first child of `#typst-app` as the document `<svg>`, and the first rerender destroyed a layer placed there.
- `#typst-app` paints the preview background, so that colour has to move to `#typst-container-main` and `#typst-app` has to become transparent.

Scrolling as in the table above gave 715 and 717 frames in 12 s with GPU raster, and 713 and 714 without. No frame took over 50 ms, and no thread had a task over 50 ms.

A functional probe ran the same checks on the original and the underlay. Both gave identical results:

| Check | Result on both |
| --- | --- |
| Real click (`Input.dispatchMouseEvent`) on text | hit `.tsel`; sent `src-point {"page_no":1,"x":90.53…,"y":163.83…}` |
| `handleTypstLocation(root, 3, 100, 200)`, the editor-jump handler | scrolled from 12000 to 3417 |
| `Range` across two `.tsel` runs | "fieri tamen permagna accessio potest, si aliquod aeternum et" |
| `#typst-app` first child after a rerender | `svg.typst-doc` |

Some features were not exercised, but they should keep working, because the elements they use are not hidden. These are link hover and click (`.pseudo-link` rects), the editor-cursor ellipse from `cursor-paths`, keyboard navigation, the page selector, and viewport sync. Three things need new work:

- **Hover recolouring.** `.hover .typst-text` and `.typst-text:hover` change the fill of hidden glyphs, so they show nothing. They need a highlight drawn above the bitmap.
- **Inverted colours.** The `invertColors` filter on `.typst-doc` must also apply to the bitmap layer.
- **Bitmap sync.** After each patch, re-rasterise the pages whose `<g>` changed, and move the canvases whenever page positions or the scale change.
