/**
 * Library (Module 12) data access.
 *
 * Availability is `copies_total` minus currently-issued copies (Part 9.4),
 * checked with a lock on the `books` row before an issue is written — there
 * is no per-book stock summary table the way inventory has `item_stock`, so
 * the book row itself is what gets locked.
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder, type SortMap } from '../../core/db/query-builder';

/* ------------------------------------------------------------------ *
 * Categories and books
 * ------------------------------------------------------------------ */

export type BookCategoryRow = BaseRow & { name: string };

export class BookCategoryRepository extends BaseRepository<BookCategoryRow> {
  protected readonly table = 'book_categories';
  protected readonly writableColumns = ['name'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'book_categories.name', index: 'book_categories_pkey' } };

  async listAll(uow: Uow): Promise<BookCategoryRow[]> {
    return uow.many<BookCategoryRow>(`SELECT * FROM book_categories ORDER BY name`);
  }
}

export type BookRow = BaseRow & {
  accession_no: string;
  isbn: string | null;
  title: string;
  author: string | null;
  category_id: string | null;
  copies_total: number;
  shelf_location: string | null;
  deleted_at: string | null;
};

export class BookRepository extends BaseRepository<BookRow> {
  protected readonly table = 'books';
  protected readonly writableColumns = ['accession_no', 'isbn', 'title', 'author', 'category_id', 'copies_total', 'shelf_location'] as const;
  protected readonly defaultSort = 'title';
  protected readonly sortable: SortMap = { title: { column: 'books.title', index: 'books_pkey' } };

  /** Locked ahead of writing an issue, so two concurrent issues of the last copy cannot both succeed (Part 9.5). */
  async lockForUpdate(uow: Uow, id: string): Promise<BookRow> {
    return uow.one<BookRow>(`SELECT * FROM books WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id], 'Book');
  }

  async currentlyIssuedCount(uow: Uow, bookId: string): Promise<number> {
    const row = await uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM book_issues WHERE book_id = $1 AND status = 'issued'`, [bookId]);
    return row.n;
  }

  /** Trigram/prefix search by title, author, ISBN or accession number (Part 9.1). */
  async search(
    uow: Uow,
    filters: { categoryId?: string | undefined; q?: string | undefined },
    page: { limit: number; cursorId?: string | undefined },
  ): Promise<(BookRow & { category_name: string | null; issued_count: number })[]> {
    const where = new ConditionBuilder();
    where.add('b.deleted_at IS NULL');
    where.addIf(filters.categoryId, 'b.category_id = ?', filters.categoryId);
    if (filters.q) {
      const pattern = `%${filters.q}%`;
      where.add('(b.title ILIKE ? OR b.author ILIKE ? OR b.isbn = ? OR b.accession_no = ?)', pattern, pattern, filters.q, filters.q);
    }
    if (page.cursorId) where.add('b.id < ?::bigint', page.cursorId);
    return uow.many(
      `SELECT b.*, bc.name AS category_name,
              (SELECT count(*)::int FROM book_issues bi WHERE bi.book_id = b.id AND bi.status = 'issued') AS issued_count
         FROM books b LEFT JOIN book_categories bc ON bc.id = b.category_id
        ${where.where()}
        ORDER BY b.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  async reduceCopies(uow: Uow, id: string, by: number): Promise<BookRow> {
    return uow.one<BookRow>(`UPDATE books SET copies_total = copies_total - $2 WHERE id = $1 RETURNING *`, [id, by], 'Book');
  }
}

/* ------------------------------------------------------------------ *
 * Issues and fines
 * ------------------------------------------------------------------ */

export type BookIssueRow = BaseRow & {
  book_id: string;
  borrower_type: string;
  student_id: string | null;
  staff_id: string | null;
  issue_date: string;
  due_date: string;
  return_date: string | null;
  status: string;
  renewal_count: number;
};

export class BookIssueRepository extends BaseRepository<BookIssueRow> {
  protected readonly table = 'book_issues';
  protected readonly writableColumns = ['book_id', 'borrower_type', 'student_id', 'staff_id', 'issue_date', 'due_date', 'return_date', 'status', 'renewal_count'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'book_issues.id', index: 'book_issues_pkey' } };

  async currentlyIssuedForBorrower(uow: Uow, borrowerType: 'student' | 'staff', borrowerId: string): Promise<BookIssueRow[]> {
    const column = borrowerType === 'student' ? 'student_id' : 'staff_id';
    return uow.many<BookIssueRow>(`SELECT * FROM book_issues WHERE ${column} = $1 AND status = 'issued' ORDER BY due_date`, [borrowerId]);
  }

  async listForBorrower(uow: Uow, borrowerType: 'student' | 'staff', borrowerId: string): Promise<(BookIssueRow & { title: string; accession_no: string })[]> {
    const column = borrowerType === 'student' ? 'student_id' : 'staff_id';
    return uow.many(
      `SELECT bi.*, b.title, b.accession_no FROM book_issues bi JOIN books b ON b.id = bi.book_id WHERE bi.${column} = $1 ORDER BY bi.issue_date DESC`,
      [borrowerId],
    );
  }

  async overdue(uow: Uow): Promise<(BookIssueRow & { title: string; accession_no: string })[]> {
    return uow.many(
      `SELECT bi.*, b.title, b.accession_no FROM book_issues bi JOIN books b ON b.id = bi.book_id
        WHERE bi.status = 'issued' AND bi.due_date < CURRENT_DATE
        ORDER BY bi.due_date`,
    );
  }

  async mostBorrowed(uow: Uow, limit: number): Promise<{ book_id: string; title: string; accession_no: string; times_issued: number }[]> {
    return uow.many(
      `SELECT b.id::text AS book_id, b.title, b.accession_no, count(bi.id)::int AS times_issued
         FROM book_issues bi JOIN books b ON b.id = bi.book_id
        GROUP BY b.id, b.title, b.accession_no
        ORDER BY times_issued DESC
        LIMIT $1`,
      [limit],
    );
  }

  async setStatus(uow: Uow, id: string, status: string, extra: { returnDate?: string | undefined } = {}): Promise<BookIssueRow> {
    if (extra.returnDate !== undefined) {
      return uow.one<BookIssueRow>(`UPDATE book_issues SET status = $2, return_date = $3 WHERE id = $1 RETURNING *`, [id, status, extra.returnDate], 'Book issue');
    }
    return uow.one<BookIssueRow>(`UPDATE book_issues SET status = $2 WHERE id = $1 RETURNING *`, [id, status], 'Book issue');
  }

  async renew(uow: Uow, id: string, newDueDate: string): Promise<BookIssueRow> {
    return uow.one<BookIssueRow>(`UPDATE book_issues SET due_date = $2, renewal_count = renewal_count + 1 WHERE id = $1 RETURNING *`, [id, newDueDate], 'Book issue');
  }
}

export type LibraryFineRow = BaseRow & {
  book_issue_id: string;
  amount: string;
  status: string;
  payment_id: string | null;
  waived_reason: string | null;
};

export class LibraryFineRepository extends BaseRepository<LibraryFineRow> {
  protected readonly table = 'library_fines';
  protected readonly writableColumns = ['book_issue_id', 'amount', 'status', 'payment_id', 'waived_reason'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'library_fines.id', index: 'library_fines_pkey' } };

  async forIssue(uow: Uow, bookIssueId: string): Promise<LibraryFineRow[]> {
    return uow.many<LibraryFineRow>(`SELECT * FROM library_fines WHERE book_issue_id = $1 ORDER BY id`, [bookIssueId]);
  }

  async unpaidCountForBorrower(uow: Uow, borrowerType: 'student' | 'staff', borrowerId: string): Promise<number> {
    const column = borrowerType === 'student' ? 'student_id' : 'staff_id';
    const row = await uow.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM library_fines f
         JOIN book_issues bi ON bi.id = f.book_issue_id
        WHERE bi.${column} = $1 AND f.status = 'unpaid'`,
      [borrowerId],
    );
    return row.n;
  }

  async setStatus(uow: Uow, id: string, status: string, extra: { paymentId?: string | undefined; waivedReason?: string | undefined } = {}): Promise<LibraryFineRow> {
    return uow.one<LibraryFineRow>(
      `UPDATE library_fines SET status = $2, payment_id = $3, waived_reason = $4 WHERE id = $1 RETURNING *`,
      [id, status, extra.paymentId ?? null, extra.waivedReason ?? null],
      'Library fine',
    );
  }
}
