/**
 * Notifications: an internal helper other services call inside their own
 * transaction, plus the self-service inbox every signed-in user gets.
 *
 * `notify()` deliberately takes `uow`, not `actor` — it is not a route
 * handler's entry point, it is called *from inside* `LeaveService` and
 * `TimetableService` so the notification is written in the same database
 * transaction as the business change it reports (the outbox pattern's core
 * guarantee, achieved here without the separate `event_outbox` table: there
 * is no async worker in this codebase to deliver from it, so a synchronous,
 * same-transaction write is the honest implementation rather than writing to
 * a table nothing will ever drain).
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { NotFoundError } from '../../core/errors';
import { NotificationRepository, NotificationLogRepository } from './notifications.repository';

export type NotifyInput = {
  title: string;
  body: string;
  targetType: 'student' | 'guardian' | 'staff' | 'section' | 'class' | 'all';
  targetId?: string | undefined;
  createdBy: string | null;
  /** Each recipient gets one log row. A recipient with neither id is skipped. */
  recipients: readonly { userId?: string | undefined; guardianId?: string | undefined }[];
};

export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly logs: NotificationLogRepository,
  ) {}

  /**
   * Write one notification plus one log per recipient, in-app only.
   *
   * Never throws for a bad recipient list — notifying is a side effect of
   * the real business action, and a notification that cannot be addressed
   * is skipped, not a reason to fail the leave decision or substitution it
   * is reporting.
   */
  async notify(uow: Uow, input: NotifyInput): Promise<{ notificationId: string; delivered: number } | null> {
    const addressable = input.recipients.filter((r) => r.userId || r.guardianId);
    if (addressable.length === 0) return null;

    const notification = await this.notifications.create(uow, {
      title: input.title,
      body: input.body,
      channel: 'in_app',
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      created_by: input.createdBy,
    });

    let delivered = 0;
    for (const r of addressable) {
      await this.logs.create(uow, {
        notification_id: notification.id,
        user_id: r.userId ?? null,
        guardian_id: r.guardianId ?? null,
        channel: 'in_app',
        status: 'sent', // in-app: persisting the row is the delivery.
        sent_at: new Date().toISOString(),
      });
      delivered += 1;
    }
    return { notificationId: notification.id, delivered };
  }

  /* ---------------- self-service inbox ---------------- */

  async listMine(actor: Actor, page: { limit: number; cursor?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      if (actor.userId == null) throw new NotFoundError('Notification');
      let cursorCreatedAt: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorCreatedAt = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.logs.listForUser(uow, String(actor.userId), { limit: page.limit, cursorCreatedAt, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({ id: r.id, title: r.title, body: r.body, status: r.status, createdAt: r.created_at })),
        hasMore,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.created_at, i: last.id }), 'utf8').toString('base64url') : null,
      };
    });
  }

  async markRead(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      if (actor.userId == null) throw new NotFoundError('Notification');
      const ok = await this.logs.markRead(uow, id, String(actor.userId));
      if (!ok) throw new NotFoundError('Notification');
    });
  }

  async markAllRead(actor: Actor): Promise<{ updated: number }> {
    return transaction(actor, async (uow) => {
      if (actor.userId == null) return { updated: 0 };
      return { updated: await this.logs.markAllRead(uow, String(actor.userId)) };
    });
  }
}
