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

### Test 1: `--disable-gpu-rasterization`

- Scrolling behaviour: _pending_
- Notes: _pending_

### Test 2: Paint flashing

- Pointer over preview, continuous scroll: _pending_
- Pointer off preview, keyboard scroll: _pending_
- Full-page flash about 0.5 s after each pause: _pending_
- Console `parse` / `rerender` / `total` timings: _pending_

### Test 3: Performance trace

- Raster tasks on the GPU thread: _pending_
- Wheel input waiting on the main thread: _pending_

### Test 4: Canvas render mode

- Scrolling compared with SVG mode: _pending_
- Notes: _pending_

These four results decide which cause gets fixed first. The redraw fix in step 5 stands on its own and is worth shipping whatever they show.
