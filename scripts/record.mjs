#!/usr/bin/env node
/**
 * p5render — one-shot recorder
 *
 * 1. Opens the already-running dev server with ?record=1&callback=…
 * 2. Receives a WebM POST from the sketch client
 * 3. Best-effort closes the capture tab (macOS AppleScript)
 * 4. Converts to MP4 via ffmpeg
 * 5. Cleans temp files under ~/.cache/p5render
 *
 * Does NOT start Vite. The dev server must already be running.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function usage(code = 0) {
  const msg = `Usage: record.mjs --url <dev-url> --out <file.mp4> [--seconds 4] [--fps 60] [--timeout 120]

Options:
  --url       Base URL of the already-running dev server (required)
  --out       Output MP4 path (required)
  --seconds   Capture duration in seconds (default: 4)
  --fps       captureStream frame rate (default: 60)
  --timeout   Max seconds to wait for the browser POST (default: 120)
`;
  if (code === 0) console.log(msg);
  else console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { seconds: 4, fps: 60, timeout: 120, url: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage(0);
    if (a === "--url") opts.url = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--seconds") opts.seconds = Number(argv[++i]);
    else if (a === "--fps") opts.fps = Number(argv[++i]);
    else if (a === "--timeout") opts.timeout = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${a}`);
      usage(1);
    }
  }
  if (!opts.url || !opts.out) usage(1);
  if (!Number.isFinite(opts.seconds) || opts.seconds <= 0) {
    console.error("--seconds must be a positive number");
    process.exit(1);
  }
  if (!Number.isFinite(opts.fps) || opts.fps <= 0) {
    console.error("--fps must be a positive number");
    process.exit(1);
  }
  if (!opts.out.endsWith(".mp4")) {
    console.error("--out must end with .mp4");
    process.exit(1);
  }
  return opts;
}

async function assertDevServer(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok && res.status >= 500) {
      throw new Error(`dev server returned ${res.status}`);
    }
  } catch (err) {
    console.error(`Dev server not reachable at ${url}`);
    console.error(err.message || err);
    console.error("Start your Vite/p5 dev server first, then re-run :P5Render.");
    process.exit(1);
  }
}

function whichFfmpeg() {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidate = path.join(dir, "ffmpeg");
    if (existsSync(candidate)) return candidate;
  }
  const homebrew = "/opt/homebrew/bin/ffmpeg";
  if (existsSync(homebrew)) return homebrew;
  return null;
}

function runFfmpeg(ffmpegBin, webmPath, mp4Path) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      webmPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ];
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr}`));
    });
  });
}

function openUrl(url) {
  const platform = process.platform;
  let cmd;
  let args;
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

/** Best-effort: close browser tabs whose URL contains the marker (macOS). */
function closeCaptureTabs(urlMarker) {
  if (process.platform !== "darwin") return Promise.resolve();
  const marker = String(urlMarker).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const apps = [
    "Google Chrome",
    "Chromium",
    "Brave Browser",
    "Microsoft Edge",
    "Arc",
    "Dia",
    "Vivaldi",
    "Safari",
  ];
  const lines = apps.flatMap((app) => [
    `try`,
    `  tell application "${app}"`,
    `    if it is running then`,
    `      repeat with w in windows`,
    `        try`,
    `          close (every tab of w whose URL contains "${marker}")`,
    `        end try`,
    `      end repeat`,
    `    end if`,
    `  end tell`,
    `end try`,
  ]);
  const script = lines.join("\n");
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ffmpegBin = whichFfmpeg();
  if (!ffmpegBin) {
    console.error("ffmpeg not found on PATH (or /opt/homebrew/bin/ffmpeg).");
    process.exit(1);
  }

  await assertDevServer(opts.url);

  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "p5render",
  );
  const workdir = path.join(cacheRoot, `${process.pid}-${Date.now()}`);
  await mkdir(workdir, { recursive: true });
  await mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });

  const webmPath = path.join(workdir, "take.webm");
  const outPath = path.resolve(opts.out);

  /** @type {{ resolve: (b: Buffer) => void, reject: (e: Error) => void } | null} */
  let pending = null;
  const webmPromise = new Promise((resolve, reject) => {
    pending = { resolve, reject };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/save") {
      try {
        const body = await readBody(req);
        if (!body.length) {
          res.writeHead(400, {
            "Content-Type": "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
          res.end("empty body");
          return;
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        res.end();
        pending?.resolve(body);
        pending = null;
      } catch (err) {
        res.writeHead(500, {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(String(err));
        pending?.reject(err);
        pending = null;
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    console.error("failed to bind receiver");
    process.exit(1);
  }
  const { port } = addr;
  const callback = `http://127.0.0.1:${port}/save`;

  // Unique marker so AppleScript can find this capture tab.
  const token = `${process.pid}-${Date.now()}`;
  const marker = `p5render=${token}`;
  const sketchUrl = new URL(opts.url);
  sketchUrl.searchParams.set("record", "1");
  sketchUrl.searchParams.set("callback", callback);
  sketchUrl.searchParams.set("seconds", String(opts.seconds));
  sketchUrl.searchParams.set("fps", String(opts.fps));
  sketchUrl.searchParams.set("p5render", token);

  console.log(`p5render: dev=${opts.url}`);
  console.log(`p5render: callback=${callback}`);
  console.log(`p5render: seconds=${opts.seconds} fps=${opts.fps}`);
  console.log(`p5render: opening ${sketchUrl}`);
  openUrl(sketchUrl.toString());

  const timer = setTimeout(() => {
    pending?.reject(
      new Error(
        `Timed out after ${opts.timeout}s waiting for WebM POST. ` +
          `Is the p5render client active on the page (client import or Vite plugin)?`,
      ),
    );
    pending = null;
  }, opts.timeout * 1000);

  let webmBuf;
  try {
    webmBuf = await webmPromise;
  } catch (err) {
    clearTimeout(timer);
    server.close();
    console.error(String(err.message || err));
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  }
  clearTimeout(timer);

  console.log(
    `p5render: received ${(webmBuf.length / 1024).toFixed(1)} KiB webm`,
  );
  await closeCaptureTabs(marker);
  await writeFile(webmPath, webmBuf);

  try {
    console.log(`p5render: ffmpeg → ${outPath}`);
    await runFfmpeg(ffmpegBin, webmPath, outPath);
  } catch (err) {
    console.error(String(err.message || err));
    console.error(`Keeping temp dir for debug: ${workdir}`);
    server.close();
    process.exit(1);
  }

  server.close();
  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  console.log(`p5render: wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
