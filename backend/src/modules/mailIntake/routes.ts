import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { childLogger } from '../../lib/logger.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { authorizeUrl, completeSignIn, disconnectMail, readState, redirectUriFor } from '../../services/mailIntake/delegated.js';
import {
  mailConnectionChanged,
  mailIntakeConfigured,
  mailIntakeStatus,
  refreshMailConnection,
  runMailIntake,
} from '../../services/mailIntake/intake.js';

const log = childLogger('mail-intake');

/** The Outlook email intake: what it last did, "check the mailbox now", and "Connect Outlook". */
export const mailIntakeRouter = Router();

/**
 * Microsoft sends the browser back here after "Connect Outlook". It carries no app session (it is a
 * plain redirect), so it is trusted through the signed state instead, and answers with a redirect
 * to the worklist that says how it went.
 */
mailIntakeRouter.get('/oauth/callback', async (req, res) => {
  const back = (outcome: 'connected' | 'error', detail?: string) =>
    res.redirect(303, `/?mail=${outcome}${detail ? `&detail=${encodeURIComponent(detail.slice(0, 300))}` : ''}`);
  try {
    const q = req.query as Record<string, string | undefined>;
    if (q.error) return back('error', q.error_description?.split('\r\n')[0] ?? q.error);
    const state = q.state ? readState(q.state) : null;
    if (!state) return back('error', 'The sign-in link was out of date or not started here. Click "Connect Outlook" again.');
    if (!q.code) return back('error', 'Microsoft did not send a sign-in code. Click "Connect Outlook" again.');
    const { account } = await completeSignIn(q.code, state.redirectUri, state.uid);
    log.info({ account, by: state.uid }, 'Outlook connected');
    await mailConnectionChanged();
    if (env.MAIL_INTAKE_ENABLED) void runMailIntake().catch(() => undefined);
    return back('connected', account);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Connect Outlook failed');
    return back('error', (err as Error).message);
  }
});

mailIntakeRouter.use(requireAuth);

mailIntakeRouter.get('/status', async (_req, res, next) => {
  try {
    await refreshMailConnection();
    res.json(mailIntakeStatus());
  } catch (err) {
    next(err);
  }
});

mailIntakeRouter.post('/run', requireRole('OPERATIONS', 'ADMIN', 'UPLOADER'), async (_req, res, next) => {
  try {
    if (!env.MAIL_INTAKE_ENABLED) throw badRequest('The Outlook email intake is switched off (MAIL_INTAKE_ENABLED=false).', 'MAIL_INTAKE_OFF');
    const missing = mailIntakeConfigured();
    if (missing.length) throw badRequest(`The Outlook email intake is missing ${missing.join(', ')}.`, 'MAIL_INTAKE_NOT_CONFIGURED');
    const results = await runMailIntake().catch(() => null);
    res.json({ ...mailIntakeStatus(), ran: results ?? [] });
  } catch (err) {
    next(err);
  }
});

const startBody = z.object({ origin: z.string().url() });

/** Starts "Connect Outlook": the address of the Microsoft sign-in page to send the browser to. */
mailIntakeRouter.post('/oauth/start', requireRole('ADMIN', 'OPERATIONS'), (req, res, next) => {
  try {
    if (env.MAIL_AUTH_MODE !== 'delegated') throw badRequest('MAIL_AUTH_MODE is "app"; there is nothing to connect.', 'MAIL_AUTH_APP');
    const missing = mailIntakeConfigured();
    if (missing.length) throw badRequest(`Fill in ${missing.join(', ')} in the server settings first.`, 'MAIL_INTAKE_NOT_CONFIGURED');
    const { origin } = startBody.parse(req.body);
    // Microsoft only ever sends the code to an address registered in Entra, so the origin need not be trusted.
    res.json({ url: authorizeUrl(req.user!.id, redirectUriFor(origin)) });
  } catch (err) {
    next(err);
  }
});

mailIntakeRouter.delete('/connection', requireRole('ADMIN'), async (_req, res, next) => {
  try {
    await disconnectMail();
    await mailConnectionChanged();
    res.json(mailIntakeStatus());
  } catch (err) {
    next(err);
  }
});
