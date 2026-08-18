# p5render.nvim

Record a **running** p5.js (Vite) dev server to an **MP4** from Neovim.

```
:P5Render
:P5Render 6
:P5Render 4 my-clip
```

Prompts for a filename, opens the sketch with capture params, records the canvas, closes the tab (macOS), writes `out/<name>.mp4`.

**Does not start Vite.** Start your dev server yourself first.

## Requirements

- Neovim 0.9+
- Node.js
- `ffmpeg` on `PATH`
- A GUI browser (`open` / `xdg-open`)
- Chrome/Chromium/Firefox with `MediaRecorder` + `canvas.captureStream`

## Install

**lazy.nvim**

```lua
{
  "james-yap/p5render.nvim",
  lazy = false, -- or cmd = { "P5Render" }
  opts = {
    -- url = "http://localhost:5173", -- fallback if not found in a :terminal
    -- seconds = 4,
    -- fps = 60,
    -- out_dir = "out",
    -- open_after = false,
  },
  keys = {
    {
      "<leader>pr",
      function()
        local opts = {}
        if vim.v.count > 0 then
          opts.seconds = vim.v.count
        end
        require("p5render").render(opts)
      end,
      desc = "Render p5 sketch [count=seconds]",
    },
  },
}
```

`3<leader>pr` records for 3 seconds; bare `<leader>pr` uses the configured default.

`plugin/p5render.lua` registers `:P5Render` with defaults. Calling `setup()` / lazy `opts` again is safe (`force = true`).

## One-time page setup (pick one)

The page must run the capture client when the URL has `?record=1`.

### A. Vite plugin (no sketch edits)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import p5render from "../p5render.nvim/vite/p5render-vite.js"; // adjust path

export default defineConfig({
  plugins: [p5render()],
});
```

Injects the client in **serve** mode only. No-ops unless `?record=1`. No AST parsing.

### B. Manual client import

```ts
import { armP5Render } from "../p5render.nvim/client/p5render-client.js";

// safe before or after createCanvas — waits for <canvas>
armP5Render();
// or: armP5Render({ canvas: () => p.canvas as HTMLCanvasElement })
```

## Usage

1. Start the sketch dev server (`vite` / `npm run dev`).
2. In Neovim (cwd = project root):

   | Command | Meaning |
   |---|---|
   | `:P5Render` | default duration, prompt for filename |
   | `:P5Render 8` | 8 seconds |
   | `:P5Render 5 intro` | 5s, filename hint `intro.mp4` |

3. Confirm the filename (default under `out/` in cwd).
4. Browser opens the sketch → records → tab closes (macOS) → MP4 written.

URL discovery: parses `http://localhost:<port>` from Neovim **terminal** buffers (Vite’s “Local:” line). Falls back to `http://localhost:5173`.

## CLI (without Neovim)

```bash
node scripts/record.mjs \
  --url http://localhost:5173 \
  --out out/take.mp4 \
  --seconds 4 \
  --fps 60
```

Temp WebM: `~/.cache/p5render/` (or `$XDG_CACHE_HOME/p5render/`). Deleted after successful ffmpeg.

## How it works

```
:P5Render
  → node scripts/record.mjs
  → one-shot HTTP receiver on 127.0.0.1:<ephemeral>
  → open dev?record=1&callback=…&seconds=…&p5render=<token>
  → client: canvas.captureStream + MediaRecorder (WebM)
  → POST WebM to callback
  → macOS: osascript closes tabs whose URL contains p5render=<token>
  → ffmpeg → H.264 MP4 → rm temp
```

WebM in-browser (portable `MediaRecorder` support). ffmpeg always produces MP4.

## Config

| Option | Default | |
|---|---|---|
| `url` | `http://localhost:5173` | fallback dev URL |
| `seconds` | `4` | capture length |
| `fps` | `60` | `captureStream` fps |
| `timeout` | `120` | max wait for POST |
| `out_dir` | `out` | under cwd |
| `default_name` | `take` | prompt stem prefix |
| `discover_url` | `true` | scrape `:terminal` buffers |
| `open_after` | `false` | open MP4 when done |
| `record_script` | auto | override path to `record.mjs` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Dev server not reachable` | Start Vite first; check URL / terminal scrape |
| Timeout waiting for WebM | Add Vite plugin or `armP5Render()` |
| Tab doesn’t close | macOS only for auto-close; marker tab may need Accessibility permission for the terminal/nvim hosting `osascript` |
| Empty / black video | Ensure a `<canvas>` is drawing; try `armP5Render({ canvas: () => p.canvas })` |
| `ffmpeg not found` | `brew install ffmpeg` |

## License

MIT
