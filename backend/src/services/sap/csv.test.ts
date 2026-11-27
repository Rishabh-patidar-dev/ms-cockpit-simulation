import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundFormatError, buildOutboundPayload, csvEscape, outboundBaseName, type CsvFormat } from './csv.js';
import type { HeaderWithLines } from '../../domain/validation.js';

const header = (over: Partial<HeaderWithLines> = {}): HeaderWithLines =>
  ({
    id: 'h1',
    recordId: 'r1',
    poNumber: 'PO-1',
    poDate: '2026-09-01',
    customerName: 'Acme, Inc.',
    customerCode: 'C-1',
    shipTo: 'Line one\nLine two',
    billTo: 'He said "hello"',
    requestedDeliveryDate: '2026-10-01',
    currency: 'EUR',
    paymentTerms: 'Net 30',
    incoterms: 'DAP',
    poTotalValue: '50.00',
    contact: null,
    updatedAt: new Date(),
    lineItems: [
      {
        id: 'l2', headerId: 'h1', lineNumber: 2, materialCode: 'MAT-2', customerMaterialNumber: null,
        description: 'Second', quantity: '1', uom: 'EA', unitPrice: '25.00', lineNetValue: '25.00',
        deliveryDate: null, plant: null,
      },
      {
        id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
        description: 'First', quantity: '1', uom: 'EA', unitPrice: '25.00', lineNetValue: '25.00',
        deliveryDate: null, plant: null,
      },
    ],
    ...over,
  }) as HeaderWithLines;

describe('outbound CSV (FR-9, §8.2)', () => {
  it('FR-9.4: escapes delimiters, quotes and newlines inside values', () => {
    expect(csvEscape('Acme, Inc.')).toBe('"Acme, Inc."');
    expect(csvEscape('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvEscape('a\nb')).toBe('a b');
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape(null)).toBe('');
  });

  it('FR-8.3: embeds the correlation ID in the filename', () => {
    expect(outboundBaseName('PO-ABC', 2)).toBe('PO_PO-ABC_2');
  });

  it('IC-06: every row carries the correlation ID so a line can never be orphaned', () => {
    const { files } = buildOutboundPayload('PO-ABC', 1, header());
    for (const file of files) {
      const rows = file.content.split('\n').filter((l) => l.trim());
      for (const row of rows) expect(row).toContain('PO-ABC');
    }
  });

  it('writes one H row and one L row per line item, lines in order', () => {
    const { files } = buildOutboundPayload('PO-ABC', 1, header());
    const rows = files[0]!.content.split('\n').filter((l) => l.trim());
    expect(rows.filter((r) => r.startsWith('H,'))).toHaveLength(1);
    const lines = rows.filter((r) => r.startsWith('L,'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('MAT-1');
    expect(lines[1]).toContain('MAT-2');
  });

  it('a multi-line address never splits a record across physical lines', () => {
    // A legacy line-by-line reader on the SAP side would otherwise see a truncated
    // record followed by a garbage one.
    const { files } = buildOutboundPayload('PO-ABC', 1, header());
    const rows = files[0]!.content.split('\n').filter((l) => l.trim());
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => /^[HL],/.test(r))).toBe(true);
    expect(files[0]!.content).toContain('Line one Line two');
  });
});

describe('outbound formats (FR-5.8, FR-9.4)', () => {
  const iso: CsvFormat = { dateFormat: 'iso', decimalSeparator: '.' };
  // What the model returns for the sample POs: each vendor writes dates and money its own way.
  const vendorStyle = () =>
    header({
      poDate: 'SEP 17, 2026',
      requestedDeliveryDate: '24 September 2026',
      poTotalValue: '1,599.50',
      currency: ' usd ',
      lineItems: [
        {
          id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
          description: 'First', quantity: '750', uom: 'EA', unitPrice: '0,42', lineNetValue: '1.234,50',
          deliveryDate: '18/09/2026', plant: null,
        },
      ],
    });
  const rows = (fmt: CsvFormat) =>
    buildOutboundPayload('PO-ABC', 1, vendorStyle(), fmt).files[0]!.content.split('\n').filter((l) => l.trim());

  it('sends one date form and plain decimals whatever the PO wrote', () => {
    const [h, l] = rows(iso);
    expect(h).toBe('H,PO-ABC,1,PO-1,2026-09-17,C-1,"Acme, Inc.",Line one Line two,"He said ""hello""",USD,2026-09-24,Net 30,DAP,1599.50');
    expect(l).toBe('L,PO-ABC,1,1,MAT-1,,First,750,EA,0.42,1234.50,2026-09-18,');
  });

  it('honours the configured date form', () => {
    expect(rows({ ...iso, dateFormat: 'yyyymmdd' })[0]).toContain(',20260917,');
    expect(rows({ ...iso, dateFormat: 'dd.mm.yyyy' })[0]).toContain(',17.09.2026,');
  });

  it('honours a decimal comma, quoting it so the delimiter stays unambiguous', () => {
    const [h, l] = rows({ ...iso, decimalSeparator: ',' });
    expect(h!.endsWith(',"1599,50"')).toBe(true);
    expect(l).toContain(',"0,42","1234,50",');
  });

  it('leaves blanks blank', () => {
    const { files } = buildOutboundPayload('PO-ABC', 1, header({ requestedDeliveryDate: null, poTotalValue: null }), iso);
    const h = files[0]!.content.split('\n')[0]!;
    expect(h).toContain(',EUR,,Net 30,DAP,');
    expect(h.endsWith(',DAP,')).toBe(true);
  });

  it('refuses to write a date or number it cannot read, rather than passing it through', () => {
    expect(() => buildOutboundPayload('PO-ABC', 1, header({ poDate: '09/18/2026' }), iso)).toThrow(OutboundFormatError);
    expect(() =>
      buildOutboundPayload(
        'PO-ABC', 1,
        header({ lineItems: [{ ...header().lineItems[0]!, quantity: 'lots' }] }),
        iso,
      ),
    ).toThrow(/Line 2 quantity/);
  });
});

describe('the SAP team\'s own layout (CSV_LAYOUT=sap_flat)', () => {
  const SETTINGS = ['CSV_LAYOUT', 'CSV_DATE_FORMAT', 'SAP_FLAT_COMPANY_CODE', 'SAP_FLAT_STORAGE_LOCATION'];
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, { CSV_LAYOUT: 'sap_flat', CSV_DATE_FORMAT: 'dd.mm.yyyy' });
  });
  afterEach(() => {
    for (const k of SETTINGS) delete process.env[k];
  });
  const build = async (h = header()) => (await import('./csv.js')).buildOutboundPayload('PO-ABC', 1, h);

  const NAMES =
    'PO_NUMBER,COMPANY_CODE,DOC_TYPE,CREATED_DATE,CREATED_BY,PO_ITEM,MATERIAL,PLANT,STORAGE_LOCATION,DOC_DATE,DELIVERY_DATE,CURRENCY,QUANTITY,NET_PRICE,NET_VALUE,SHORT_TEXT,ORDER_UNIT,STATUS';

  it('writes their 18 column names in their order as a header row, then one row per item', async () => {
    const { files } = await build();
    expect(files).toHaveLength(1);
    expect(files[0]!.suffix).toBe('.csv');
    expect(files[0]!.content).toBe(
      [
        NAMES,
        'PO-1,1710,NB,01.09.2026,COCKPIT,1,MAT-1,,BB01,01.09.2026,01.10.2026,EUR,1,25,25,First,EA,OPEN',
        'PO-1,1710,NB,01.09.2026,COCKPIT,2,MAT-2,,BB01,01.09.2026,01.10.2026,EUR,1,25,25,Second,EA,OPEN',
        '',
      ].join('\n'),
    );
  });

  it('writes a whole amount as 50000 and keeps a real fraction, as their own file does', async () => {
    const base = header();
    const h = header({
      lineItems: [
        { ...base.lineItems[0]!, lineNumber: 1, quantity: '100', unitPrice: '50,000.00', lineNetValue: '50,000.00' },
        { ...base.lineItems[1]!, lineNumber: 2, quantity: '1200', unitPrice: '0.42', lineNetValue: '504.00' },
        { ...base.lineItems[1]!, lineNumber: 3, quantity: '3', unitPrice: '10.50', lineNetValue: '31.50' },
      ],
    });
    const rows = (await build(h)).files[0]!.content.split('\n');
    expect(rows[1]).toContain(',EUR,100,50000,50000,');
    expect(rows[2]).toContain(',EUR,1200,0.42,504,');
    expect(rows[3]).toContain(',EUR,3,10.50,31.50,');
  });

  it('has the header row whatever CSV_HEADER_ROW says, because the layout is theirs', async () => {
    const { files } = await build();
    expect(files[0]!.content.split('\n')[0]).toBe(NAMES);
  });

  it('uses a line\'s own delivery date when it has one, and the PO\'s requested date when it has not', async () => {
    const base = header();
    const h = header({ lineItems: [{ ...base.lineItems[0]!, deliveryDate: '2026-11-15' }, base.lineItems[1]!] });
    const rows = (await build(h)).files[0]!.content.split('\n');
    // lines are sorted: line 1 is the one without its own date, line 2 the one with
    expect(rows[1]).toContain(',01.10.2026,EUR,');
    expect(rows[2]).toContain(',15.11.2026,EUR,');
  });

  it('fills the columns a customer PO does not carry from settings', async () => {
    Object.assign(process.env, { SAP_FLAT_COMPANY_CODE: '1000', SAP_FLAT_STORAGE_LOCATION: 'WH01' });
    const row = (await build()).files[0]!.content.split('\n')[1]!;
    expect(row.startsWith('PO-1,1000,NB,')).toBe(true);
    expect(row).toContain(',WH01,');
  });

  it('is the same file whichever day it is built, so a second download matches the first', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
      const first = (await build()).files[0]!.content;
      vi.setSystemTime(new Date('2026-12-24T09:00:00Z'));
      expect((await build()).files[0]!.content).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a date or number it cannot read, the same as the other layouts', async () => {
    await expect(build(header({ poDate: 'sometime soon' }))).rejects.toThrow(/not a valid date/);
  });
});

describe('line endings (CSV_LINE_ENDING)', () => {
  const SETTINGS = ['CSV_LINE_ENDING', 'CSV_LAYOUT', 'CSV_DATE_FORMAT', 'SAP_FLAT_CREATED_BY'];
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    for (const k of SETTINGS) delete process.env[k];
  });
  const build = async (settings: Record<string, string>, h = header()) => {
    Object.assign(process.env, settings);
    return (await import('./csv.js')).buildOutboundPayload('PO-ABC', 1, h);
  };

  it('ends every line with LF unless told otherwise', async () => {
    for (const layout of ['single_file', 'header_lines_pair', 'sap_flat']) {
      vi.resetModules();
      const { files } = await build({ CSV_LAYOUT: layout });
      for (const f of files) expect(f.content).not.toContain('\r');
    }
  });

  it.each(['single_file', 'header_lines_pair', 'sap_flat'])(
    'writes CR+LF on every line, and nowhere else, when asked (%s)',
    async (layout) => {
      const { files } = await build({ CSV_LINE_ENDING: 'crlf', CSV_LAYOUT: layout });
      for (const f of files) {
        expect(f.content.endsWith('\r\n')).toBe(true);
        expect(f.content.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      }
    },
  );

  it('writes the SAP team\'s SAP_PO_test2.csv byte for byte from its purchase order', async () => {
    const base = header();
    const po = header({
      poNumber: '6100000019',
      poDate: '25.09.2026',
      requestedDeliveryDate: '30.09.2026',
      currency: 'INR',
      lineItems: [
        {
          ...base.lineItems[0]!, lineNumber: 1, materialCode: 'FG111_A', description: '', quantity: '100', uom: 'LM',
          unitPrice: '50,000.00', lineNetValue: '50,000.00', plant: '1710',
        },
      ],
    });
    const { files } = await build(
      { CSV_LAYOUT: 'sap_flat', CSV_DATE_FORMAT: 'dd.mm.yyyy', SAP_FLAT_CREATED_BY: 'SAP', CSV_LINE_ENDING: 'crlf' },
      po,
    );
    expect(files[0]!.content).toBe(
      'PO_NUMBER,COMPANY_CODE,DOC_TYPE,CREATED_DATE,CREATED_BY,PO_ITEM,MATERIAL,PLANT,STORAGE_LOCATION,DOC_DATE,DELIVERY_DATE,CURRENCY,QUANTITY,NET_PRICE,NET_VALUE,SHORT_TEXT,ORDER_UNIT,STATUS\r\n' +
        '6100000019,1710,NB,25.09.2026,SAP,1,FG111_A,1710,BB01,25.09.2026,30.09.2026,INR,100,50000,50000,,LM,OPEN\r\n',
    );
  });
});

describe('an ambiguous "2,600" in the SAP file', () => {
  it("is written as the line's own arithmetic proves it: 2,600 × 0.18 = 468.00 is 2600, not 2.6", () => {
    const h = header({
      poTotalValue: '468.00',
      lineItems: [{ ...header().lineItems[1]!, quantity: '2,600', unitPrice: '0.18', lineNetValue: '468.00' }],
    });
    const rows = buildOutboundPayload('PO-ABC', 1, h).files[0]!.content.split(/\r?\n/);
    expect(rows.find((r) => r.startsWith('L,'))).toContain(',2600,EA,0.18,468.00,');
  });

  it('keeps the plain reading when the line cannot settle it', () => {
    const h = header({ poTotalValue: null, lineItems: [{ ...header().lineItems[1]!, quantity: '2,600', unitPrice: '0.18', lineNetValue: null }] });
    const rows = buildOutboundPayload('PO-ABC', 1, h).files[0]!.content.split(/\r?\n/);
    expect(rows.find((r) => r.startsWith('L,'))).toContain(',2.600,EA,0.18,,');
  });
});
