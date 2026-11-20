import { GraphClient, GraphError, type GraphConfig } from './graph.js';

/** One email waiting in the intake folder. */
export interface MailMessage {
  /** The mail server's id for it, used to fetch and move it. */
  id: string;
  /** The RFC 822 Message-ID; stays the same when the mail moves folders. */
  internetMessageId: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  receivedAt: Date;
}

export interface MailAttachment {
  name: string;
  contentType: string;
  size: number;
  /** null when the file is over the size limit and was not downloaded. */
  content: Buffer | null;
}

/** Where a handled mail is filed: its PDFs became records, or a person should look at it. */
export type MailDestination = 'done' | 'attention';

/**
 * Where mail comes from. Graph today; a test fake, or another provider later, plugs in here
 * without touching the intake rules.
 */
export interface MailSource {
  listPending(): Promise<MailMessage[]>;
  /** File attachments with their bytes. Those over `maxBytes` come back with no content, unread. */
  getAttachments(message: MailMessage, maxBytes: number): Promise<MailAttachment[]>;
  moveTo(message: MailMessage, destination: MailDestination): Promise<void>;
}

export interface GraphSourceConfig extends GraphConfig {
  sourceFolder: string;
  doneFolder: string;
  attentionFolder: string;
}

/** The intake folder of one Outlook mailbox, read through Microsoft Graph. */
export class GraphMailSource implements MailSource {
  private folders: { source: string; done: string; attention: string } | null = null;

  constructor(
    private readonly cfg: GraphSourceConfig,
    private readonly graph = new GraphClient(cfg),
  ) {}

  private async folderIds() {
    if (this.folders) return this.folders;
    const [source, done, attention] = await Promise.all(
      [this.cfg.sourceFolder, this.cfg.doneFolder, this.cfg.attentionFolder].map((name) => this.graph.findFolderId(name)),
    );
    const missing = [
      [this.cfg.sourceFolder, source],
      [this.cfg.doneFolder, done],
      [this.cfg.attentionFolder, attention],
    ]
      .filter(([, id]) => !id)
      .map(([name]) => `"${name}"`);
    if (missing.length > 0) {
      throw new GraphError(
        `The mailbox ${this.cfg.mailbox} has no folder named ${missing.join(', ')}. Create ${missing.length === 1 ? 'it' : 'them'} in Outlook (at the top level or under the Inbox), or change MAIL_SOURCE_FOLDER / MAIL_DONE_FOLDER / MAIL_ATTENTION_FOLDER.`,
        404,
        'FOLDER_NOT_FOUND',
      );
    }
    this.folders = { source: source!, done: done!, attention: attention! };
    return this.folders;
  }

  async listPending(): Promise<MailMessage[]> {
    const { source } = await this.folderIds();
    const messages = await this.graph.listMessages(source);
    return messages.map((m) => ({
      id: m.id,
      // A draft or a malformed mail can lack a Message-ID; Graph's own id then stands in.
      internetMessageId: m.internetMessageId || `graph:${m.id}`,
      subject: m.subject ?? '',
      fromAddress: (m.from?.emailAddress?.address ?? '').toLowerCase(),
      fromName: m.from?.emailAddress?.name ?? null,
      receivedAt: new Date(m.receivedDateTime),
    }));
  }

  async getAttachments(message: MailMessage, maxBytes: number): Promise<MailAttachment[]> {
    const infos = await this.graph.listFileAttachments(message.id);
    const out: MailAttachment[] = [];
    for (const a of infos) {
      // The size Graph reports includes some overhead, so allow a little over the limit.
      const tooBig = a.size > maxBytes * 1.05 + 4096;
      out.push({
        name: a.name,
        contentType: a.contentType ?? 'application/octet-stream',
        size: a.size,
        content: tooBig ? null : await this.graph.downloadAttachment(message.id, a.id),
      });
    }
    return out;
  }

  async moveTo(message: MailMessage, destination: MailDestination): Promise<void> {
    const ids = await this.folderIds();
    await this.graph.moveMessage(message.id, destination === 'done' ? ids.done : ids.attention);
  }
}
