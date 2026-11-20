import { Router } from 'express';
import { env } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { mailIntakeConfigured, mailIntakeStatus, runMailIntake } from '../../services/mailIntake/intake.js';

/** The Outlook email intake: what it last did, and "check the mailbox now" for live demos. */
export const mailIntakeRouter = Router();
mailIntakeRouter.use(requireAuth);

mailIntakeRouter.get('/status', (_req, res) => {
  res.json(mailIntakeStatus());
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
