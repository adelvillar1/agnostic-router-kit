#!/usr/bin/env node
/**
 * Regenerate the light-theme stills the README embeds.
 *
 * archify ships interactive HTML in both themes, and GitHub renders PNG, not
 * HTML — so the README embeds stills instead. Each still is the diagram's own
 * inline SVG, laid out at exactly its viewBox size inside a page that carries
 * the viewer's font and theme CSS with the light palette forced. Nothing is
 * scaled, reflowed or cropped, so the still is the diagram at its exact layout
 * size, rasterised at 2x for the displays GitHub's image pipeline serves.
 *
 *   node docs/architecture/render-png.mjs            # render every diagram
 *   node docs/architecture/render-png.mjs --check    # verify only, write nothing
 *
 * Needs headless Chrome. Override the binary with CHROME=/path/to/Chrome.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCALE = Number(process.env.SCALE || 2);
const CHECK_ONLY = process.argv.includes("--check");

const htmlFiles = readdirSync(here)
  .filter((f) => f.endsWith(".html"))
  .sort();

if (htmlFiles.length === 0) {
  console.error(`no .html diagrams in ${here}`);
  process.exit(1);
}

function styleBlocks(html) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const fonts = blocks.find((b) => b.includes("@font-face"));
  const theme = blocks.find((b) => b.includes("--bg"));
  if (!fonts || !theme) throw new Error("could not find the font and theme style blocks");
  return { fonts, theme };
}

/** The one inline diagram SVG, plus the viewBox it declares. */
function diagramSvg(html) {
  const match = html.match(/<svg[\s\S]*?<\/svg>/);
  if (!match) throw new Error("no inline <svg>");
  const box = match[0].match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!box) throw new Error("the inline <svg> declares no viewBox");
  return { svg: match[0], w: Number(box[1]), h: Number(box[2]) };
}

function page({ svg, w, h }, fonts, theme) {
  return `<!doctype html>
<html lang="en" data-theme="light" data-preset="classic">
<head><meta charset="utf-8"><title>light still</title>
<style>${fonts}</style><style>${theme}</style>
<style>
html, body { margin: 0; padding: 0; }
/* The viewer's own sheet sizes svg responsively; a still must not be. */
svg { width: ${w}px !important; height: ${h}px !important; min-width: 0 !important; display: block; }
</style>
</head>
<body>
${svg}
</body>
</html>`;
}

/** PNG width and height from the IHDR chunk — no decoder, no dependency. */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function render(pageHtml, pngPath, w, h) {
  const dir = mkdtempSync(join(tmpdir(), "archify-still-"));
  const pagePath = join(dir, "still.html");
  writeFileSync(pagePath, pageHtml);
  try {
    execFileSync(
      CHROME,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--force-device-scale-factor=" + SCALE,
        "--virtual-time-budget=20000",
        `--window-size=${w},${h}`,
        `--screenshot=${pngPath}`,
        "file://" + pagePath,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const buf = readFileSync(pngPath);
  const got = pngSize(buf);
  const want = { w: w * SCALE, h: h * SCALE };
  if (got.w !== want.w || got.h !== want.h) {
    throw new Error(`rendered ${got.w}x${got.h}, expected ${want.w}x${want.h} — the layout shifted`);
  }
  return got;
}

let failed = 0;
for (const file of htmlFiles) {
  const base = file.replace(/\.html$/, "");
  const png = join(here, base + ".png");
  try {
    const { svg, w, h } = diagramSvg(readFileSync(join(here, file), "utf8"));
    const { fonts, theme } = styleBlocks(readFileSync(join(here, file), "utf8"));
    if (CHECK_ONLY) {
      const got = pngSize(readFileSync(png));
      const ok = got.w === w * SCALE && got.h === h * SCALE;
      console.log(`${ok ? "ok  " : "FAIL"} ${base}.png — ${got.w}x${got.h} (${w}x${h} @ ${SCALE}x)`);
      if (!ok) failed++;
      continue;
    }
    const got = render(page({ svg, w, h }, fonts, theme), png, w, h);
    const kb = Math.round(statSync(png).size / 1024);
    console.log(`ok   ${base}.png — ${got.w}x${got.h} (${w}x${h} @ ${SCALE}x), ${kb} kB`);
  } catch (err) {
    console.error(`FAIL ${base}: ${err.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
