/**
 * The admin console's two read-only views: a school-wide overview (everything
 * that needs an administrator's eye today) and the state of the system itself
 * (database, migrations, cloud sync).
 *
 * Each is a set of small aggregate queries in one read transaction, so the
 * console gets a consistent picture in a single request instead of a dozen.
 */

import type { QueryResultRow } from 'pg';
import { readTransaction, type Actor, type Uow } from '../../core/db/uow';
import { activeCloudSync, pendingChanges } from '../../core/sync/cloud-sync';
import { config } from '../../core/config';

const num = (v: unknown): number => Number(v ?? 0);

async function rows<T extends QueryResultRow>(uow: Uow, sql: string, params: unknown[] = []): Promise<T[]> {
  return uow.many<T>(sql, params);
}

export class AdminService {
  async overview(actor: Actor) {
    return readTransaction(actor, async (uow) => {
      const [people] = await rows<Record<string, string>>(uow, `
        SELECT (SELECT count(*) FROM students WHERE status = 'active' AND deleted_at IS NULL) AS students,
               (SELECT count(*) FROM students WHERE status = 'active' AND deleted_at IS NULL AND gender = 'female') AS girls,
               (SELECT count(*) FROM staff WHERE status = 'active' AND deleted_at IS NULL) AS staff,
               (SELECT count(*) FROM guardians) AS guardians,
               (SELECT count(*) FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.deleted_at IS NULL) AS sections,
               (SELECT count(*) FROM classes) AS classes`);

      const year = await uow.maybeOne<{ id: string; name: string }>(`SELECT id::text, name FROM academic_years WHERE is_current`);

      // Attendance: today, by class, and the trend over the last school days.
      const today = await rows<{ status: string; n: string }>(uow,
        `SELECT status, count(*) AS n FROM student_attendance WHERE att_date = current_date GROUP BY status`);
      const staffToday = await rows<{ status: string; n: string }>(uow,
        `SELECT status, count(*) AS n FROM staff_attendance WHERE att_date = current_date GROUP BY status`);
      const byClass = await rows<{ class_name: string; level: number; enrolled: string; marked: string; present: string }>(uow, `
        SELECT c.name AS class_name, c.level_order AS level,
               count(DISTINCT e.id) AS enrolled,
               count(a.id) AS marked,
               count(a.id) FILTER (WHERE a.status IN ('present', 'late')) AS present
          FROM classes c
          JOIN student_enrollments e ON e.class_id = c.id AND e.status = 'active'
               AND e.academic_year_id = (SELECT id FROM academic_years WHERE is_current)
          LEFT JOIN student_attendance a ON a.enrollment_id = e.id AND a.att_date = current_date
         GROUP BY c.id ORDER BY c.level_order`);
      const trend = await rows<{ day: string; total: string; present: string }>(uow, `
        SELECT att_date::text AS day, count(*) AS total, count(*) FILTER (WHERE status IN ('present', 'late')) AS present
          FROM student_attendance
         WHERE att_date > current_date - 21
         GROUP BY att_date ORDER BY att_date`);
      const sectionsUnmarked = await rows<{ name: string }>(uow, `
        SELECT c.name || ' - ' || s.name AS name
          FROM sections s JOIN classes c ON c.id = s.class_id
         WHERE s.deleted_at IS NULL
           AND EXTRACT(dow FROM current_date) <> 0
           AND NOT EXISTS (
             SELECT 1 FROM student_attendance a JOIN student_enrollments e ON e.id = a.enrollment_id
              WHERE e.section_id = s.id AND a.att_date = current_date)
         ORDER BY c.level_order, s.name`);

      // Fees.
      const [fees] = await rows<Record<string, string>>(uow, `
        SELECT
          (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'valid'
              AND (paid_at AT TIME ZONE 'Asia/Karachi')::date = (now() AT TIME ZONE 'Asia/Karachi')::date) AS collected_today,
          (SELECT coalesce(sum(amount), 0) FROM payments WHERE status = 'valid'
              AND date_trunc('month', paid_at AT TIME ZONE 'Asia/Karachi') = date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')) AS collected_month,
          (SELECT coalesce(sum(total - paid_total), 0) FROM fee_invoices WHERE status IN ('unpaid', 'partial')) AS outstanding,
          (SELECT count(*) FROM fee_invoices WHERE status IN ('unpaid', 'partial')) AS open_invoices,
          (SELECT coalesce(sum(total - paid_total), 0) FROM fee_invoices WHERE status IN ('unpaid', 'partial') AND due_date < current_date) AS overdue`);
      const byPeriod = await rows<{ period: string; billed: string; collected: string }>(uow, `
        SELECT billing_period AS period, sum(total) AS billed, sum(paid_total) AS collected
          FROM fee_invoices WHERE status <> 'cancelled'
         GROUP BY billing_period ORDER BY billing_period DESC LIMIT 6`);
      const defaulters = await rows<{ student_id: string; name: string; admission_no: string; class_name: string; invoices: string; due: string }>(uow, `
        SELECT st.id::text AS student_id, st.first_name || coalesce(' ' || st.last_name, '') AS name, st.admission_no,
               c.name || ' - ' || s.name AS class_name, count(*) AS invoices, sum(i.total - i.paid_total) AS due
          FROM fee_invoices i
          JOIN student_enrollments e ON e.id = i.enrollment_id
          JOIN students st ON st.id = e.student_id
          JOIN sections s ON s.id = e.section_id
          JOIN classes c ON c.id = e.class_id
         WHERE i.status IN ('unpaid', 'partial') AND i.due_date < current_date
         GROUP BY st.id, c.name, s.name
         ORDER BY sum(i.total - i.paid_total) DESC, count(*) DESC
         LIMIT 6`);

      // Work waiting on someone.
      const [queue] = await rows<Record<string, string>>(uow, `
        SELECT (SELECT count(*) FROM leave_requests WHERE status = 'pending') AS leave_pending,
               (SELECT count(*) FROM admission_applications WHERE status IN ('enquiry', 'applied', 'test', 'accepted')) AS applications_open,
               (SELECT count(*) FROM vouchers WHERE status = 'draft') AS vouchers_draft,
               (SELECT count(*) FROM payroll_runs WHERE status IN ('draft', 'approved')) AS payroll_open,
               (SELECT count(*) FROM purchase_orders WHERE status IN ('draft', 'ordered')) AS po_open,
               (SELECT count(*) FROM items i LEFT JOIN item_stock s ON s.item_id = i.id
                 WHERE i.deleted_at IS NULL AND coalesce(s.quantity, 0) <= i.reorder_level) AS low_stock,
               (SELECT count(*) FROM exams WHERE status = 'draft') AS exams_draft`);
      const upcomingExams = await rows<{ id: string; name: string; start_date: string; end_date: string; status: string }>(uow, `
        SELECT id::text, name, start_date::text, end_date::text, status FROM exams
         WHERE end_date >= current_date ORDER BY start_date LIMIT 4`);

      const activity = await rows<{ id: string; action: string; table_name: string; record_id: string | null; username: string | null; created_at: string }>(uow, `
        SELECT a.id::text, a.action, a.table_name, a.record_id, u.username, to_json(a.created_at) #>> '{}' AS created_at
          FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT 10`);

      const count = (list: { status: string; n: string }[], ...statuses: string[]) =>
        list.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + num(r.n), 0);

      return {
        session: year?.name ?? null,
        people: {
          students: num(people!.students),
          girls: num(people!.girls),
          staff: num(people!.staff),
          guardians: num(people!.guardians),
          classes: num(people!.classes),
          sections: num(people!.sections),
        },
        attendance: {
          students: {
            present: count(today, 'present'),
            late: count(today, 'late'),
            absent: count(today, 'absent'),
            leave: count(today, 'leave'),
            marked: count(today, 'present', 'late', 'absent', 'leave'),
          },
          staff: {
            present: count(staffToday, 'present', 'half_day'),
            late: count(staffToday, 'late'),
            absent: count(staffToday, 'absent'),
            leave: count(staffToday, 'leave'),
            marked: count(staffToday, 'present', 'half_day', 'late', 'absent', 'leave'),
          },
          byClass: byClass.map((r) => ({ className: r.class_name, enrolled: num(r.enrolled), marked: num(r.marked), present: num(r.present) })),
          trend: trend.map((r) => ({ day: r.day, rate: num(r.total) ? Math.round((num(r.present) / num(r.total)) * 1000) / 10 : 0 })),
          sectionsUnmarked: sectionsUnmarked.map((r) => r.name),
        },
        fees: {
          collectedToday: fees!.collected_today,
          collectedMonth: fees!.collected_month,
          outstanding: fees!.outstanding,
          openInvoices: num(fees!.open_invoices),
          overdue: fees!.overdue,
          byPeriod: byPeriod.reverse().map((r) => ({ period: r.period, billed: num(r.billed), collected: num(r.collected) })),
          defaulters: defaulters.map((r) => ({
            studentId: r.student_id, name: r.name, admissionNo: r.admission_no, className: r.class_name, invoices: num(r.invoices), due: r.due,
          })),
        },
        queue: {
          leavePending: num(queue!.leave_pending),
          applicationsOpen: num(queue!.applications_open),
          vouchersDraft: num(queue!.vouchers_draft),
          payrollOpen: num(queue!.payroll_open),
          purchaseOrdersOpen: num(queue!.po_open),
          lowStock: num(queue!.low_stock),
          examsDraft: num(queue!.exams_draft),
        },
        upcomingExams: upcomingExams.map((e) => ({ id: e.id, name: e.name, startDate: e.start_date, endDate: e.end_date, status: e.status })),
        activity: activity.map((a) => ({
          id: a.id, action: a.action, tableName: a.table_name, recordId: a.record_id, username: a.username, createdAt: a.created_at,
        })),
      };
    });
  }

  async system(actor: Actor) {
    const db = await readTransaction(actor, async (uow) => {
      const [info] = await rows<{ version: string; size: string; now: string }>(uow,
        `SELECT current_setting('server_version') AS version, pg_size_pretty(pg_database_size(current_database())) AS size, to_json(now()) #>> '{}' AS now`);
      const migrations = await rows<{ name: string; run_on: string }>(uow, `SELECT name, run_on::text FROM pgmigrations ORDER BY id`);
      const tables = await rows<{ name: string; rows: string }>(uow, `
        SELECT relname AS name, n_live_tup AS rows FROM pg_stat_user_tables
         WHERE schemaname = 'public' AND relname NOT IN ('pgmigrations') ORDER BY n_live_tup DESC LIMIT 12`);
      return { info: info!, migrations, tables };
    });

    const sync = activeCloudSync();
    const status = sync ? await sync.status() : null;
    return {
      database: {
        version: db.info.version,
        size: db.info.size,
        serverTime: db.info.now,
        location: /@(localhost|127\.0\.0\.1)[:/]/.test(config.DATABASE_URL) ? 'local' : 'remote',
        lastMigration: db.migrations.at(-1)?.name ?? null,
        migrationCount: db.migrations.length,
        largestTables: db.tables.map((t) => ({ name: t.name, rows: num(t.rows) })),
      },
      cloudSync: {
        configured: Boolean(config.CLOUD_DATABASE_URL),
        enabled: Boolean(config.CLOUD_DATABASE_URL) && config.CLOUD_SYNC_ENABLED,
        state: status?.state ?? 'stopped',
        pending: status?.pending ?? (await pendingChanges()),
        lastSyncedAt: status?.lastSyncedAt ?? null,
        lastError: status?.lastError ?? null,
        appliedSinceStart: status?.appliedSinceStart ?? 0,
      },
    };
  }
}
