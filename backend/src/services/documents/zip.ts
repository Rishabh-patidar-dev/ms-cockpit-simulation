import { inflateRawSync } from 'node:zlib';

/**
 * Just enough of a zip reader to open an .xlsx (which is a zip of XML files), with no
 * dependency: the central directory is read from the end of the file, and each entry is
 * either stored or deflated. Encrypted, multi-disk and zip64 archives are refused rather
 * than half-read.
 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const EOCD_SIG = 0x06054b50;
  // The end-of-central-directory record sits in the last 22 bytes plus an optional comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end-of-directory record).');

  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('Zip64 archives are not supported.');

  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new Error('Encrypted (password-protected) files are not supported.');
    if (name.endsWith('/')) continue;

    // The local header repeats name and extra field, with lengths that may differ from the directory's.
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    // Other methods never appear in Office files; skip rather than fail the whole workbook.
  }
  return files;
}

export const looksLikeZip = (buffer: Buffer) =>
  buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
