/**
 * p5render client — drop into any p5 page.
 *
 * When the URL contains ?record=1, waits for a <canvas>, records with
 * MediaRecorder, POSTs the WebM to ?callback=, then window.close().
 *
 * Query params:
 *   record=1              enable capture
 *   callback=<url>        POST target (required for nvim flow)
 *   seconds=4             duration
 *   fps=60                captureStream fps
 *   delay=0               seconds to wait after canvas appears before start
 *   mime=<type>           optional mime override
 *
 * Usage (manual):
 *   import { armP5Render } from "…/client/p5render-client.js";
 *   armP5Render(); // or armP5Render({ canvas: () => myCanvas.elt })
 *
 * Auto-arm on import when ?record=1 is present (default export side effect
 * is opt-in via armP5Render() — call it once from your sketch or Vite inject).
 */

function qs(name, fallback = null) {
  const v = new URLSearchParams(location.search).get(name);
  return v === null ? fallback : v;
}

function pickMimeType(preferred) {
  if (preferred && MediaRecorder.isTypeSupported(preferred)) return preferred;
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/**
 * @param {object} [options]
 * @param {() => (HTMLCanvasElement|null|undefined)} [options.canvas]
 *        Getter for the canvas to record. Defaults to first <canvas> in DOM.
 * @param {number} [options.seconds]
 * @param {number} [options.fps]
 * @param {number} [options.delay] seconds after canvas found
 * @param {string} [options.callback]
 * @param {string} [options.mime]
 * @param {boolean} [options.downloadFallback=true] save via <a download> if no callback
 * @returns {Promise<void>|undefined} resolves when recording flow finishes (or undefined if not armed)
 */
export function armP5Render(options = {}) {
  if (qs("record") !== "1") return;

  const seconds = Number(options.seconds ?? qs("seconds", "4"));
  const fps = Number(options.fps ?? qs("fps", "60"));
  const delay = Number(options.delay ?? qs("delay", "0"));
  const callback = options.callback ?? qs("callback");
  const mime = pickMimeType(options.mime ?? qs("mime") ?? undefined);
  const downloadFallback = options.downloadFallback !== false;
  const getCanvas =
    options.canvas ||
    (() => document.querySelector("canvas"));

  return runCapture({
    getCanvas,
    seconds,
    fps,
    delay,
    callback,
    mime,
    downloadFallback,
  });
}

/**
 * Same as armP5Render but always runs (ignores ?record=). Useful for tests.
 */
export function recordNow(options = {}) {
  const seconds = Number(options.seconds ?? 4);
  const fps = Number(options.fps ?? 60);
  const delay = Number(options.delay ?? 0);
  const callback = options.callback ?? qs("callback");
  const mime = pickMimeType(options.mime);
  const downloadFallback = options.downloadFallback !== false;
  const getCanvas =
    options.canvas ||
    (() => document.querySelector("canvas"));

  return runCapture({
    getCanvas,
    seconds,
    fps,
    delay,
    callback,
    mime,
    downloadFallback,
  });
}

/**
 * @param {{
 *   getCanvas: () => (HTMLCanvasElement|null|undefined),
 *   seconds: number,
 *   fps: number,
 *   delay: number,
 *   callback: string|null,
 *   mime: string,
 *   downloadFallback: boolean,
 * }} cfg
 */
async function runCapture(cfg) {
  showBanner(`p5render: waiting for canvas…`);

  const canvas = await waitForCanvas(cfg.getCanvas, 30000);
  if (!canvas) {
    console.error("[p5render] no canvas found");
    showBanner("p5render: no canvas found", true);
    return;
  }

  if (cfg.delay > 0) {
    await countdown(cfg.delay, (s) => `p5render: starting in ${s}s…`);
  }

  if (typeof MediaRecorder === "undefined") {
    console.error("[p5render] MediaRecorder not available");
    showBanner("p5render: MediaRecorder unavailable", true);
    return;
  }

  const stream = canvas.captureStream(cfg.fps);
  const recorderOpts = cfg.mime ? { mimeType: cfg.mime } : {};
  /** @type {MediaRecorder} */
  let rec;
  try {
    rec = new MediaRecorder(stream, recorderOpts);
  } catch (err) {
    console.error("[p5render] MediaRecorder construct failed", err);
    showBanner("p5render: MediaRecorder failed", true);
    return;
  }
  /** @type {BlobPart[]} */
  const chunks = [];

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };

  const stopped = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(undefined);
    rec.onerror = (e) => reject(e.error || new Error("MediaRecorder error"));
  });

  console.info(
    `[p5render] recording ${cfg.seconds}s @ ${cfg.fps}fps` +
      (cfg.mime ? ` (${cfg.mime})` : ""),
  );
  rec.start(100);

  await countdown(cfg.seconds, (s) => `p5render: recording ${s}s…`);
  if (rec.state !== "inactive") rec.stop();
  await stopped;
  showBanner("p5render: processing…");

  for (const t of stream.getTracks()) t.stop();

  const blob = new Blob(chunks, { type: cfg.mime || "video/webm" });
  if (!blob.size) {
    console.error("[p5render] empty recording");
    showBanner("p5render: empty recording", true);
    return;
  }

  if (cfg.callback) {
    try {
      const res = await fetch(cfg.callback, {
        method: "POST",
        body: blob,
        headers: { "Content-Type": blob.type || "video/webm" },
      });
      if (!res.ok) {
        console.error(`[p5render] POST ${cfg.callback} failed: ${res.status}`);
        showBanner(`p5render: upload failed (${res.status})`, true);
        return;
      }
      console.info("[p5render] uploaded webm");
      showBanner("p5render: done — closing…");
    } catch (err) {
      console.error("[p5render] upload error", err);
      showBanner("p5render: upload error", true);
      return;
    }
  } else if (cfg.downloadFallback) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `p5render-${Date.now()}.webm`;
    a.click();
    URL.revokeObjectURL(url);
    console.info("[p5render] download triggered");
    showBanner("p5render: download started");
  }

  // macOS recorder also closes the tab via AppleScript after POST.
  try {
    window.close();
  } catch {
    /* ignore */
  }
}

function showBanner(text, isError = false) {
  let el = document.getElementById("p5render-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "p5render-banner";
    el.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "z-index:2147483647",
      "padding:8px 12px",
      "font:13px/1.4 system-ui,sans-serif",
      "pointer-events:none",
    ].join(";");
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
  el.style.background = isError ? "#4a1515" : "#102a10";
  el.style.color = isError ? "#fcc" : "#cfc";
}

/**
 * @param {() => (HTMLCanvasElement|null|undefined)} getCanvas
 * @param {number} timeoutMs
 */
function waitForCanvas(getCanvas, timeoutMs) {
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      const c = getCanvas();
      if (c instanceof HTMLCanvasElement) {
        resolve(c);
        return;
      }
      if (performance.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Tick the banner once per second (ceil remaining) until duration elapses.
 * @param {number} totalSeconds
 * @param {(remaining: number) => string} label
 */
async function countdown(totalSeconds, label) {
  const totalMs = Math.max(0, Number(totalSeconds) || 0) * 1000;
  if (totalMs <= 0) {
    showBanner(label(0));
    return;
  }
  const end = performance.now() + totalMs;
  let lastShown = -1;
  while (true) {
    const remainingMs = end - performance.now();
    if (remainingMs <= 0) break;
    const remaining = Math.max(1, Math.ceil(remainingMs / 1000));
    if (remaining !== lastShown) {
      showBanner(label(remaining));
      lastShown = remaining;
    }
    await sleep(Math.min(100, remainingMs));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export default { armP5Render, recordNow };
