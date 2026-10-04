/**
 * Structured logging.
 *
 * Part 5.6 requires that sensitive fields never reach the log. Relying on call
 * sites to remember that does not work at this size, so redaction is configured
 * once here and applies to everything. The paths cover the fields this schema
 * actually holds: password hashes, tokens, and the national ID numbers the
 * brief names explicitly alongside them.
 *
 * `redact` matches by path, so a field has to be listed to be caught. Anything
 * genuinely secret should also simply not be put in a log line — this is the
 * safety net, not the plan.
 */

import pino from 'pino';
import { config } from '../config';

const SENSITIVE = [
  'password',
  'newPassword',
  'currentPassword',
  'password_hash',
  'passwordHash',
  'temporaryPassword',
  'token',
  'accessToken',
  'refreshToken',
  'idempotencyKey',
  'national_id',
  'nationalId',
  'cnic',
  'authorization',
  'cookie',
  'set-cookie',
];

/** Cover the field wherever it appears: top level, in a body, in headers. */
const paths = SENSITIVE.flatMap((field) => [
  field,
  `*.${field}`,
  `req.body.${field}`,
  `req.headers.${field}`,
  `res.headers.${field}`,
]);

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths, censor: '[redacted]' },
  base: { service: 'school-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Human-readable locally; single-line JSON everywhere a collector reads it.
  ...(config.isProduction || config.isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

/**
 * A separate channel for authentication and authorization events.
 *
 * Part 5.6 asks for security logs kept apart from request logs. Tagging rather
 * than a second destination keeps one stream to ship while still letting
 * `channel: "security"` be filtered or alerted on independently.
 */
export const securityLogger = logger.child({ channel: 'security' });
