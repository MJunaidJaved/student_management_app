/**
 * Library (Module 12).
 *
 * Borrowing rules (Part 9.4, Part 11): before an issue is written, the book
 * row is locked, availability (`copies_total` minus currently-issued) is
 * checked against it, the borrower's limit (by type, from settings) is
 * checked, and the borrower must have no overdue book and no unpaid fine.
 * All of it runs inside one transaction so two simultaneous issues of the
 * last copy cannot both succeed.
 *
 * Fines are settled two ways, matching the schema's own
 * `library_fines_check` (`status <> 'paid' OR payment_id IS NOT NULL`):
 * waived with a reason, permission-gated, or paid by attaching an existing,
 * valid fee payment's id. This service does not create that payment itself
 * — Module 5's payment flow is invoice-centric and was not rebuilt to accept
 * a library fine as a payable target, so the cashier records the payment
 * through the fee module first and this call only links it.
 */

import { transaction, readTransaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { Money } from '../../core/money/money';
import type { SettingsService } from '../settings/settings.service';
import type { PaymentRepository } from '../fees/fees.repository';
import type { PermissionService } from '../../core/authz/permission-service';
import {
  BookCategoryRepository,
  BookRepository,
  BookIssueRepository,
  LibraryFineRepository,
  type BookCategoryRow,
  type BookRow,
  type BookIssueRow,
  type LibraryFineRow,
} from './library.repository';

/* ---------------- views ---------------- */

export type BookCategoryView = { id: string; name: string };
const toCategoryView = (r: BookCategoryRow): BookCategoryView => ({ id: r.id, name: r.name });

export type BookView = { id: string; accessionNo: string; isbn: string | null; title: string; author: string | null; categoryId: string | null; copiesTotal: number; shelfLocation: string | null };
const toBookView = (r: BookRow): BookView => ({ id: r.id, accessionNo: r.accession_no, isbn: r.isbn, title: r.title, author: r.author, categoryId: r.category_id, copiesTotal: r.copies_total, shelfLocation: r.shelf_location });

export type BookIssueView = { id: string; bookId: string; borrowerType: string; studentId: string | null; staffId: string | null; issueDate: string; dueDate: string; returnDate: string | null; status: string; renewalCount: number };
const toIssueView = (r: BookIssueRow): BookIssueView => ({
  id: r.id, bookId: r.book_id, borrowerType: r.borrower_type, studentId: r.student_id, staffId: r.staff_id,
  issueDate: r.issue_date, dueDate: r.due_date, returnDate: r.return_date, status: r.status, renewalCount: r.renewal_count,
});

export type LibraryFineView = { id: string; bookIssueId: string; amount: string; status: string; paymentId: string | null; waivedReason: string | null };
const toFineView = (r: LibraryFineRow): LibraryFineView => ({ id: r.id, bookIssueId: r.book_issue_id, amount: r.amount, status: r.status, paymentId: r.payment_id, waivedReason: r.waived_reason });

type BorrowerType = 'student' | 'staff';

export class LibraryService {
  constructor(
    private readonly categories: BookCategoryRepository,
    private readonly books: BookRepository,
    private readonly issues: BookIssueRepository,
    private readonly fines: LibraryFineRepository,
    private readonly payments: PaymentRepository,
    private readonly settings: SettingsService,
    private readonly permissions: PermissionService,
  ) {}

  /* ---------------- categories and catalog ---------------- */

  async listCategories(actor: Actor): Promise<BookCategoryView[]> {
    return readTransaction(actor, async (uow) => (await this.categories.listAll(uow)).map(toCategoryView));
  }

  async createCategory(actor: Actor, input: { name: string }): Promise<BookCategoryView> {
    return transaction(actor, async (uow) => toCategoryView(await this.categories.create(uow, { name: input.name })));
  }

  async searchBooks(actor: Actor, filters: { categoryId?: string | undefined; q?: string | undefined }, page: { limit: number; cursorId?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      const rows = await this.books.search(uow, filters, page);
      const hasMore = rows.length > page.limit;
      const trimmed = hasMore ? rows.slice(0, page.limit) : rows;
      return {
        books: trimmed.map((r) => ({ ...toBookView(r), categoryName: r.category_name, issuedCount: r.issued_count })),
        nextCursorId: hasMore ? trimmed[trimmed.length - 1]!.id : null,
      };
    });
  }

  async createBook(actor: Actor, input: { accessionNo: string; isbn?: string | undefined; title: string; author?: string | undefined; categoryId?: string | undefined; copiesTotal: number; shelfLocation?: string | undefined }): Promise<BookView> {
    return transaction(actor, async (uow) =>
      toBookView(await this.books.create(uow, {
        accession_no: input.accessionNo, isbn: input.isbn ?? null, title: input.title, author: input.author ?? null,
        category_id: input.categoryId ?? null, copies_total: input.copiesTotal, shelf_location: input.shelfLocation ?? null,
      })),
    );
  }

  /** The explicit action Part 11 asks for, separate from marking a copy lost. */
  async reduceBookCopies(actor: Actor, bookId: string, by: number): Promise<BookView> {
    if (by <= 0) throw new ValidationError('Must reduce by at least one copy.', [{ field: 'by', message: 'Must be a positive whole number.' }]);
    return transaction(actor, async (uow) => {
      const book = await this.books.lockForUpdate(uow, bookId);
      if (book.copies_total < by) {
        throw new BusinessRuleError(`Only ${book.copies_total} copies exist; cannot reduce by ${by}.`, 'TOO_FEW_COPIES');
      }
      return toBookView(await this.books.reduceCopies(uow, bookId, by));
    });
  }

  /* ---------------- ownership ---------------- */

  private async assertCanViewBorrower(uow: Uow, actor: Actor, held: ReadonlySet<string>, borrowerType: BorrowerType, borrowerId: string): Promise<void> {
    if (actor.userType === 'admin' || held.has('library.read')) return;
    if (borrowerType === 'staff' && String(actor.staffId) === borrowerId) return;
    if (borrowerType === 'student') {
      if (String(actor.studentId) === borrowerId) return;
      if (actor.userType === 'guardian' && actor.guardianId != null) {
        const link = await uow.maybeOne<{ ok: boolean }>(`SELECT true AS ok FROM student_guardians WHERE guardian_id = $1 AND student_id = $2`, [actor.guardianId, borrowerId]);
        if (link) return;
      }
    }
    throw new NotFoundError('Borrower');
  }

  async myIssues(actor: Actor): Promise<BookIssueView[]> {
    return readTransaction(actor, async (uow) => {
      const { type, id } = this.selfBorrower(actor);
      return (await this.issues.listForBorrower(uow, type, id)).map((r) => ({ ...toIssueView(r), title: r.title, accessionNo: r.accession_no }));
    });
  }

  async myFines(actor: Actor): Promise<LibraryFineView[]> {
    return readTransaction(actor, async (uow) => {
      const { type, id } = this.selfBorrower(actor);
      const myIssueRows = await this.issues.listForBorrower(uow, type, id);
      const all: LibraryFineView[] = [];
      for (const issue of myIssueRows) {
        all.push(...(await this.fines.forIssue(uow, issue.id)).map(toFineView));
      }
      return all;
    });
  }

  private selfBorrower(actor: Actor): { type: BorrowerType; id: string } {
    if (actor.userType === 'staff' && actor.staffId != null) return { type: 'staff', id: String(actor.staffId) };
    if (actor.userType === 'student' && actor.studentId != null) return { type: 'student', id: String(actor.studentId) };
    throw new ForbiddenError('No library record is associated with this account.');
  }

  async issuesForBorrower(actor: Actor, borrowerType: BorrowerType, borrowerId: string): Promise<BookIssueView[]> {
    return readTransaction(actor, async (uow) => {
      const held = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
      await this.assertCanViewBorrower(uow, actor, held, borrowerType, borrowerId);
      return (await this.issues.listForBorrower(uow, borrowerType, borrowerId)).map((r) => ({ ...toIssueView(r), title: r.title, accessionNo: r.accession_no }));
    });
  }

  /** A borrower's fines (any status) — the same ownership rule as their issue history, since a fine is always tied to one of their issues. */
  async finesForBorrower(actor: Actor, borrowerType: BorrowerType, borrowerId: string): Promise<(LibraryFineView & { title: string; accessionNo: string })[]> {
    return readTransaction(actor, async (uow) => {
      const held = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
      await this.assertCanViewBorrower(uow, actor, held, borrowerType, borrowerId);
      return (await this.fines.forBorrower(uow, borrowerType, borrowerId)).map((r) => ({ ...toFineView(r), title: r.title, accessionNo: r.accession_no }));
    });
  }

  /* ---------------- issue, return, renew, lose ---------------- */

  async issueBook(actor: Actor, input: { bookId: string; borrowerType: BorrowerType; borrowerId: string }): Promise<BookIssueView> {
    return transaction(actor, async (uow) => {
      const book = await this.books.lockForUpdate(uow, input.bookId);
      const issuedCount = await this.books.currentlyIssuedCount(uow, input.bookId);
      if (issuedCount >= book.copies_total) {
        throw new BusinessRuleError('No copies of this book are currently available.', 'NO_COPIES_AVAILABLE');
      }

      const limitKey = input.borrowerType === 'student' ? 'library.max_books_student' : 'library.max_books_staff';
      const limit = await this.settings.getNumber(limitKey);
      const current = await this.issues.currentlyIssuedForBorrower(uow, input.borrowerType, input.borrowerId);
      if (current.length >= limit) {
        throw new BusinessRuleError(`This borrower already has the maximum of ${limit} books issued.`, 'BORROWING_LIMIT_REACHED');
      }
      const today = new Date().toISOString().slice(0, 10);
      if (current.some((i) => i.due_date < today)) {
        throw new BusinessRuleError('This borrower has an overdue book and cannot borrow another until it is returned.', 'HAS_OVERDUE_BOOK');
      }
      const unpaidFines = await this.fines.unpaidCountForBorrower(uow, input.borrowerType, input.borrowerId);
      if (unpaidFines > 0) {
        throw new BusinessRuleError('This borrower has an unpaid library fine and cannot borrow until it is settled.', 'HAS_UNPAID_FINE');
      }

      const loanDays = await this.settings.getNumber('library.loan_days');
      const dueDate = addDays(today, loanDays);
      const row = await this.issues.create(uow, {
        book_id: input.bookId, borrower_type: input.borrowerType,
        student_id: input.borrowerType === 'student' ? input.borrowerId : null,
        staff_id: input.borrowerType === 'staff' ? input.borrowerId : null,
        issue_date: today, due_date: dueDate, status: 'issued',
      });
      return toIssueView(row);
    });
  }

  async returnBook(actor: Actor, issueId: string): Promise<{ issue: BookIssueView; fine: LibraryFineView | null }> {
    return transaction(actor, async (uow) => {
      const issue = await this.issues.getById(uow, issueId);
      if (issue.status !== 'issued') throw new BusinessRuleError('Only a currently-issued book can be returned.', 'NOT_ISSUED');

      const today = new Date().toISOString().slice(0, 10);
      const updated = await this.issues.setStatus(uow, issueId, 'returned', { returnDate: today });

      let fineView: LibraryFineView | null = null;
      const graceDays = await this.settings.getNumber('library.fine_grace_days');
      const lastFreeDay = addDays(issue.due_date, graceDays);
      if (today > lastFreeDay) {
        const daysLate = diffDays(lastFreeDay, today);
        const perDay = await this.settings.getMoney('library.fine_per_day');
        const amount = perDay.times(daysLate).quantize();
        if (amount.isPositive()) {
          const fine = await this.fines.create(uow, { book_issue_id: issueId, amount: amount.toString(), status: 'unpaid' });
          fineView = toFineView(fine);
        }
      }
      return { issue: toIssueView(updated), fine: fineView };
    });
  }

  async renewBook(actor: Actor, issueId: string): Promise<BookIssueView> {
    return transaction(actor, async (uow) => {
      const issue = await this.issues.getById(uow, issueId);
      if (issue.status !== 'issued') throw new BusinessRuleError('Only a currently-issued book can be renewed.', 'NOT_ISSUED');
      const today = new Date().toISOString().slice(0, 10);
      if (issue.due_date < today) throw new BusinessRuleError('An overdue book must be returned, not renewed.', 'OVERDUE_CANNOT_RENEW');
      const maxRenewals = await this.settings.getNumber('library.max_renewals');
      if (issue.renewal_count >= maxRenewals) {
        throw new BusinessRuleError(`This book has already been renewed the maximum of ${maxRenewals} times.`, 'RENEWAL_LIMIT_REACHED');
      }
      const loanDays = await this.settings.getNumber('library.loan_days');
      return toIssueView(await this.issues.renew(uow, issueId, addDays(issue.due_date, loanDays)));
    });
  }

  async markLost(actor: Actor, issueId: string, input: { replacementCost: string }): Promise<{ issue: BookIssueView; fine: LibraryFineView }> {
    return transaction(actor, async (uow) => {
      const issue = await this.issues.getById(uow, issueId);
      if (issue.status !== 'issued') throw new BusinessRuleError('Only a currently-issued book can be marked lost.', 'NOT_ISSUED');
      const updated = await this.issues.setStatus(uow, issueId, 'lost');
      const fine = await this.fines.create(uow, { book_issue_id: issueId, amount: Money.of(input.replacementCost).quantize().toString(), status: 'unpaid' });
      return { issue: toIssueView(updated), fine: toFineView(fine) };
    });
  }

  /* ---------------- fines ---------------- */

  async waiveFine(actor: Actor, fineId: string, reason: string): Promise<LibraryFineView> {
    return transaction(actor, async (uow) => {
      const fine = await this.fines.getById(uow, fineId);
      if (fine.status !== 'unpaid') throw new BusinessRuleError('Only an unpaid fine can be waived.', 'FINE_NOT_UNPAID');
      return toFineView(await this.fines.setStatus(uow, fineId, 'waived', { waivedReason: reason }));
    });
  }

  async markFinePaid(actor: Actor, fineId: string, paymentId: string): Promise<LibraryFineView> {
    return transaction(actor, async (uow) => {
      const fine = await this.fines.getById(uow, fineId);
      if (fine.status !== 'unpaid') throw new BusinessRuleError('Only an unpaid fine can be marked paid.', 'FINE_NOT_UNPAID');
      const payment = await this.payments.getById(uow, paymentId);
      if (payment.status !== 'valid') throw new BusinessRuleError('The referenced payment is not valid.', 'PAYMENT_NOT_VALID');
      return toFineView(await this.fines.setStatus(uow, fineId, 'paid', { paymentId }));
    });
  }

  /* ---------------- reports ---------------- */

  async overdueReport(actor: Actor) {
    return readTransaction(actor, async (uow) => (await this.issues.overdue(uow)).map((r) => ({ ...toIssueView(r), title: r.title, accessionNo: r.accession_no })));
  }

  async mostBorrowedReport(actor: Actor, limit = 20): Promise<{ bookId: string; title: string; accessionNo: string; timesIssued: number }[]> {
    return readTransaction(actor, async (uow) =>
      (await this.issues.mostBorrowed(uow, limit)).map((r) => ({
        bookId: r.book_id,
        title: r.title,
        accessionNo: r.accession_no,
        timesIssued: r.times_issued,
      })),
    );
  }
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime();
  const to = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}
