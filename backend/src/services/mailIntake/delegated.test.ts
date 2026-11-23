import { beforeEach, describe, expect, it, vi } from 'vitest';

// "Connect Outlook": the signed state, the sealed refresh token, and swapping it for access tokens,
// against a scripted Microsoft and an in-memory MailConnection row.

let row: { id: string; account: string; refreshToken: string; connectedById: string | null; connectedAt: Date } | null = null;

vi.mock('../../db/client.js', () => ({
  prisma: {
    mailConnection: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ create, update }: { create: typeof row; update: Partial<NonNullable<typeof row>> }) => {
        row = row ? { ...row, ...update } : { ...create!, connectedAt: new Date() };
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Partial<NonNullable<typeof row>> }) => (row = { ...row!, ...data })),
      deleteMany: vi.fn(async () => {
        row = null;
        return { count: 1 };
      }),
    },
  },
}));

const { env } = await import('../../config/env.js');
const d = await import('./delegated.js');
const { GraphClient } = await import('./graph.js');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

beforeEach(() => {
  row = null;
  Object.assign(env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_MAILBOX: 'Rishabh.P@innovunglobal.com', MAIL_OAUTH_REDIRECT_URI: '' });
});

describe('sealed refresh token', () => {
  it('round-trips, and a tampered value is refused', () => {
    const sealed = d.seal('refresh-123');
    expect(sealed).not.toContain('refresh-123');
    expect(d.unseal(sealed)).toBe('refresh-123');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => d.unseal(parts.join('.'))).toThrow();
  });
});

describe('sign-in state', () => {
  it('comes back as it was signed', () => {
    const s = d.signState({ uid: 'u1', redirectUri: 'https://x/cb' });
    expect(d.readState(s)).toMatchObject({ uid: 'u1', redirectUri: 'https://x/cb' });
  });
  it('is refused when altered or expired', () => {
    const s = d.signState({ uid: 'u1', redirectUri: 'https://x/cb' });
    const [, sig] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'admin', redirectUri: 'https://x/cb', exp: Date.now() + 1e6, n: 'x' })).toString('base64url');
    expect(d.readState(`${forged}.${sig}`)).toBeNull();
    expect(d.readState(d.signState({ uid: 'u1', redirectUri: 'https://x/cb' }, -1))).toBeNull();
    expect(d.readState('garbage')).toBeNull();
  });
});

describe('authorizeUrl', () => {
  it('asks for mail access that lasts, and returns to the callback on the browser origin', () => {
    const url = new URL(d.authorizeUrl('u1', d.redirectUriFor('https://bcc.example/')));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/t/oauth2/v2.0/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://bcc.example/api/mail-intake/oauth/callback');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('scope')).toContain('Mail.ReadWrite');
    expect(url.searchParams.get('login_hint')).toBe('Rishabh.P@innovunglobal.com');
    expect(d.readState(url.searchParams.get('state')!)?.uid).toBe('u1');
  });
  it('uses the configured return address when there is one', () => {
    env.MAIL_OAUTH_REDIRECT_URI = 'https://fixed.example/cb';
    expect(d.redirectUriFor('https://anything.example')).toBe('https://fixed.example/cb');
  });
});

describe('completeSignIn', () => {
  const tokens = () => json(200, { access_token: 'at', refresh_token: 'rt1', expires_in: 3600 });

  it('saves the sign-in of the intake mailbox, sealed', async () => {
    const { http, calls } = scripted(tokens(), json(200, { mail: 'rishabh.p@innovunglobal.com', userPrincipalName: 'rishabh.p@innovunglobal.com' }));
    expect(await d.completeSignIn('code', 'https://bcc.example/cb', 'u1', http)).toEqual({ account: 'rishabh.p@innovunglobal.com' });
    expect(calls[0]?.init?.body).toContain('grant_type=authorization_code');
    expect(calls[0]?.init?.body).toContain('redirect_uri=https%3A%2F%2Fbcc.example%2Fcb');
    expect(row?.account).toBe('rishabh.p@innovunglobal.com');
    expect(d.unseal(row!.refreshToken)).toBe('rt1');
  });

  it('refuses a different Microsoft account than the intake mailbox', async () => {
    const { http } = scripted(tokens(), json(200, { mail: 'someone.else@innovunglobal.com' }));
    await expect(d.completeSignIn('code', 'https://bcc.example/cb', 'u1', http)).rejects.toThrow(/signed in to Microsoft as someone.else/);
    expect(row).toBeNull();
  });

  it('says what is missing when no refresh token comes back', async () => {
    const { http } = scripted(json(200, { access_token: 'at' }));
    await expect(d.completeSignIn('code', 'https://bcc.example/cb', 'u1', http)).rejects.toThrow(/offline_access/);
  });
});

describe('StoredTokens', () => {
  const connect = (rt: string) => {
    row = { id: 'default', account: 'rishabh.p@innovunglobal.com', refreshToken: d.seal(rt), connectedById: 'u1', connectedAt: new Date() };
  };

  it('says nobody has connected yet', async () => {
    await expect(new d.StoredTokens(scripted().http).accessToken()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('swaps the refresh token, keeps a new one, and reuses the access token', async () => {
    connect('rt1');
    const { http, calls } = scripted(json(200, { access_token: 'at1', refresh_token: 'rt2', expires_in: 3600 }));
    const t = new d.StoredTokens(http);
    expect(await t.accessToken()).toBe('at1');
    expect(await t.accessToken()).toBe('at1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.body).toContain('refresh_token=rt1');
    expect(d.unseal(row!.refreshToken)).toBe('rt2');
  });

  it('asks for a reconnect when Microsoft withdrew the sign-in', async () => {
    connect('rt1');
    const { http } = scripted(json(400, { error: 'invalid_grant', error_description: 'AADSTS50173: The provided grant has expired.' }));
    await expect(new d.StoredTokens(http).accessToken()).rejects.toMatchObject({ code: 'RECONNECT_NEEDED', message: expect.stringContaining('Connect Outlook') });
  });
});

describe('GraphClient with a signed-in user', () => {
  it('reads /me, and asks for a fresh token once when one is refused', async () => {
    const provider = { accessToken: vi.fn(async (fresh?: boolean) => (fresh ? 'new' : 'old')) };
    const { http, calls } = scripted(json(401, {}), json(200, { value: [] }));
    const g = new GraphClient({ tenantId: 't', clientId: 'c', clientSecret: 's', mailbox: 'x@y.z', tokens: provider }, http, async () => {});
    await g.listMessages('f1');
    expect(calls[0]?.url).toContain('/v1.0/me/mailFolders/f1/messages');
    expect(provider.accessToken.mock.calls.map((c) => c[0])).toEqual([false, true]);
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });
});
