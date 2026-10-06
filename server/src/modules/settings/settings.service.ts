/**
 * Key-value settings (Module 1), and the typed accessors the rest of the
 * application reads business rules through.
 *
 * Every default the brief fixed in decision 7 lives here rather than as a
 * literal in a service, so it can be changed without a deploy.
 *
 * **Sensitive settings are never returned in plain form.** A key matching
 * `SENSITIVE_KEY` reads back as a masked placeholder from every endpoint. The
 * value is still readable internally by `getRaw`, which is what a payment
 * gateway adapter uses — the masking is about the API surface, not about hiding
 * it from the process.
 */

import { readTransaction, transaction, type Actor } from '../../core/db/uow';
import type { CacheStore } from '../../core/cache/cache';
import { NotFoundError, ValidationError } from '../../core/errors';
import { Money } from '../../core/money/money';

/** Keys whose value is never sent to a client. */
const SENSITIVE_KEY = /(secret|password|token|api[_-]?key|private)/i;
const MASK = '••••••••';

/**
 * Defaults, and the group each belongs to.
 *
 * A setting absent from the database falls back to its default here, so a fresh
 * install works before anything is configured and adding a setting does not
 * require a migration.
 */
export const SETTING_DEFAULTS = {
  /* School profile (Module 1). */
  'school.name': { group: 'school', value: 'School' },
  'school.address': { group: 'school', value: '' },
  'school.phone': { group: 'school', value: '' },
  'school.email': { group: 'school', value: '' },
  'school.logo_path': { group: 'school', value: '' },
  'school.currency': { group: 'school', value: 'PKR' },
  'school.receipt_prefix': { group: 'school', value: 'RCP' },
  'school.receipt_footer': { group: 'school', value: '' },

  /* Decision 7: business rules, changeable without code. */
  'transport.full_month_cutoff_day': { group: 'fees', value: '15' },
  'payroll.absence_divisor': { group: 'payroll', value: '30' },
  'fees.fine_cap_percent_of_subtotal': { group: 'fees', value: '50' },
  'inventory.allow_partial_po_receiving': { group: 'inventory', value: 'true' },

  /* Feature flags. Both off by default, as decision 7 requires. */
  'exams.require_fee_clearance_for_admit_card': { group: 'exams', value: 'false' },
  'exams.require_fee_clearance_for_report_card': { group: 'exams', value: 'false' },
  'exams.fee_clearance_threshold': { group: 'exams', value: '0.00' },

  /* Attendance. */
  'attendance.weekend_days': { group: 'attendance', value: 'saturday,sunday' },
  'attendance.past_edit_window_days': { group: 'attendance', value: '7' },
  'attendance.defaulter_threshold_percent': { group: 'attendance', value: '75' },

  /* Library. */
  'library.loan_days': { group: 'library', value: '14' },
  'library.max_books_student': { group: 'library', value: '2' },
  'library.max_books_staff': { group: 'library', value: '5' },
  'library.fine_per_day': { group: 'library', value: '5.00' },
  'library.fine_grace_days': { group: 'library', value: '0' },
  'library.max_renewals': { group: 'library', value: '2' },

  /* Notifications. */
  'notifications.fee_reminder_interval_days': { group: 'notifications', value: '7' },
  'notifications.sms_enabled': { group: 'notifications', value: 'false' },
  'notifications.whatsapp_enabled': { group: 'notifications', value: 'false' },
  'notifications.email_enabled': { group: 'notifications', value: 'true' },
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export type SettingView = { key: string; value: string; group: string; isSensitive: boolean };

export class SettingsService {
  constructor(private readonly cache: CacheStore) {}

  /**
   * Every setting, masked, grouped by area.
   *
   * Defaults are merged in so a client sees the value actually in force rather
   * than only the rows somebody has explicitly saved.
   */
  async list(_actor: Actor): Promise<Record<string, SettingView[]>> {
    const stored = await this.all();

    const grouped: Record<string, SettingView[]> = {};
    for (const [key, def] of Object.entries(SETTING_DEFAULTS)) {
      const isSensitive = SENSITIVE_KEY.test(key);
      const raw = stored.get(key) ?? def.value;
      (grouped[def.group] ??= []).push({
        key,
        value: isSensitive && raw !== '' ? MASK : raw,
        group: def.group,
        isSensitive,
      });
    }

    // Rows in the database that are not in the catalogue: shown, so a setting
    // added by hand is visible rather than invisible.
    for (const [key, value] of stored) {
      if (key in SETTING_DEFAULTS) continue;
      const isSensitive = SENSITIVE_KEY.test(key);
      (grouped.other ??= []).push({
        key,
        value: isSensitive && value !== '' ? MASK : value,
        group: 'other',
        isSensitive,
      });
    }

    return grouped;
  }

  /**
   * Write settings.
   *
   * Upsert in one statement, then the cache is cleared. Invalidation is by
   * whole namespace rather than per key, because a caller can change several at
   * once and the namespace is small.
   */
  async update(actor: Actor, values: Record<string, string>): Promise<{ updated: number }> {
    const keys = Object.keys(values);
    if (keys.length === 0) {
      throw new ValidationError('Provide at least one setting to change.');
    }

    const updated = await transaction(actor, async (uow) => {
      const groups = keys.map((key) => SETTING_DEFAULTS[key as SettingKey]?.group ?? 'other');

      return uow.count(
        `INSERT INTO settings (key, value, group_name)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [keys, keys.map((k) => values[k]!), groups],
      );
    });

    await this.cache.clearNamespace('settings');
    return { updated };
  }

  /* ---------------- typed accessors ---------------- */

  /** The value in force, cached. Falls back to the catalogue default. */
  async get(key: SettingKey): Promise<string> {
    const stored = await this.all();
    return stored.get(key) ?? SETTING_DEFAULTS[key].value;
  }

  /**
   * An unmasked value, for internal use only.
   *
   * Never reachable from a route. A gateway adapter needs the real key.
   */
  async getRaw(key: string): Promise<string | null> {
    return (await this.all()).get(key) ?? null;
  }

  async getNumber(key: SettingKey): Promise<number> {
    const raw = await this.get(key);
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      // A malformed setting must not silently become NaN and propagate into a
      // fee calculation; the default is the safer answer, and it is logged by
      // the caller's error path if it matters.
      throw new ValidationError(`Setting "${key}" is not a number: "${raw}".`);
    }
    return n;
  }

  /** A money-valued setting, as a decimal. Never a float. */
  async getMoney(key: SettingKey): Promise<Money> {
    return Money.of(await this.get(key));
  }

  async getBoolean(key: SettingKey): Promise<boolean> {
    return (await this.get(key)).trim().toLowerCase() === 'true';
  }

  /** Settings as a map, cached for the namespace TTL. */
  private async all(): Promise<Map<string, string>> {
    const entries = await this.cache.getOrLoad('settings', 'all', async () =>
      readTransaction({ userId: null, userType: null }, async (uow) => {
        const rows = await uow.many<{ key: string; value: string | null }>(
          `SELECT key, value FROM settings`,
        );
        return rows.map((r) => [r.key, r.value ?? ''] as [string, string]);
      }),
    );
    return new Map(entries);
  }

  /** Invalidate after a write from outside this service (a seed, a migration). */
  async invalidate(): Promise<void> {
    await this.cache.clearNamespace('settings');
  }

  async getOrThrow(key: string): Promise<string> {
    const value = await this.getRaw(key);
    if (value === null) throw new NotFoundError('Setting');
    return value;
  }
}
