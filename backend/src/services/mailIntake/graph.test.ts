import { describe, expect, it, vi } from 'vitest';
import { GraphClient, GraphError } from './graph.js';

// The Graph client against a scripted fetch: sign-in, token reuse, throttling, and errors that say what to fix.

const cfg = { tenantId: 't', clientId: 'c', clientSecret: 's', mailbox: 'hello@innovunglobal.com' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const token = () => json(200, { access_token: 'tok', expires_in: 3600 });

function scripted(...replies: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected call to ${String(url)}`);
    return next;
  });
  return { http: http as unknown as typeof fetch, calls };
}

describe('GraphClient', () => {
  it('signs in once and reuses the token', async () => {
    const { http, calls } = scripted(token(), json(200, { value: [] }), json(200, { value: [] }));
    const g = new GraphClient(cfg, http, async () => {});
    await g.listMessages('f1');
    await g.listMessages('f1');
    expect(calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(1);
    expect(calls[0]?.init?.body).toContain('grant_type=client_credentials');
    expect(calls[1]?.url).toContain('/users/hello%40innovunglobal.com/mailFolders/f1/messages');
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('waits and retries when Graph throttles', async () => {
    const wait = vi.fn(async () => {});
    const { http } = scripted(token(), json(429, {}, { 'retry-after': '2' }), json(200, { value: [{ id: 'm1' }] }));
    const g = new GraphClient(cfg, http, wait);
    expect(await g.listMessages('f1')).toEqual([{ id: 'm1' }]);
    expect(wait).toHaveBeenCalledWith(2000);
  });

  it('signs in again once when the token is refused', async () => {
    const { http, calls } = scripted(token(), json(401, {}), token(), json(200, { value: [] }));
    await new GraphClient(cfg, http, async () => {}).listMessages('f1');
    expect(calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });

  it('names the settings to check when sign-in fails', async () => {
    const { http } = scripted(json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
    const err = await new GraphClient(cfg, http).listMessages('f1').catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.message).toContain('AADSTS7000215');
    expect(err.message).toContain('MS_CLIENT_SECRET');
  });

  it('explains a refused mailbox as a permission or access-policy problem', async () => {
    const { http } = scripted(token(), json(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }));
    const err = await new GraphClient(cfg, http).listMessages('f1').catch((e) => e);
    expect(err.message).toContain('Mail.ReadWrite');
    expect(err.message).toContain('access policy');
  });

  it('keeps only file attachments, and downloads their bytes', async () => {
    const { http, calls } = scripted(
      token(),
      json(200, {
        value: [
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'po.pdf', size: 10 },
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'a2', name: 'Fwd: PO', size: 10 },
        ],
      }),
      new Response('%PDF-1.4', { status: 200 }),
    );
    const g = new GraphClient(cfg, http);
    const files = await g.listFileAttachments('m1');
    expect(files.map((f) => f.name)).toEqual(['po.pdf']);
    expect((await g.downloadAttachment('m1', 'a1')).toString()).toBe('%PDF-1.4');
    expect(calls[2]?.url).toMatch(/\/messages\/m1\/attachments\/a1\/\$value$/);
  });

  it('finds a folder under the Inbox when it is not at the top level', async () => {
    const { http, calls } = scripted(token(), json(200, { value: [] }), json(200, { value: [{ id: 'f9', displayName: 'BCC-POC' }] }));
    expect(await new GraphClient(cfg, http).findFolderId('BCC-POC')).toBe('f9');
    expect(calls[2]?.url).toContain('/mailFolders/inbox/childFolders');
  });

  it('moves a mail by folder id', async () => {
    const { http, calls } = scripted(token(), json(201, { id: 'new' }));
    await new GraphClient(cfg, http).moveMessage('m1', 'f2');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ destinationId: 'f2' });
  });
});
