/**
 * Notification data access (Module 14, the slice Section 2 needs).
 *
 * In-app only: `notification_logs.status` reaching `'sent'` for the `in_app`
 * channel means the row is persisted and visible through the read endpoints
 * below — for that channel, persistence *is* delivery, there is no further
 * transport step. SMS, WhatsApp and email are not wired to any real
 * transport (no provider credentials or client exist in this codebase), so a
 * log for those channels is written `'queued'` and never progresses. That is
 * reported as a limitation, not quietly left to look like it worked.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder } from '../../core/db/query-builder';
import type { SortMap } from '../../core/db/query-builder';

export type NotificationRow = BaseRow & {
  title: string;
  body: string;
  channel: string;
  target_type: string;
  target_id: string | null;
  created_by: string | null;
};

export class NotificationRepository extends BaseRepository<NotificationRow> {
  protected readonly table = 'notifications';
  protected readonly writableColumns = ['title', 'body', 'channel', 'target_type', 'target_id', 'created_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = { created_at: { column: 'notifications.created_at', index: 'notifications_pkey' } };
}

export type NotificationLogRow = BaseRow & {
  notification_id: string;
  user_id: string | null;
  guardian_id: string | null;
  channel: string;
  status: string;
  sent_at: string | null;
  error_message: string | null;
};

export class NotificationLogRepository extends BaseRepository<NotificationLogRow> {
  protected readonly table = 'notification_logs';
  protected readonly writableColumns = ['notification_id', 'user_id', 'guardian_id', 'channel', 'status', 'sent_at', 'error_message'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = { created_at: { column: 'notification_logs.created_at', index: 'notification_logs_pkey' } };

  /** One caller's in-app inbox, newest first. */
  async listForUser(
    uow: Uow,
    userId: string,
    page: { limit: number; cursorCreatedAt?: string | undefined; cursorId?: string | undefined },
  ): Promise<(NotificationLogRow & { title: string; body: string })[]> {
    const where = new ConditionBuilder();
    where.add('l.user_id = ?', userId);
    if (page.cursorCreatedAt && page.cursorId) {
      where.add('(l.created_at, l.id) < (?::timestamptz, ?::bigint)', page.cursorCreatedAt, page.cursorId);
    }
    return uow.many(
      `SELECT l.*, n.title, n.body
         FROM notification_logs l
         JOIN notifications n ON n.id = l.notification_id
        ${where.where()}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  async markRead(uow: Uow, id: string, userId: string): Promise<boolean> {
    const affected = await uow.count(
      `UPDATE notification_logs SET status = 'read' WHERE id = $1 AND user_id = $2 AND status <> 'read'`,
      [id, userId],
    );
    return affected > 0;
  }

  async markAllRead(uow: Uow, userId: string): Promise<number> {
    return uow.count(`UPDATE notification_logs SET status = 'read' WHERE user_id = $1 AND status NOT IN ('read')`, [userId]);
  }

  async unreadCount(uow: Uow, userId: string): Promise<number> {
    const row = await uow.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification_logs WHERE user_id = $1 AND status IN ('queued', 'sent')`,
      [userId],
    );
    return row.n;
  }
}
