// Scroll the tinymist preview in Chrome and record frame intervals.
// Usage: node bench.mjs <label> <url> [chrome flags...]
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [label, url, ...flags] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), "chrome-"));
const chrome = spawn("google-chrome", [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1200,1000",
  // Chrome's --headless mode falls back to SwiftShader. To stay off-screen on
  // the hardware GPU, run under a headless sway instead (see BUG.md).
  "--ozone-platform=wayland",
  ...flags, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); }
}
const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return new Promise((r) => (ws.onopen = () => r({ send, ws })));
}

const b = await connect(browserWs);
const info = (await b.send("SystemInfo.getInfo")).result;
const gpu = info?.gpu;
const fs = gpu?.featureStatus ?? {};
const page = targets.find((t) => t.type === "page");
const p = await connect(page.webSocketDebuggerUrl);
await p.send("Page.enable"); await p.send("Runtime.enable");
await p.send("Page.navigate", { url });
const evalJs = async (expr) => (await p.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

for (let i = 0; i < 100; i++) {
  if ((await evalJs("document.querySelectorAll('.typst-page').length")) > 20) break;
  await sleep(200);
}
await sleep(3000);
const pages = await evalJs("document.querySelectorAll('.typst-page').length");

if (process.env.SPLIT) console.error("split:", JSON.stringify(await evalJs(`window.__SPLIT_MODE = ${JSON.stringify(process.env.SPLIT.replace("bitmap", "img"))}; window.__SPLIT_BITMAP = ${process.env.SPLIT === "bitmap"};` + (await import("node:fs")).readFileSync(new URL("./split.js", import.meta.url), "utf8"))));
if (process.env.PRE_JS) console.error("pre:", JSON.stringify(await evalJs(process.env.PRE_JS)));
await sleep(500);
if (process.env.CLICK_JS) {
  // Click with real input events at the [x, y] the script returns.
  const [x, y] = await evalJs(process.env.CLICK_JS);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await p.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  await sleep(500);
}
// Record rAF intervals while a synthetic touchpad-like scroll runs.
await evalJs(`window.__f=[];window.__run=true;(function t(ts){if(window.__last)window.__f.push(ts-window.__last);window.__last=ts;if(window.__run)requestAnimationFrame(t)})(performance.now());0`);
const events=[];
p.ws.addEventListener("message",(m)=>{const d=JSON.parse(m.data);if(d.method==="Tracing.dataCollected")events.push(...d.params.value);});
const traceDone=new Promise((r)=>p.ws.addEventListener("message",(m)=>{if(JSON.parse(m.data).method==="Tracing.tracingComplete")r();}));
if(process.env.TRACE) await p.send("Tracing.start",{traceConfig:{includedCategories:["devtools.timeline","disabled-by-default-devtools.timeline","v8.execute","blink","cc","gpu","viz","input","benchmark","disabled-by-default-devtools.timeline.invalidationTracking","disabled-by-default-blink.invalidation","scheduler"]},transferMode:"ReportEvents"});
// PAUSES=n scrolls in n steps with 1.5 s pauses, so the 500 ms debounce in
// ws.ts fires and rerenders after each step.
const steps = Number(process.env.PAUSES ?? 0);
for (let i = 0; i < Math.max(steps, 1); i++) {
  // Input.synthesizeScrollGesture never returns under a headless sway, so
  // send wheel events at 60 Hz instead.
  const distance = 12000 / Math.max(steps, 1);
  if (process.env.RAF) {
    // Scroll from a requestAnimationFrame loop at SPEED px/s. Every frame
    // needs the main thread, so the frame rate shows main-thread throughput.
    // It is a proxy for scroll smoothness, which needs real input to measure.
    const speed = Number(process.env.SPEED ?? 2000);
    await evalJs(`new Promise((done) => {
      const el = document.getElementById("typst-container-main");
      const t0 = performance.now(); let last = t0;
      (function step(now) {
        el.scrollTop += ${speed} * (now - last) / 1000; last = now;
        if (now - t0 < ${distance / speed} * 1000) requestAnimationFrame(step); else done();
      })(t0);
    })`);
    continue;
  }
  if (process.env.JUMP) {
    // Jump the scroll container directly. It fires the same scroll event and
    // 500 ms debounce as a real scroll, without depending on input delivery.
    await evalJs(`document.getElementById("typst-container-main").scrollTop += ${distance}; 0`);
    await sleep(1500);
    continue;
  }
  if (process.env.GESTURE) {
    await p.send("Input.synthesizeScrollGesture", {
      x: 600, y: 500, yDistance: -distance, speed: Number(process.env.SPEED ?? 2000), gestureSourceType: process.env.GESTURE, repeatCount: 0,
    });
    if (steps) await sleep(1500);
    continue;
  }
  const perTick = Number(process.env.SPEED ?? 2000) / 60;
  for (let moved = 0; moved < distance; moved += perTick) {
    const tick = sleep(1000 / 60);
    // Not awaited: a real wheel does not wait for the page to handle the
    // previous event before sending the next.
    p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 500, deltaX: 0, deltaY: perTick });
    await tick;
  }
  if (steps) await sleep(1500);
}
await evalJs("window.__run=false");
if(process.env.TRACE){await p.send("Tracing.end");await traceDone;const fs=await import("node:fs");const fd=fs.openSync(process.env.TRACE,"w");fs.writeSync(fd,'{"traceEvents":[');events.forEach((e,i)=>fs.writeSync(fd,(i?",":"")+JSON.stringify(e)));fs.writeSync(fd,"]}");fs.closeSync(fd);}
if (process.env.POST_JS) console.error("post:", JSON.stringify(await evalJs(process.env.POST_JS), null, 1));
if (process.env.SHOT) (await import("node:fs")).writeFileSync(process.env.SHOT, Buffer.from((await p.send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
const f = (await evalJs("window.__f")).slice(1);
f.sort((a, b) => a - b);
const pct = (q) => f[Math.min(f.length - 1, Math.floor(q * f.length))].toFixed(1);
const over = (ms) => f.filter((x) => x > ms).length;
console.log(JSON.stringify({
  label, flags: flags.join(" "), pages, frames: f.length,
  p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: f.at(-1).toFixed(1),
  over25: over(25), over50: over(50),
  gpu: `${gpu?.auxAttributes?.glRenderer ?? gpu?.devices?.[0]?.deviceString}`,
  raster: fs.rasterization, compositing: fs.gpu_compositing,
}));
chrome.kill();
process.exit(0);
