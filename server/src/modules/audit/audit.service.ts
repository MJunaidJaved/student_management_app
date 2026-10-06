/**
 * Audit log search (Module 1).
 *
 * Read-only, and that is a structural guarantee, not a convention: there is no
 * update or delete method here and no endpoint for one, and the database
 * enforces it anyway via `trg_audit_immutable`, which raises "Table audit_logs
 * is append-only" on any UPDATE or DELETE.
 *
 * Keyset pagination, because this is the table that grows fastest — every
 * change to a student, invoice, payment, mark or role writes a row, and the
 * brief's own volume estimate is a million of them. `OFFSET 900000` here would
 * make Postgres walk and discard 900,000 rows per page.
 */

import { readTransaction, type Actor } from '../../core/db/uow';
import {
  ConditionBuilder,
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../core/db/query-builder';
import type { PageMeta } from '../../core/http/envelope';

export type AuditFilters = {
  userId?: string | undefined;
  tableName?: string | undefined;
  recordId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  withTotal?: boolean | undefined;
};

export type AuditEntry = {
  id: string;
  userId: string | null;
  username: string | null;
  action: string;
  event: string | null;
  tableName: string | null;
  recordId: string | null;
  ipAddress: string | null;
  createdAt: string;
};

/**
 * The only sort offered.
 *
 * An audit log is read newest-first, and `(created_at DESC, id DESC)` is the
 * one ordering worth indexing for it. Offering a sort by `action` or `user_id`
 * would need composite indexes that only pay off for queries nobody makes.
 */
const SORT_KEY = 'createdAt';

export class AuditService {
  async search(
    actor: Actor,
    filters: AuditFilters,
  ): Promise<{ entries: AuditEntry[]; page: PageMeta }> {
    const limit = clampLimit(filters.limit);

    return readTransaction(actor, async (uow) => {
      const where = new ConditionBuilder();

      where.addIf(filters.userId, 'a.user_id = ?', filters.userId);
      where.addIf(filters.tableName, 'a.table_name = ?', filters.tableName);
      where.addIf(filters.recordId, 'a.record_id = ?', filters.recordId);
      where.addIf(filters.action, 'a.action = ?', filters.action);
      // Inclusive of the whole `to` day: a caller passing a date means the day,
      // and `created_at <= '2026-09-30'` would otherwise exclude everything
      // after midnight.
      where.addIf(filters.from, 'a.created_at >= ?::date', filters.from);
      where.addIf(filters.to, 'a.created_at < (?::date + 1)', filters.to);

      if (filters.cursor) {
        const cursor = decodeCursor(filters.cursor, SORT_KEY);
        // Row-wise comparison, so one composite index satisfies it.
        where.add('(a.created_at, a.id) < (?::timestamptz, ?::bigint)', cursor.v, cursor.i);
      }

      const rows = await uow.many<AuditEntry & { rowCreatedAt: string }>(
        `SELECT a.id::text          AS id,
                a.user_id::text     AS "userId",
                u.username          AS username,
                a.action,
                a.new_values->>'event' AS event,
                a.table_name        AS "tableName",
                a.record_id         AS "recordId",
                host(a.ip_address)  AS "ipAddress",
                a.created_at::text  AS "createdAt",
                a.created_at::text  AS "rowCreatedAt"
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          ${where.where()}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT ${limit + 1}`,
        where.params(),
      );

      const hasMore = rows.length > limit;
      const entries = hasMore ? rows.slice(0, limit) : rows;
      const last = entries[entries.length - 1];

      const page: PageMeta = {
        limit,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({ k: SORT_KEY, v: last.rowCreatedAt, i: last.id })
            : null,
      };

      /*
       * Only counted when asked (Part 5.5). On a million-row table this is a
       * full scan of everything matching the filter, so making it automatic
       * would make every page of the audit log slow.
       */
      if (filters.withTotal) {
        const countWhere = new ConditionBuilder();
        countWhere.addIf(filters.userId, 'a.user_id = ?', filters.userId);
        countWhere.addIf(filters.tableName, 'a.table_name = ?', filters.tableName);
        countWhere.addIf(filters.recordId, 'a.record_id = ?', filters.recordId);
        countWhere.addIf(filters.action, 'a.action = ?', filters.action);
        countWhere.addIf(filters.from, 'a.created_at >= ?::date', filters.from);
        countWhere.addIf(filters.to, 'a.created_at < (?::date + 1)', filters.to);

        const row = await uow.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_logs a ${countWhere.where()}`,
          countWhere.params(),
        );
        page.total = row.n;
      }

      return {
        entries: entries.map(({ rowCreatedAt: _ignored, ...entry }) => entry),
        page,
      };
    });
  }

  /** One entry, with its before/after values, for an investigation. */
  async get(
    actor: Actor,
    id: string,
  ): Promise<AuditEntry & { oldValues: unknown; newValues: unknown }> {
    return readTransaction(actor, (uow) =>
      uow.one(
        `SELECT a.id::text          AS id,
                a.user_id::text     AS "userId",
                u.username          AS username,
                a.action,
                a.new_values->>'event' AS event,
                a.table_name        AS "tableName",
                a.record_id         AS "recordId",
                host(a.ip_address)  AS "ipAddress",
                a.created_at::text  AS "createdAt",
                a.old_values        AS "oldValues",
                a.new_values        AS "newValues"
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id = $1`,
        [id],
        'Audit entry',
      ),
    );
  }
}
