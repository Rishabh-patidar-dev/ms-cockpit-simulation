export type POStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'EXTRACTION_FAILED'
  | 'APPROVED'
  | 'SENT_TO_SAP'
  | 'SO_CREATED'
  | 'FAILED'
  | 'CANCELLED';

export type Role = 'UPLOADER' | 'APPROVER' | 'OPERATIONS' | 'ADMIN';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface LineItem {
  id: string;
  lineNumber: number;
  materialCode: string | null;
  customerMaterialNumber: string | null;
  description: string | null;
  quantity: string | null;
  uom: string | null;
  unitPrice: string | null;
  lineNetValue: string | null;
  deliveryDate: string | null;
  plant: string | null;
}

export interface POHeader {
  id: string;
  poNumber: string | null;
  poDate: string | null;
  customerName: string | null;
  customerCode: string | null;
  shipTo: string | null;
  billTo: string | null;
  requestedDeliveryDate: string | null;
  currency: string | null;
  paymentTerms: string | null;
  incoterms: string | null;
  poTotalValue: string | null;
  contact: string | null;
  lineItems: LineItem[];
}

export interface PORecord {
  id: string;
  correlationId: string;
  status: POStatus;
  currentAttempt: number;
  vendorHint: string | null;
  notes: string | null;
  soNumber: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  statusChangedAt: string;
  sentToSapAt: string | null;
  createdAt: string;
  uploadedBy: { id: string; name: string; email: string };
  vendorProfile: { id: string; name: string; version: number } | null;
  /** How the record arrived: someone's upload, or an email to the intake mailbox. */
  source?: RecordSource;
  intakeEmail?: { fromAddress: string; fromName: string | null; subject: string | null; receivedAt: string } | null;
  sourceDocument: {
    originalFilename: string;
    /** application/pdf, or a spreadsheet type (see lib/fileKinds). */
    mimeType?: string;
    byteSize: number;
    contentHash: string;
    pageCount: number | null;
  } | null;
  header: POHeader | null;
}

export interface FieldProvenance {
  fieldPath: string;
  extractedValue: string | null;
  confidence: number | null;
  lowConfidence: boolean;
  editedBy: { id: string; name: string } | null;
  editedAt: string | null;
}

export interface ValidationIssue {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  fieldPath: string;
  message: string;
  acknowledged: boolean;
}

export interface Submission {
  id: string;
  attempt: number;
  approvedAt: string;
  approvedBy: { id: string; name: string };
  outboundFilename: string | null;
  writtenAt: string | null;
  writeError: string | null;
  checksum: string | null;
  byteSize: number | null;
}

export interface SapResultRow {
  id: string;
  attempt: number | null;
  outcome: 'SUCCESS' | 'ERROR';
  soNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sourceFilename: string;
  ingestedAt: string;
  rawContent: string;
}

export interface AuditRow {
  id: string;
  eventType: string;
  message: string | null;
  timestamp: string;
  actorName: string | null;
  actor: { id: string; name: string } | null;
}

/** One call to ZEE_API_LOG, as the backend recorded it. */
export interface SapLogCall {
  id?: string;
  timestamp?: string;
  calledBy?: string | null;
  api: string;
  mode: 'mock' | 'live';
  format: 'json' | 'soap';
  endpoint: string | null;
  vbelns: string[];
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  requestBody: string;
  response: unknown;
  error: string | null;
}

export interface SapLogState {
  api: string;
  mode: 'off' | 'mock' | 'live';
  format: 'json' | 'soap';
  soNumber: string | null;
  vbeln: string | null;
  vbelnError: string | null;
  calls: SapLogCall[];
}

export interface MappedFailure {
  code: string;
  explanation: string;
  remedy: string;
  fieldHint?: string;
}

/** FR-7.2 — the read, summarised. Confidence is the model's own certainty; `corrected` is what humans actually changed. */
export interface ExtractionQuality {
  fieldsTotal: number;
  fieldsRead: number;
  avgConfidence: number;
  minConfidence: number;
  belowThreshold: number;
  corrected: number;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  attempts: number | null;
}

export interface RecordDetail {
  record: PORecord;
  extractionQuality: ExtractionQuality | null;
  fields: FieldProvenance[];
  validation: {
    threshold: number;
    issues: ValidationIssue[];
    blockingCount: number;
  };
  submissions: Submission[];
  results: SapResultRow[];
  audit: AuditRow[];
  failure: MappedFailure | null;
  duplicates: { recordId: string; correlationId: string; status: POStatus; matchedOn: string }[];
  /** Other live records holding the identical PDF (FR-3.4). */
  documentDuplicates?: {
    recordId: string;
    correlationId: string;
    status: POStatus;
    originalFilename: string;
    poNumber: string | null;
  }[];
  /** FR-7.12 — set while the record is back in review because an approver sent it back. */
  sentBack?: { reason: string; by: string; at: string } | null;
  /** Sales Orders SAP reports creating that this record is not linked to (a late or superseded answer). */
  unlinkedOrders?: { soNumber: string; attempt: number | null; ingestedAt: string; sapTimestamp: string | null }[];
  /** Set once SAP has created the order: the value its Sales Order document shows. */
  salesOrder?: { value: string; currency: string; priceNote: string } | null;
  allowedTransitions: POStatus[];
  statusLabel: string;
  /** The link to share with SAP for this order (the key is never included). */
  sapLink?: SapLink;
}

export interface SapLink {
  ready: boolean;
  reason: string | null;
  orderCsvUrl: string;
  /** Opens the CSV by tapping: no login, this order only. */
  downloadUrl: string | null;
  ordersUrl: string;
  user: string;
  apiEnabled: boolean;
  simulatorRunning: boolean;
}

export type NotificationKind =
  | 'REVIEW_NEEDED'
  | 'SENT_BACK'
  | 'RECORD_FAILED'
  | 'EXTRACTION_FAILED'
  | 'SO_CREATED'
  | 'INTEGRATION_ALERT'
  | 'EMAIL_PO_RECEIVED';

export type RecordSource = 'UPLOAD' | 'EMAIL';

/** What the Outlook email intake last did. */
export interface MailIntakeStatus {
  enabled: boolean;
  /** delegated: read as the person who clicked "Connect Outlook"; app: the app's own permission. */
  authMode: 'delegated' | 'app';
  connection: { account: string; connectedAt: string } | null;
  mailbox: string;
  folder: string;
  allowedSenders: string[];
  pollSeconds: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResults: { internetMessageId: string; from: string; subject: string; outcome: string; records: string[]; detail: string | null }[];
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  recordId: string | null;
  createdAt: string;
  /** Arrived since the user last pressed "Mark all read". */
  unread: boolean;
}

export interface Inbox {
  unread: number;
  items: NotificationItem[];
}

export interface NotificationPreference {
  kind: NotificationKind;
  label: string;
  description: string;
  inApp: boolean;
  email: boolean;
}

export interface ChannelStats {
  sent: number;
  pending: number;
  failed: number;
  lastError: string | null;
}

export interface ChannelStatus {
  email: { configured: boolean; redirected: boolean };
  teams: { configured: boolean; kinds: string[] };
  /** Only for Operations and Administrators. */
  recent: { email: ChannelStats; teams: ChannelStats } | null;
}

/** GET /api/dashboard — see backend/src/domain/dashboard.ts for what each figure means. */
export interface DashboardData {
  generatedAt: string;
  /** 0 means all time. */
  periodDays: number;
  uploaded: number;
  read: number;
  approved: number;
  soCreated: number;
  straightThrough: { count: number; of: number; rate: number | null };
  minutesSaved: {
    total: number;
    perPo: number | null;
    assumptions: {
      manualMinutesPerPo: number;
      manualMinutesPerLine: number;
      reviewMinutesPerPo: number;
      reviewMinutesPerLine: number;
      minutesPerCorrection: number;
    };
  };
  caught: {
    recordsIntercepted: number;
    sentBack: number;
    recordsSentBack: number;
    corrections: number;
    recordsCorrected: number;
    warningsAccepted: number;
  };
  sapRejections: { total: number; recordsRejected: number; recovered: number; byCode: { code: string; count: number }[] };
  quality: { fieldsRead: number; fieldsCorrected: number; accuracy: number | null; avgConfidence: number | null };
  turnaround: { medianMinutes: number | null; of: number };
  daily: { date: string; uploaded: number; soCreated: number }[];
  pipeline: Record<string, number>;
}

/** Why a record is not in the batch (POST /records/readiness, /records/bulk-approve). */
export interface Hold {
  code: string;
  message: string;
}

export interface Readiness {
  clean: boolean;
  holds: Hold[];
}

export type BulkOutcome =
  | { id: string; result: 'approved' }
  | { id: string; result: 'held'; holds: Hold[] }
  | { id: string; result: 'failed'; code: string; message: string };

export interface WorklistRow {
  id: string;
  correlationId: string;
  status: POStatus;
  currentAttempt: number;
  soNumber: string | null;
  failureCode: string | null;
  statusChangedAt: string;
  createdAt: string;
  uploadedBy: { id: string; name: string };
  source?: RecordSource;
  intakeEmail?: { fromAddress: string } | null;
  sourceDocument: { originalFilename: string; pageCount: number | null } | null;
  /** What the Sales Order is worth, once SAP has created it. */
  salesOrder?: { value: string; currency: string } | null;
  header: {
    poNumber: string | null;
    customerName: string | null;
    customerCode: string | null;
    poTotalValue: string | null;
    currency: string | null;
    _count: { lineItems: number };
  } | null;
}

/** A spreadsheet PO as the server read it (GET /records/:id/document/sheets). */
export interface WorkbookData {
  sheets: {
    name: string;
    hidden: boolean;
    /** rows[r][c] is the cell at row r+1, column c+1. */
    rows: string[][];
    hiddenRows: number[];
    hiddenColumns: number[];
    merges: string[];
    truncated: boolean;
  }[];
}

/** One order waiting for SAP and the link to share for it. */
export interface WaitingOrderLink {
  recordId: string;
  correlationId: string;
  poNumber: string | null;
  customerName: string | null;
  lines: number;
  sentToSapAt: string | null;
  /** Past the SAP answer wait; the link still works until SAP answers. */
  overdue: boolean;
  downloadUrl: string | null;
  orderCsvUrl: string;
}

export interface SapLinksResponse {
  apiEnabled: boolean;
  simulatorRunning: boolean;
  links: WaitingOrderLink[];
}
