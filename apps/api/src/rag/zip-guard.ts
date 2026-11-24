import { badRequest } from "../lib/errors.js";

export interface ZipLimits {
  /** Maximum total uncompressed size of all entries. */
  maxUncompressedBytes: number;
  /** Maximum uncompressed / compressed ratio for the archive. */
  maxRatio: number;
  maxEntries: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxRatio: 100,
  maxEntries: 2000,
};

/**
 * Guards against zip bombs before handing a DOCX (a zip archive) to a parser
 * that inflates everything in memory. Reads the declared sizes from the zip
 * central directory without decompressing anything.
 */
export function assertSafeZip(bytes: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): void {
  const reject = (why: string) => badRequest(`Rejected archive: ${why}`);
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  const minPos = Math.max(0, bytes.length - 0xffff - 22);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw reject("not a valid zip file");

  const entries = bytes.readUInt16LE(eocd + 10);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw reject("ZIP64 archives are not supported");
  if (entries > limits.maxEntries) throw reject("too many entries");

  let pos = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50) throw reject("corrupt central directory");
    const uncompressed = bytes.readUInt32LE(pos + 24);
    if (uncompressed === 0xffffffff) throw reject("ZIP64 entries are not supported");
    total += uncompressed;
    if (total > limits.maxUncompressedBytes) throw reject("uncompressed content is too large");
    pos += 46 + bytes.readUInt16LE(pos + 28) + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
  }
  if (total / Math.max(1, bytes.length) > limits.maxRatio) throw reject("suspicious compression ratio");
}
