/**
 * Process entry point.
 *
 * Graceful shutdown (Part 15): stop accepting connections, let in-flight
 * requests finish, then close the pool. A hard exit mid-transaction leaves
 * Supabase's pooler holding a server connection with locks, which blocks the
 * next deploy with nothing reporting why — the reason
 * `idle_in_transaction_session_timeout` is set in core/db/pool.
 */

import { config } from './core/config';
import { logger } from './core/logging/logger';
import { closePool } from './core/db/pool';
import { buildContainer } from './container';
import { createApp } from './app';
import { CloudSync, setActiveCloudSync } from './core/sync/cloud-sync';

const app = createApp(buildContainer());

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, prefix: config.API_PREFIX },
    'School Management System API listening',
  );
});

/*
 * The local database is the primary; the cloud copy is a mirror kept current
 * in the background (see core/sync/cloud-sync). Not started under test.
 */
const cloudSync =
  config.CLOUD_DATABASE_URL && config.CLOUD_SYNC_ENABLED && config.NODE_ENV !== 'test'
    ? new CloudSync(config.CLOUD_DATABASE_URL)
    : null;
cloudSync?.start();
setActiveCloudSync(cloudSync);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second Ctrl-C should not start a parallel shutdown.
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  // Bound the wait: a hung request must not block the deploy indefinitely.
  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out; exiting');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  server.close(() => {
    // Stop the sync worker first: it holds pool connections between batches.
    void (cloudSync?.stop() ?? Promise.resolve())
      .then(() => closePool())
      .then(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Error closing the database pool');
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/*
 * A rejection nobody handled means state is now unknown, so the process is
 * replaced rather than left running in it. Logged first, because an unlogged
 * crash is a support call with no evidence.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception');
  void shutdown('uncaughtException');
});
