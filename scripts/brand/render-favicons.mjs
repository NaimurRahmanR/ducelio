// Renders the Ducelio browser icons from the brand mark: the royal-purple
// leaf (the .brand-mark shape, 12px/2px corners) with the champagne-gold
// italic Georgia "D" used by the site header and homepage opening scene
// (src/app/globals.css: --launch-purple #312680, --launch-purple-deep
// #1f1757, --launch-champagne #f4d19b).
//
// Writes, under src/app (Next.js App Router metadata file conventions):
//   icon.svg        vector icon (the master artwork)
//   icon1.png       16x16
//   icon2.png       32x32
//   icon3.png       48x48
//   apple-icon.png  180x180, full-bleed (iOS applies its own mask)
//   favicon.ico     16, 32 and 48 PNG frames
//
// The rasters are rendered by headless Chrome so the glyph is the same
// Georgia italic the site shows. Run manually after changing the artwork:
//   node scripts/brand/render-favicons.mjs [path-to-chrome]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.argv[2] ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = new URL("../../src/app/", import.meta.url);
const PURPLE = "#312680";
const PURPLE_LIGHT = "#3d31a0";
const PURPLE_DEEP = "#1f1757";
const GOLD = "#f4d19b";

// Leaf: 18/64 radius top-left and bottom-right, 4/64 elsewhere.
const LEAF =
  "M18 0H60a4 4 0 0 1 4 4V46a18 18 0 0 1-18 18H4a4 4 0 0 1-4-4V18A18 18 0 0 1 18 0Z";
// The glyph's ink box is centred optically (measured in Chrome: Georgia
// italic "D" at 54px spans x -0.84..40.5 and rises 38px above the baseline).
const GLYPH = `<text x="11.7" y="51" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="54" fill="${GOLD}">D</text>`;

export function iconSvg({ fullBleed = false } = {}) {
  const shape = fullBleed
    ? `<rect width="64" height="64" fill="url(#ducelio-purple)"/>`
    : `<path d="${LEAF}" fill="url(#ducelio-purple)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>Ducelio</title><defs><linearGradient id="ducelio-purple" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${PURPLE_LIGHT}"/><stop offset="0.55" stop-color="${PURPLE}"/><stop offset="1" stop-color="${PURPLE_DEEP}"/></linearGradient></defs>${shape}${GLYPH}</svg>\n`;
}

// An ICO file whose frames are PNG images (supported by every current
// browser and by Windows since Vista).
export function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chrome() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), "ducelio-icons-"));
  const proc = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "about:blank",
  ]);
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json`)
      ).json();
      page = targets.find((t) => t.type === "page");
    } catch {}
    if (!page) await sleep(200);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const close = async () => {
    ws.close();
    proc.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  };
  return { send, close };
}

async function render(send, svg, size) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setScrollbarsHidden", { hidden: true });
  await send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  const html = `<!doctype html><html style="overflow:hidden"><body style="margin:0;overflow:hidden;background:transparent">${svg.replace(
    "<svg ",
    `<svg width="${size}" height="${size}" style="display:block" `,
  )}</body></html>`;
  await send("Page.navigate", {
    url: `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
  });
  await sleep(400);
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
  });
  return Buffer.from(data, "base64");
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const { send, close } = await chrome();
  try {
    await send("Page.enable");
    const svg = iconSvg();
    writeFileSync(new URL("icon.svg", OUT), svg);
    const frames = [];
    for (const [size, name] of [
      [16, "icon1.png"],
      [32, "icon2.png"],
      [48, "icon3.png"],
    ]) {
      const png = await render(send, svg, size);
      writeFileSync(new URL(name, OUT), png);
      frames.push({ size, png });
    }
    writeFileSync(new URL("favicon.ico", OUT), ico(frames));
    writeFileSync(
      new URL("apple-icon.png", OUT),
      await render(send, iconSvg({ fullBleed: true }), 180),
    );
  } finally {
    await close();
  }
}
