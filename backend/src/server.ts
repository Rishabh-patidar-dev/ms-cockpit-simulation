import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './db/client.js';
import { logger } from './lib/logger.js';
import { mailIntakeConfigured } from './services/mailIntake/intake.js';
import { ensureDirectories } from './services/storage.js';
import { startWorkers, stopWorkers, releaseInFlight } from './workers/index.js';

/**
 * Refuse to start misconfigured rather than failing on every extraction tick.
 *
 * Silently falling back to the mock extractor would be the worse option by far: it would
 * put invented data in front of a reviewer who has no way to tell it apart from a real
 * reading, which is exactly the failure the approval checkpoint exists to prevent.
 */
function assertExtractionConfigured() {
  if (env.EXTRACTION_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    throw new Error(
      'EXTRACTION_PROVIDER is "gemini" but GEMINI_API_KEY is empty.\n' +
        '  Set GEMINI_API_KEY in backend/.env to use the real extractor, or\n' +
        '  set EXTRACTION_PROVIDER=mock to run the lifecycle with a stub extractor.',
    );
  }
}

function assertSapLogApiConfigured() {
  if (env.SAP_LOG_API_MODE === 'live' && !env.SAP_LOG_API_URL) {
    throw new Error(
      'SAP_LOG_API_MODE is "live" but SAP_LOG_API_URL is empty.\n' +
        `  Set SAP_LOG_API_URL to the ${env.SAP_LOG_API_NAME} endpoint, or\n` +
        '  set SAP_LOG_API_MODE=mock (answered in-process) or off.',
    );
  }
}

function assertSapApiConfigured() {
  if (env.SAP_API_KEY && env.SAP_API_KEY.length < 24) {
    throw new Error(
      'SAP_API_KEY is shorter than 24 characters.\n' +
        '  It guards an endpoint on the internet; make it long and random, or leave it empty to switch the SAP API off.',
    );
  }
}

function assertMailIntakeConfigured() {
  const missing = env.MAIL_INTAKE_ENABLED ? mailIntakeConfigured() : [];
  if (missing.length > 0) {
    throw new Error(
      `MAIL_INTAKE_ENABLED is true but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty.\n` +
        '  Fill them in from the Entra app registration (DEPLOY.md "Outlook email intake"), or\n' +
        '  set MAIL_INTAKE_ENABLED=false.',
    );
  }
}

async function main() {
  assertExtractionConfigured();
  assertMailIntakeConfigured();
  assertSapApiConfigured();
  assertSapLogApiConfigured();
  await ensureDirectories();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        provider: env.EXTRACTION_PROVIDER,
        outbound: env.paths.outbound,
        inbound: env.paths.inbound,
      },
      'Business Command Centre API listening',
    );
  });

  if (env.WORKERS_ENABLED) startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopWorkers();
    await releaseInFlight().catch((err) => logger.error({ err }, 'could not hand back the record being read'));
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
