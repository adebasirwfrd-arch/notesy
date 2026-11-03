import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public/icons");
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel((x + 0.5) / size, (y + 0.5) / size);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const icon = (x, y) => {
  if (!inRoundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.22)) return [0, 0, 0, 0];
  if ((x - 0.7) ** 2 + (y - 0.7) ** 2 <= 0.12 ** 2) return [239, 68, 68, 255];
  const bars = [
    [0.22, 0.26, 0.78],
    [0.22, 0.42, 0.7],
    [0.22, 0.58, 0.5],
  ];
  for (const [bx, by, ex] of bars) {
    if (inRoundRect(x, y, bx, by, ex, by + 0.07, 0.035)) return [250, 250, 249, 255];
  }
  return [24, 24, 27, 255];
};

for (const s of [16, 32, 48, 128, 192, 512]) {
  writeFileSync(join(out, `icon-${s}.png`), png(s, icon));
}
console.log("icons written to public/icons");

const res = join(root, "android/app/src/main/res");
if (existsSync(res)) {
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [d, s] of Object.entries(densities)) {
    const dir = join(res, `mipmap-${d}`);
    mkdirSync(dir, { recursive: true });
    for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) writeFileSync(join(dir, name), png(s, icon));
    rmSync(join(dir, "ic_launcher_foreground.png"), { force: true });
  }
  rmSync(join(res, "mipmap-anydpi-v26"), { recursive: true, force: true });
  console.log("android launcher icons updated");
}
