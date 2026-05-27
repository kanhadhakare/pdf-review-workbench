const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[index] = value >>> 0;
}

type ZipEntry = {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
};

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function u16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

export function createStoredZip(files: Array<{ name: string; data: Uint8Array }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  const stamp = dosTimestamp();

  for (const file of files) {
    const normalizedName = file.name.replace(/\\/g, "/").replace(/^\/+/, "");
    const nameBytes = Buffer.from(normalizedName, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(stamp.time),
      u16(stamp.date),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    ]);
    localParts.push(localHeader, data);
    entries.push({ name: normalizedName, data, crc, offset });
    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const dataLength = entry.data.byteLength;
    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(stamp.time),
      u16(stamp.date),
      u32(entry.crc),
      u32(dataLength),
      u32(dataLength),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(entry.offset),
      nameBytes
    ]);
    centralParts.push(centralHeader);
    offset += centralHeader.length;
  }

  const centralSize = offset - centralStart;
  const endRecord = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralStart),
    u16(0)
  ]);

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}
