import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

const BLOCK = 512;

function writeOctal(buf: Buffer, off: number, len: number, val: number): void {
  buf.write(val.toString(8).padStart(len - 1, "0") + "\0", off, "ascii");
}

function headerChecksum(hdr: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : hdr[i];
  }
  return sum;
}

function makeHeader(
  name: string,
  size: number,
  type: "0" | "5",
  mtime: number,
): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  let prefix = "";
  let entry = name;
  if (name.length > 99) {
    const cut = name.lastIndexOf("/", 154);
    if (cut > 0) {
      prefix = name.slice(0, cut);
      entry = name.slice(cut + 1);
    }
  }
  buf.write(entry.slice(0, 99), 0, "ascii");
  writeOctal(buf, 100, 8, 0o755);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, mtime);
  buf.fill(0x20, 148, 156);
  buf[156] = type.charCodeAt(0);
  buf.write("ustar ", 257, "ascii");
  buf.write(" ", 263, "ascii");
  if (prefix) buf.write(prefix.slice(0, 154), 345, "ascii");
  const cs = headerChecksum(buf);
  buf.write(cs.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

export async function packDir(dir: string): Promise<Buffer> {
  const parts: Buffer[] = [];

  async function walk(cur: string): Promise<void> {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      const rel = relative(dir, full).replace(/\\/g, "/");
      const { mtimeMs } = await stat(full);
      const mtime = Math.floor(mtimeMs / 1000);
      if (entry.isDirectory()) {
        parts.push(makeHeader(rel + "/", 0, "5", mtime));
        await walk(full);
      } else if (entry.isFile()) {
        const data = await readFile(full);
        parts.push(makeHeader(rel, data.length, "0", mtime));
        parts.push(data);
        const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
        if (pad) parts.push(Buffer.alloc(pad, 0));
      }
    }
  }

  await walk(dir);
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

export async function unpackDir(buf: Buffer, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const hdr = buf.subarray(off, off + BLOCK);
    off += BLOCK;
    if (hdr.every((b) => b === 0)) break;
    const prefix = hdr.subarray(345, 500).toString("ascii").replace(/\0/g, "");
    const name = hdr.subarray(0, 100).toString("ascii").replace(/\0/g, "");
    const full = prefix ? `${prefix}/${name}` : name;
    const type = String.fromCharCode(hdr[156]);
    const size =
      parseInt(hdr.subarray(124, 136).toString("ascii").trim(), 8) || 0;
    const target = join(dest, full);
    if (type === "5" || full.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, buf.subarray(off, off + size));
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
}
