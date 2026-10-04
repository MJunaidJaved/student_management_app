/**
 * Settings endpoints (Module 1). Read for authorized users, write for admin.
 */

import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated } from '../../core/http/validate';
import { ok } from '../../core/http/envelope';
import { getRequestId } from '../../core/http/request-context';
import { currentUser } from '../../core/http/authenticate';
import { toActor } from '../../core/authz/permission-service';
import { SETTING_DEFAULTS, type SettingsService } from './settings.service';

/**
 * Only known keys may be written.
 *
 * An open key space would let a caller fill the table with arbitrary rows, and
 * a typo would create a new setting that silently shadows nothing rather than
 * changing the intended one.
 */
const KNOWN_KEYS = Object.keys(SETTING_DEFAULTS) as [string, ...string[]];

const updateSchema = {
  body: z
    .object({
      settings: z
        .record(z.enum(KNOWN_KEYS), z.string().max(2000))
        .refine((r) => Object.keys(r).length > 0, 'Provide at least one setting.')
        .refine((r) => Object.keys(r).length <= 100, 'At most 100 settings at a time.'),
    })
    .strict(),
};

export function settingsRoutes(settings: SettingsService): RouteDeclaration[] {
  return [
    {
      method: 'get',
      path: '/',
      summary: 'All settings, grouped by area, with sensitive values masked',
      permission: 'settings.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: (req, res, next) => {
        void settings
          .list(toActor(currentUser(req)))
          .then((groups) => res.status(200).json(ok({ groups }, getRequestId())))
          .catch(next);
      },
      errors: ['PERMISSION_DENIED'],
    },
    {
      method: 'patch',
      path: '/',
      summary: 'Change one or more settings',
      permission: 'settings.update',
      ownership: 'admin-only',
      rateLimit: 'userStandard',
      schemas: updateSchema,
      handler: (req, res, next) => {
        void (async () => {
          const { body } = validated<typeof updateSchema>(req);
          const result = await settings.update(
            toActor(currentUser(req)),
            body.settings as Record<string, string>,
          );
          res.status(200).json(ok(result, getRequestId()));
        })().catch(next);
      },
      errors: ['PERMISSION_DENIED', 'VALIDATION_FAILED'],
    },
  ];
}
