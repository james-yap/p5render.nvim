/**
 * Optional Vite plugin for p5render.
 *
 * Injects the capture client into every HTML page as a module. The client
 * no-ops unless the URL has ?record=1 — so normal dev is unaffected.
 *
 * No AST parsing. Uses transformIndexHtml only.
 *
 * vite.config.ts:
 *   import p5render from "…/vite/p5render-vite.js";
 *   // or: import p5render from "p5render.nvim/vite";
 *   export default defineConfig({ plugins: [p5render()] });
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.resolve(__dirname, "../client/p5render-client.js");
const VIRTUAL_ID = "virtual:p5render-client";
const RESOLVED_VIRTUAL_ID = "\0" + VIRTUAL_ID;

/**
 * @param {{ clientPath?: string }} [options]
 * @returns {import('vite').Plugin}
 */
export default function p5render(options = {}) {
  const clientPath = options.clientPath
    ? path.resolve(options.clientPath)
    : CLIENT_PATH;

  return {
    name: "p5render",
    apply: "serve", // dev server only — matches :P5Render workflow

    resolveId(id) {
      if (id === VIRTUAL_ID || id === `/@id/${VIRTUAL_ID}`) {
        return RESOLVED_VIRTUAL_ID;
      }
      return null;
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_ID) {
        const src = fs.readFileSync(clientPath, "utf8");
        // Append auto-arm so pages need zero sketch changes.
        return `${src}\n\narmP5Render();\n`;
      }
      return null;
    },

    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: {
            type: "module",
            // Vite serves virtual modules via /@id/
            src: `/@id/${VIRTUAL_ID}`,
          },
          injectTo: "body",
        },
      ];
    },
  };
}
