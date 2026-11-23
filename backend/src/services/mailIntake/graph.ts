import { childLogger } from '../../lib/logger.js';

const log = childLogger('mail-intake');

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
  /**
   * Delegated sign-in ("Connect Outlook"): the mailbox is read as the person who signed in, through
   * /me. Without it the app signs in as itself (client credentials) and reads /users/{mailbox}.
   */
  tokens?: TokenProvider;
}

/** Hands out access tokens for a signed-in user. `fresh` asks for a new one, the old one was refused. */
export interface TokenProvider {
  accessToken(fresh?: boolean): Promise<string>;
}

/** A failure talking to Microsoft, already worded for the person who has to fix it. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_TRIES = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The few Microsoft Graph calls the intake needs, with app-only (client-credentials) sign-in.
 * Plain fetch, no SDK: four endpoints do not justify two dependencies.
 *
 * The app reads one mailbox with the application permission Mail.ReadWrite. An Exchange
 * application access policy should restrict it to that mailbox; without one the same
 * credentials could read every mailbox in the tenant.
 */
export class GraphClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: GraphConfig,
    private readonly http: Fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private get mailboxPath() {
    return this.cfg.tokens ? '/me' : `/users/${encodeURIComponent(this.cfg.mailbox)}`;
  }

  private async accessToken(fresh = false): Promise<string> {
    if (this.cfg.tokens) return this.cfg.tokens.accessToken(fresh);
    // Renewed a minute early so a token never expires between being read and being used.
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const res = await this.http(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const detail = (body.error_description ?? body.error ?? `HTTP ${res.status}`).split('\r\n')[0];
      throw new GraphError(
        `Microsoft sign-in failed for the mail intake app: ${detail} Check MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET (a client secret expires; make a new one in Entra if it has).`,
        res.status,
        body.error ?? 'SIGN_IN_FAILED',
      );
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** One Graph request: retries throttling and outages, signs in again once if the token is refused. */
  private async request(path: string, init: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<Response> {
    let reauthed = false;
    let fresh = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken(fresh);
      fresh = false;
      const res = await this.http(`${GRAPH}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (res.ok) return res;

      if (res.status === 401 && !reauthed) {
        reauthed = true;
        this.token = null;
        fresh = true;
        continue;
      }
      if (RETRYABLE.has(res.status) && attempt < MAX_TRIES) {
        const after = Number(res.headers.get('retry-after'));
        const ms = Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt;
        log.warn({ status: res.status, path, waitMs: ms }, 'Graph asked us to wait; retrying');
        await this.wait(ms);
        continue;
      }

      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      const code = body.error?.code ?? `HTTP_${res.status}`;
      const said = body.error?.message ?? res.statusText;
      throw new GraphError(explain(res.status, code, said, this.cfg.mailbox, !!this.cfg.tokens), res.status, code);
    }
  }

  private async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }

  /**
   * A folder's id from its display name. Looked for at the top of the mailbox and under the
   * Inbox, which is where people make folders in Outlook. Matching ignores case.
   */
  async findFolderId(displayName: string): Promise<string | null> {
    const q = `?$filter=${encodeURIComponent(`displayName eq '${displayName.replace(/'/g, "''")}'`)}&$select=id,displayName&$top=5`;
    for (const parent of ['/mailFolders', '/mailFolders/inbox/childFolders']) {
      const { value } = await this.json<{ value: { id: string; displayName: string }[] }>(`${this.mailboxPath}${parent}${q}`);
      const hit = value.find((f) => f.displayName.toLowerCase() === displayName.toLowerCase()) ?? value[0];
      if (hit) return hit.id;
    }
    return null;
  }

  /** The oldest mails in a folder first, so they are handled in the order customers sent them. */
  async listMessages(folderId: string, top = 25): Promise<GraphMessage[]> {
    const select = 'id,internetMessageId,subject,from,receivedDateTime,hasAttachments';
    const { value } = await this.json<{ value: GraphMessage[] }>(
      `${this.mailboxPath}/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${top}&$orderby=receivedDateTime%20asc&$select=${select}`,
    );
    return value;
  }

  /** The files attached to a mail. Attached emails and calendar items are not files and are left out. */
  async listFileAttachments(messageId: string): Promise<GraphAttachmentInfo[]> {
    const { value } = await this.json<{ value: (GraphAttachmentInfo & { '@odata.type'?: string })[] }>(
      `${this.mailboxPath}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    return value.filter((a) => a['@odata.type'] === undefined || a['@odata.type'] === '#microsoft.graph.fileAttachment');
  }

  /** The raw bytes of one attachment. */
  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const res = await this.request(
      `${this.mailboxPath}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    );
    return Buffer.from(await res.arrayBuffer());
  }

  async moveMessage(messageId: string, destinationFolderId: string): Promise<void> {
    await this.request(`${this.mailboxPath}/messages/${encodeURIComponent(messageId)}/move`, {
      method: 'POST',
      body: { destinationId: destinationFolderId },
    });
  }
}

export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime: string;
  hasAttachments?: boolean;
  from?: { emailAddress?: { address?: string; name?: string } };
}

export interface GraphAttachmentInfo {
  id: string;
  name: string;
  contentType?: string;
  size: number;
  isInline?: boolean;
}

/** Graph's errors name the symptom; this names the likely cause and where to fix it. */
function explain(status: number, code: string, said: string, mailbox: string, delegated: boolean): string {
  if (delegated && (status === 403 || code === 'ErrorAccessDenied')) {
    return `Microsoft refused access to the mailbox (${code}: ${said}). Check that the app has the delegated Graph permission Mail.ReadWrite, then click "Connect Outlook" again.`;
  }
  if (status === 403 || code === 'ErrorAccessDenied' || code === 'Authorization_RequestDenied') {
    return `Microsoft refused access to the mailbox ${mailbox} (${code}: ${said}). Check that the app has the Graph application permission Mail.ReadWrite with admin consent granted, and that the Exchange application access policy includes this mailbox.`;
  }
  if (status === 404 && (code === 'ErrorInvalidUser' || code === 'MailboxNotEnabledForRESTAPI' || code === 'ResourceNotFound')) {
    return `The mailbox ${mailbox} was not found in this tenant (${code}: ${said}). Check MAIL_MAILBOX, and that it is an Exchange Online mailbox.`;
  }
  return `Microsoft Graph answered ${status} ${code}: ${said}`;
}
