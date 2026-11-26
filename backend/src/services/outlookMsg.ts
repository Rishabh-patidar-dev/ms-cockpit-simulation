/**
 * Reads an Outlook .msg file with no dependency. A .msg is an OLE compound file (the
 * same container as an old .xls): a small FAT file system of "storages" (folders) and
 * "streams" (files). Each MAPI property of the mail is a stream named
 * __substg1.0_<property id><type>, and each attachment is a storage of its own.
 */

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;

export const looksLikeOle = (buffer: Buffer) => buffer.length >= 512 && buffer.subarray(0, 8).equals(SIGNATURE);

interface Entry {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

export interface CompoundFile {
  /** The children of a storage, by name. */
  children(index: number): Map<string, number>;
  read(index: number): Buffer;
  entry(index: number): Entry;
}

export function readCompoundFile(buf: Buffer): CompoundFile {
  if (!looksLikeOle(buf)) throw new Error('Not an OLE compound file.');
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  const firstDirSector = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  let difatSector = buf.readUInt32LE(0x44);

  const sector = (n: number) => {
    const off = (n + 1) * sectorSize;
    if (off >= buf.length) throw new Error('Corrupt compound file (sector out of range).');
    return buf.subarray(off, Math.min(off + sectorSize, buf.length));
  };

  // The FAT's own sectors are listed in the header (109) and then in a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s !== FREE) fatSectors.push(s);
  }
  const perSector = sectorSize / 4;
  for (let guard = 0; difatSector !== END_OF_CHAIN && difatSector !== FREE && guard < 10_000; guard++) {
    const d = sector(difatSector);
    for (let i = 0; i < perSector - 1; i++) {
      const s = d.readUInt32LE(i * 4);
      if (s !== FREE) fatSectors.push(s);
    }
    difatSector = d.readUInt32LE((perSector - 1) * 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    const d = sector(s);
    for (let i = 0; i + 4 <= d.length; i += 4) fat.push(d.readUInt32LE(i));
  }

  const chain = (start: number, table: number[]) => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== END_OF_CHAIN && s !== FREE && s < table.length; s = table[s]!) {
      if (seen.has(s)) throw new Error('Corrupt compound file (sector loop).');
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readBig = (start: number, size?: number) => {
    const data = Buffer.concat(chain(start, fat).map(sector));
    return size === undefined ? data : data.subarray(0, size);
  };

  const dirData = readBig(firstDirSector);
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= dirData.length; off += 128) {
    const nameLen = dirData.readUInt16LE(off + 0x40);
    entries.push({
      name: dirData.subarray(off, off + Math.max(0, nameLen - 2)).toString('utf16le'),
      type: dirData[off + 0x42]!,
      left: dirData.readUInt32LE(off + 0x44),
      right: dirData.readUInt32LE(off + 0x48),
      child: dirData.readUInt32LE(off + 0x4c),
      start: dirData.readUInt32LE(off + 0x74),
      size: dirData.readUInt32LE(off + 0x78),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new Error('Corrupt compound file (no root entry).');

  const miniFat = firstMiniFat === END_OF_CHAIN ? [] : (() => {
    const d = readBig(firstMiniFat);
    const t: number[] = [];
    for (let i = 0; i + 4 <= d.length; i += 4) t.push(d.readUInt32LE(i));
    return t;
  })();
  const miniStream = root.start === END_OF_CHAIN ? Buffer.alloc(0) : readBig(root.start, root.size);

  return {
    entry: (i) => entries[i]!,
    read(i) {
      const e = entries[i]!;
      if (e.size < miniCutoff) {
        return Buffer.concat(
          chain(e.start, miniFat).map((s) => miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize)),
        ).subarray(0, e.size);
      }
      return readBig(e.start, e.size);
    },
    children(i) {
      const out = new Map<string, number>();
      const stack = [entries[i]!.child];
      const seen = new Set<number>();
      while (stack.length) {
        const n = stack.pop()!;
        if (n === FREE || n >= entries.length || seen.has(n)) continue;
        seen.add(n);
        const e = entries[n]!;
        out.set(e.name, n);
        stack.push(e.left, e.right);
      }
      return out;
    },
  };
}

export interface MsgAttachment {
  name: string;
  mimeType: string | null;
  content: Buffer;
}

export interface MsgMail {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  sentAt: Date | null;
  body: string | null;
  attachments: MsgAttachment[];
  /** Attachments that could not be read as files (an attached email, an OLE object). */
  skippedAttachments: string[];
}

/** A property's value from a storage: Unicode string, 8-bit string or binary, whichever is present. */
function props(cf: CompoundFile, storage: number) {
  const kids = cf.children(storage);
  const string = (id: string): string | null => {
    const u = kids.get(`__substg1.0_${id}001F`);
    if (u !== undefined) return cf.read(u).toString('utf16le').replace(/\0+$/, '');
    const a = kids.get(`__substg1.0_${id}001E`);
    if (a !== undefined) return cf.read(a).toString('latin1').replace(/\0+$/, '');
    return null;
  };
  const binary = (id: string): Buffer | null => {
    const b = kids.get(`__substg1.0_${id}0102`);
    return b === undefined ? null : cf.read(b);
  };
  return { kids, string, binary };
}

/** A FILETIME (100 ns ticks since 1601) from the fixed-size property stream. */
function sentTime(cf: CompoundFile, root: number): Date | null {
  const idx = cf.children(root).get('__properties_version1.0');
  if (idx === undefined) return null;
  const data = cf.read(idx);
  // The top-level message's property stream has a 32-byte header, then 16-byte entries.
  for (let off = 32; off + 16 <= data.length; off += 16) {
    const type = data.readUInt16LE(off);
    const id = data.readUInt16LE(off + 2);
    if (type === 0x0040 && (id === 0x0039 || id === 0x0e06)) {
      const ticks = data.readBigUInt64LE(off + 8);
      if (ticks === 0n) continue;
      return new Date(Number(ticks / 10_000n - 11_644_473_600_000n));
    }
  }
  return null;
}

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

export function readMsg(buffer: Buffer): MsgMail {
  const cf = readCompoundFile(buffer);
  const root = props(cf, 0);
  if (![...root.kids.keys()].some((k) => k.startsWith('__substg1.0_'))) {
    throw new Error('This compound file is not an Outlook message (it may be an old .xls or .doc).');
  }

  let body = root.string('1000');
  if (!body) {
    const html = root.binary('1013');
    const htmlText = html ? html.toString('utf8') : root.string('1013');
    if (htmlText) body = htmlToText(htmlText);
  }

  const fromName = root.string('0C1A');
  const fromAddr = root.string('5D01') ?? root.string('0C1F') ?? root.string('0065');
  const from = fromName && fromAddr && fromAddr.includes('@') ? `${fromName} <${fromAddr}>` : fromName ?? fromAddr;

  const attachments: MsgAttachment[] = [];
  const skippedAttachments: string[] = [];
  for (const [name, index] of root.kids) {
    if (!name.startsWith('__attach_version1.0_')) continue;
    const a = props(cf, index);
    const filename = a.string('3707') ?? a.string('3704') ?? a.string('3001') ?? 'attachment';
    const content = a.binary('3701');
    if (!content) {
      skippedAttachments.push(filename);
      continue;
    }
    attachments.push({ name: filename, mimeType: a.string('370E'), content });
  }

  return {
    subject: root.string('0037'),
    from,
    to: root.string('0E04'),
    cc: root.string('0E03'),
    sentAt: sentTime(cf, 0),
    body: body?.trim() || null,
    attachments,
    skippedAttachments,
  };
}
