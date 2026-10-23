import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The official browser icon: the purple brand leaf with the gold "D",
// served through the Next.js App Router metadata file conventions in
// src/app (favicon.ico, icon.svg, icon1-3.png, apple-icon.png).
type Generator = {
  iconSvg: (options?: { fullBleed?: boolean }) => string;
  ico: (frames: { size: number; png: Buffer }[]) => Buffer;
};
const loadGenerator = () =>
  import("../scripts/brand/render-favicons.mjs") as Promise<Generator>;

const APP = "src/app";
const file = (name: string) => readFileSync(`${APP}/${name}`);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(buf: Buffer) {
  expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  expect(buf.toString("ascii", 12, 16)).toBe("IHDR");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colourType: buf.readUInt8(25),
  };
}
const css = readFileSync(`${APP}/globals.css`, "utf8");
const token = (name: string) =>
  new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1];

describe("official browser icon", () => {
  it("uses the existing brand purple and gold", async () => {
    // Line endings may follow the checkout (core.autocrlf).
    const svg = file("icon.svg").toString("utf8").replace(/\r\n/g, "\n");
    expect(token("launch-purple")).toBe("#312680");
    expect(token("launch-champagne")).toBe("#f4d19b");
    expect(svg).toContain(token("launch-purple"));
    expect(svg).toContain(token("launch-purple-deep"));
    expect(svg).toContain(`fill="${token("launch-champagne")}"`);
    expect(svg).toMatch(/font-style="italic"[^>]*>D<\/text>/);
    expect(svg).toContain('viewBox="0 0 64 64"');
    // Static artwork only: no script, link, external reference or font file.
    expect(svg).not.toMatch(/<script|href=|@import|url\((?!#)/i);
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(
      /https?:/,
    );
    // The committed icon is the generator's current artwork.
    expect(svg).toBe((await loadGenerator()).iconSvg());
  });

  it("provides 16, 32 and 48 pixel PNG icons and a 180 pixel apple-touch icon", () => {
    for (const [name, size] of [
      ["icon1.png", 16],
      ["icon2.png", 32],
      ["icon3.png", 48],
    ] as const) {
      const p = png(file(name));
      expect([p.width, p.height], name).toEqual([size, size]);
      expect(p.colourType, name).toBe(6); // RGBA: transparent leaf corners
    }
    const apple = png(file("apple-icon.png"));
    expect([apple.width, apple.height]).toEqual([180, 180]);
    expect(apple.colourType).toBe(2); // opaque, as iOS expects
  });

  it("ships favicon.ico with 16, 32 and 48 pixel frames", () => {
    const buf = file("favicon.ico");
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    const count = buf.readUInt16LE(4);
    const frames = Array.from({ length: count }, (_, i) => {
      const e = 6 + 16 * i;
      const length = buf.readUInt32LE(e + 8);
      const offset = buf.readUInt32LE(e + 12);
      const image = png(buf.subarray(offset, offset + length));
      expect(image.width).toBe(buf.readUInt8(e));
      return image.width;
    });
    expect(frames).toEqual([16, 32, 48]);
    // The ICO frames are exactly the PNG icons.
    expect(buf.subarray(6 + 16 * count).length).toBe(
      file("icon1.png").length +
        file("icon2.png").length +
        file("icon3.png").length,
    );
  });

  it("builds a valid ICO directory", async () => {
    const { ico } = await loadGenerator();
    const out = ico([{ size: 16, png: file("icon1.png") }]);
    expect(out.readUInt16LE(4)).toBe(1);
    expect(out.readUInt32LE(6 + 12)).toBe(22);
    expect(out.subarray(22).equals(file("icon1.png"))).toBe(true);
  });

  it("is declared only through the App Router file conventions", () => {
    const layout = readFileSync(`${APP}/layout.tsx`, "utf8");
    // A metadata.icons override would replace the file-convention tags.
    expect(layout).not.toMatch(/\bicons\s*:/);
    // Next.js refuses a public/favicon.ico next to app/favicon.ico.
    expect(existsSync("public/favicon.ico")).toBe(false);
  });
});
