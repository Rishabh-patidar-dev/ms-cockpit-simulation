import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { GraphError, type TokenProvider } from './graph.js';

/**
 * "Connect Outlook": the mailbox is read as a person who signed in once, with the delegated Graph
 * permission Mail.ReadWrite, instead of as the app itself. That needs no Global Administrator, which
 * matters where Microsoft 365 is run by a reseller (GoDaddy keeps that role to itself).
 *
 * Microsoft hands back a refresh token; it is kept encrypted in MailConnection and swapped for a
 * short-lived access token whenever the intake runs. Used every minute, it does not expire; if it
 * is withdrawn (password change, revoked sessions) the intake says so and someone connects again.
 */

export const SCOPES = 'offline_access User.Read https://graph.microsoft.com/Mail.ReadWrite';
export const CALLBACK_PATH = '/api/mail-intake/oauth/callback';
export const NOT_CONNECTED =
  'Outlook is not connected yet. An admin signs in to the Business Command Centre and clicks "Connect Outlook".';

type Fetch = typeof fetch;
const ROW = 'default';
const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0`;
const b64url = (b: Buffer) => b.toString('base64url');

// ------------------------------------------------------------------ the refresh token at rest

const key = () => createHash('sha256').update(`mail-intake-token:${env.JWT_SECRET}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', b64url(iv), b64url(c.getAuthTag()), b64url(body)].join('.');
}

export function unseal(sealed: string): string {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('not a sealed value');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}

// ------------------------------------------------------------------ the round trip through Microsoft

interface SignInState {
  /** Who clicked "Connect Outlook". */
  uid: string;
  redirectUri: string;
  exp: number;
  n: string;
}

const mac = (body: string) => b64url(createHmac('sha256', `mail-intake-state:${env.JWT_SECRET}`).update(body).digest());

/** The state parameter: signed, so a sign-in nobody here started is refused, and short-lived. */
export function signState(p: Omit<SignInState, 'exp' | 'n'>, ttlMs = 15 * 60_000): string {
  const body = b64url(Buffer.from(JSON.stringify({ ...p, exp: Date.now() + ttlMs, n: b64url(randomBytes(9)) })));
  return `${body}.${mac(body)}`;
}

export function readState(state: string): SignInState | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignInState;
    return p.exp > Date.now() && p.uid && p.redirectUri ? p : null;
  } catch {
    return null;
  }
}

/** Where Microsoft sends the browser back to. It must be registered in Entra, exactly. */
export function redirectUriFor(origin: string): string {
  return env.MAIL_OAUTH_REDIRECT_URI || `${origin.replace(/\/+$/, '')}${CALLBACK_PATH}`;
}

/** The Microsoft sign-in page to send the browser to. */
export function authorizeUrl(userId: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state: signState({ uid: userId, redirectUri }),
    prompt: 'select_account',
  });
  if (env.MAIL_MAILBOX) q.set('login_hint', env.MAIL_MAILBOX);
  return `${authority()}/authorize?${q}`;
}

interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(params: Record<string, string>, http: Fetch): Promise<TokenReply> {
  const res = await http(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: SCOPES, ...params }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<TokenReply> & { error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    const detail = (body.error_description ?? body.error ?? `HTTP ${res.status}`).split('\r\n')[0];
    const hint = body.error === 'invalid_client' ? ' Check MS_CLIENT_ID and MS_CLIENT_SECRET (a client secret expires).' : '';
    throw new GraphError(`Microsoft sign-in failed for the mail intake: ${detail}${hint}`, res.status, body.error ?? 'SIGN_IN_FAILED');
  }
  return body as TokenReply;
}

/**
 * Finishes "Connect Outlook": swaps the code for tokens, checks it is the intake mailbox that
 * signed in (not whoever happened to be logged in to Microsoft in that browser), and saves it.
 */
export async function completeSignIn(code: string, redirectUri: string, connectedById: string, http: Fetch = fetch) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, http);
  if (!t.refresh_token) {
    throw new GraphError('Microsoft did not return a refresh token. Add the delegated permission offline_access to the app in Entra.', 400, 'NO_REFRESH_TOKEN');
  }
  const meRes = await http('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const me = (await meRes.json().catch(() => ({}))) as { mail?: string | null; userPrincipalName?: string };
  const names = [me.mail, me.userPrincipalName].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const account = names[0] ?? '';
  if (!account) throw new GraphError('Microsoft did not say who signed in. Try "Connect Outlook" again.', 502, 'NO_ACCOUNT');
  if (env.MAIL_MAILBOX && !names.includes(env.MAIL_MAILBOX.toLowerCase())) {
    throw new GraphError(
      `You signed in to Microsoft as ${account}, but the intake reads ${env.MAIL_MAILBOX}. Click "Connect Outlook" again and sign in with that mailbox.`,
      400,
      'WRONG_ACCOUNT',
    );
  }
  const refreshToken = seal(t.refresh_token);
  await prisma.mailConnection.upsert({
    where: { id: ROW },
    create: { id: ROW, account, refreshToken, connectedById },
    update: { account, refreshToken, connectedById, connectedAt: new Date() },
  });
  storedTokens.prime(t);
  return { account };
}

export async function mailConnection(): Promise<{ account: string; connectedAt: Date } | null> {
  return prisma.mailConnection.findUnique({ where: { id: ROW }, select: { account: true, connectedAt: true } });
}

export async function disconnectMail(): Promise<void> {
  await prisma.mailConnection.deleteMany({ where: { id: ROW } });
  storedTokens.forget();
}

/** Access tokens from the saved sign-in, renewed a minute before they expire. */
export class StoredTokens implements TokenProvider {
  private cached: { value: string; expiresAt: number } | null = null;

  constructor(private readonly http: Fetch = fetch) {}

  forget() {
    this.cached = null;
  }

  prime(t: TokenReply) {
    this.cached = { value: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  }

  async accessToken(fresh = false): Promise<string> {
    if (!fresh && this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.value;
    const row = await prisma.mailConnection.findUnique({ where: { id: ROW } });
    if (!row) throw new GraphError(NOT_CONNECTED, 401, 'NOT_CONNECTED');

    let refreshToken: string;
    try {
      refreshToken = unseal(row.refreshToken);
    } catch {
      throw new GraphError('The saved Outlook sign-in cannot be read (was JWT_SECRET changed?). Click "Connect Outlook" again.', 401, 'RECONNECT_NEEDED');
    }

    let t: TokenReply;
    try {
      t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, this.http);
    } catch (err) {
      if (err instanceof GraphError && (err.code === 'invalid_grant' || err.code === 'interaction_required')) {
        throw new GraphError(
          `The Outlook sign-in for ${row.account} has expired or was withdrawn. An admin clicks "Connect Outlook" again. (${err.message})`,
          401,
          'RECONNECT_NEEDED',
        );
      }
      throw err;
    }
    // Microsoft may hand out a new refresh token each time; the old one then stops working.
    if (t.refresh_token && t.refresh_token !== refreshToken) {
      await prisma.mailConnection.update({ where: { id: ROW }, data: { refreshToken: seal(t.refresh_token) } });
    }
    this.prime(t);
    return t.access_token;
  }
}

export const storedTokens = new StoredTokens();
