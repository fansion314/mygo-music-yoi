import { readFile, mkdir, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";

// A deterministic platform-neutral ZIP, using stored entries and a fixed time.
const manifest = JSON.parse(await readFile("plugin.json", "utf8"));
const files = [
  "plugin.json",
  "index.js",
  "locales/zh-CN.json",
  "LICENSE",
  "NOTICE.md",
  "CHANGELOG.md",
  "README.md",
  "VALIDATION.md",
];
const parts = [],
  directory = [];
await mkdir("dist/mygo-music-yoi/locales", { recursive: true });
let offset = 0;
for (const path of files) {
  const data = await readFile(path),
    name = Buffer.from(path),
    checksum = crc32(data);
  await writeFile(`dist/mygo-music-yoi/${path}`, data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  parts.push(header, name, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  directory.push(central, name);
  offset += header.length + name.length + data.length;
}
const central = Buffer.concat(directory),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...parts, central, end]);
await mkdir("dist", { recursive: true });
const name = `mygo-music-yoi-${manifest.version}.zip`;
await writeFile(`dist/${name}`, zip);
await writeFile("dist/SHA256SUMS", `${createHash("sha256").update(zip).digest("hex")}  ${name}\n`);
console.log(`Created dist/${name} (${zip.length} bytes)`);
