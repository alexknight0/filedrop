// Builds a .zip of a folder in the browser, so folders can be uploaded as one file.
// No library: entries are deflated with the built-in CompressionStream("deflate-raw") (stored
// as-is if that doesn't make them smaller) and wrapped in the standard zip headers. File names
// are UTF-8 (flag bit 11). No ZIP64, which is fine because uploads are capped at 1 GiB.
// Same layout as mac/filedrop-upload.py's zip_folder(): the folder is the top level, Finder's
// .DS_Store files are left out, empty folders are kept.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Zip header: little-endian fields of the given byte widths, then the name.
function header(fields, name) {
  const size = fields.reduce((s, [w]) => s + w, 0);
  const out = new Uint8Array(size + name.length);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [width, value] of fields) {
    if (width === 4) view.setUint32(at, value, true);
    else view.setUint16(at, value, true);
    at += width;
  }
  out.set(name, size);
  return out;
}

// entries: [{path: "Folder/sub/a.txt", file: File}] or {path: "Folder/empty/", file: null}
// for an empty folder. onProgress(doneCount, total) is called after each entry.
export async function zipFolder(name, entries, onProgress = () => {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const kept = entries.filter((e) => !e.path.split("/").includes(".DS_Store"));
  for (const [i, entry] of kept.entries()) {
    const nameBytes = enc.encode(entry.path);
    const raw = entry.file ? new Uint8Array(await entry.file.arrayBuffer()) : new Uint8Array(0);
    const crc = crc32(raw);
    let data = raw;
    let method = 0;
    if (raw.length) {
      const packed = await deflate(raw);
      if (packed.length < raw.length) [data, method] = [packed, 8];
    }
    const { time, date } = dosTime(entry.file?.lastModified ?? Date.now());
    const common = [[2, 20], [2, 0x0800], [2, method], [2, time], [2, date], [4, crc], [4, data.length], [4, raw.length], [2, nameBytes.length], [2, 0]];
    const local = header([[4, 0x04034b50], ...common], nameBytes);
    central.push(header([
      [4, 0x02014b50], [2, 20], ...common, [2, 0], [2, 0], [2, 0], [4, entry.file ? 0 : 0x10], [4, offset],
    ], nameBytes));
    parts.push(new Blob([local, data])); // a Blob per entry lets the browser keep it off the JS heap
    offset += local.length + data.length;
    onProgress(i + 1, kept.length);
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = header([
    [4, 0x06054b50], [2, 0], [2, 0], [2, kept.length], [2, kept.length], [4, centralSize], [4, offset], [2, 0],
  ], new Uint8Array(0));
  return new File([...parts, ...central, end], `${name}.zip`, { type: "application/zip" });
}
