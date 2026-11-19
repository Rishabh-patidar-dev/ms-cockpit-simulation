/**
 * A very small PDF writer: text and rules on A4 pages, in Helvetica. Enough to print a one-
 * or two-page business document without a dependency. Text is written in WinAnsi, so
 * anything outside Latin-1 is printed as "?" rather than corrupting the file.
 */
export const PAGE = { width: 595, height: 842 } as const;

const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\xFF]/g, '?');
const esc = (s: string) => clean(s).replace(/([\\()])/g, '\\$1');

/** Close enough to Helvetica's metrics to right-align a column of figures. */
export function textWidth(s: string, size: number, bold = false): number {
  let em = 0;
  for (const ch of clean(s)) {
    if (/[0-9]/.test(ch)) em += 0.556;
    else if (/[ .,:;'|!iIjlt]/.test(ch)) em += 0.28;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else if (/[mwMW]/.test(ch)) em += 0.8;
    else em += 0.52;
  }
  return em * size * (bold ? 1.06 : 1);
}

export interface TextOptions {
  size?: number;
  bold?: boolean;
  /** `right` puts the end of the text at `x`; `center` puts the middle of it there. */
  align?: 'left' | 'right' | 'center';
}

/** "#rrggbb" as the three 0-1 numbers a PDF colour operator takes. */
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

export class TextPdf {
  private pages: string[][] = [[]];

  newPage(): void {
    this.pages.push([]);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** `top` is measured down from the top edge of the page, in points. */
  text(s: string, x: number, top: number, { size = 10, bold = false, align = 'left' }: TextOptions = {}): void {
    const w = textWidth(s, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.pages[this.pages.length - 1]!.push(
      `0 0 0 rg BT /${bold ? 'F2' : 'F1'} ${size} Tf ${left.toFixed(1)} ${(PAGE.height - top).toFixed(1)} Td (${esc(s)}) Tj ET`,
    );
  }

  rule(top: number, { x1 = 56, x2 = 539, width = 0.5 } = {}): void {
    const y = (PAGE.height - top).toFixed(1);
    this.pages[this.pages.length - 1]!.push(`${width} w ${x1} ${y} m ${x2} ${y} l S`);
  }

  /** A straight line between two points, `top` measured down from the top edge. */
  line(x1: number, top1: number, x2: number, top2: number, { width = 0.5, color = '#555555' } = {}): void {
    this.pages[this.pages.length - 1]!.push(
      `${rgb(color)} RG ${width} w ${x1} ${(PAGE.height - top1).toFixed(1)} m ${x2} ${(PAGE.height - top2).toFixed(1)} l S`,
    );
  }

  /** A box, filled and/or outlined. `top` is its top edge, measured down from the top of the page. */
  box(x: number, top: number, w: number, h: number, { fill, stroke = '#555555', width = 0.8 }: { fill?: string; stroke?: string | null; width?: number } = {}): void {
    const y = (PAGE.height - top - h).toFixed(1);
    const ops = this.pages[this.pages.length - 1]!;
    if (fill) ops.push(`${rgb(fill)} rg ${x} ${y} ${w} ${h} re f`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${width} w ${x} ${y} ${w} ${h} re S`);
  }

  build(): Buffer {
    // 1 catalog, 2 pages, 3 and 4 the fonts, then a page and its content for each page.
    const pageObj = (i: number) => 5 + i * 2;
    const objs: string[] = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${this.pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${this.pages.length} >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    ];
    this.pages.forEach((ops, i) => {
      const stream = ops.join('\n');
      objs.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Contents ${pageObj(i) + 1} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
      );
    });

    // Offsets are in bytes of the latin1 file, which is why everything is measured that way.
    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
    const offsets: number[] = [];
    let size = chunks[0]!.length;
    objs.forEach((o, i) => {
      offsets.push(size);
      const b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      chunks.push(b);
      size += b.length;
    });
    const xref =
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}
