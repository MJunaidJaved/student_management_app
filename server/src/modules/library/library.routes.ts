import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, text } from '../../core/http/validate';
import { handler, actorOf, created, okBody } from '../../core/base/base-controller';
import type { LibraryService } from './library.service';

const idSchema = { params: z.object({ id: idParam }).strict() };
const page = { limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().optional() };

const categoryBody = z.object({ name: text(80) }).strict();
const bookBody = z.object({
  accessionNo: text(40), isbn: text(20).optional(), title: text(200), author: text(120).optional(),
  categoryId: idParam.optional(), copiesTotal: z.coerce.number().int().min(1).max(10_000), shelfLocation: text(60).optional(),
}).strict();
const booksListQuery = z.object({ ...page, categoryId: idParam.optional(), q: text(120).optional() }).strict();

const issueBody = z.object({ bookId: idParam, borrowerType: z.enum(['student', 'staff']), borrowerId: idParam }).strict();
const borrowerParams = { params: z.object({ type: z.enum(['student', 'staff']), id: idParam }).strict() };

const lostBody = z.object({ replacementCost: z.union([z.string(), z.number()]).transform((v) => (typeof v === 'number' ? v.toString() : v.trim())).refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Must be a positive amount, at most 2 decimal places.') }).strict();
const waiveBody = z.object({ reason: text(300) }).strict();
const markPaidBody = z.object({ paymentId: idParam }).strict();
const reduceCopiesBody = z.object({ by: z.coerce.number().int().min(1).max(10_000) }).strict();

export function libraryRoutes(library: LibraryService): RouteDeclaration[] {
  return [
    /* ---------------- categories and catalog ---------------- */
    { method: 'get', path: '/book-categories', summary: 'List book categories', permission: 'library.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ categories: await library.listCategories(actorOf(req)) })) },
    {
      method: 'post', path: '/book-categories', summary: 'Create a book category', permission: 'library.manage_catalog', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: categoryBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof categoryBody }>(req); return created(await library.createCategory(actorOf(req), body)); }),
    },
    {
      method: 'get', path: '/books', summary: 'Search the book catalog', permission: 'library.read', ownership: 'none', rateLimit: 'search',
      schemas: { query: booksListQuery },
      handler: handler(async (req) => {
        const { query } = validated<{ query: typeof booksListQuery }>(req);
        return okBody(await library.searchBooks(actorOf(req), { categoryId: query.categoryId, q: query.q }, { limit: query.limit, cursorId: query.cursor }));
      }),
    },
    {
      method: 'post', path: '/books', summary: 'Add a book to the catalog', permission: 'library.manage_catalog', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: bookBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof bookBody }>(req); return created(await library.createBook(actorOf(req), body)); }),
    },
    {
      method: 'post', path: '/books/:id/reduce-copies', summary: 'Explicitly reduce a book’s total copies (after a loss)', permission: 'library.manage_catalog', ownership: 'none', rateLimit: 'userStandard',
      schemas: { ...idSchema, body: reduceCopiesBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof reduceCopiesBody }>(req); return okBody(await library.reduceBookCopies(actorOf(req), params.id, body.by)); }),
      errors: ['TOO_FEW_COPIES'],
    },

    /* ---------------- self-service ---------------- */
    { method: 'get', path: '/book-issues/mine', summary: 'My currently and previously issued books', permission: 'library.read_own', ownership: 'self-only', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ issues: await library.myIssues(actorOf(req)) })) },
    { method: 'get', path: '/library-fines/mine', summary: 'My library fines', permission: 'library.read_own', ownership: 'self-only', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ fines: await library.myFines(actorOf(req)) })) },
    {
      method: 'get', path: '/borrowers/:type/:id/book-issues', summary: "A borrower's issue history (self, a guardian of a student borrower, or a library.read holder)",
      permission: 'library.read_own', ownership: 'guardian-children', rateLimit: 'userStandard',
      schemas: borrowerParams,
      handler: handler(async (req) => {
        const { params } = validated<typeof borrowerParams>(req);
        return okBody({ issues: await library.issuesForBorrower(actorOf(req), params.type, params.id) });
      }),
    },
    {
      method: 'get', path: '/borrowers/:type/:id/library-fines', summary: "A borrower's fines (self, a guardian of a student borrower, or a library.read holder)",
      permission: 'library.read_own', ownership: 'guardian-children', rateLimit: 'userStandard',
      schemas: borrowerParams,
      handler: handler(async (req) => {
        const { params } = validated<typeof borrowerParams>(req);
        return okBody({ fines: await library.finesForBorrower(actorOf(req), params.type, params.id) });
      }),
    },

    /* ---------------- issue, return, renew, lose ---------------- */
    {
      method: 'post', path: '/book-issues', summary: 'Issue a book to a borrower', permission: 'library.issue', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: issueBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof issueBody }>(req); return created(await library.issueBook(actorOf(req), body)); }),
      errors: ['NO_COPIES_AVAILABLE', 'BORROWING_LIMIT_REACHED', 'HAS_OVERDUE_BOOK', 'HAS_UNPAID_FINE'],
    },
    {
      method: 'post', path: '/book-issues/:id/return', summary: 'Mark a book returned, fining it if late', permission: 'library.return', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await library.returnBook(actorOf(req), params.id)); }),
      errors: ['NOT_ISSUED'],
    },
    {
      method: 'post', path: '/book-issues/:id/renew', summary: 'Renew an issued book', permission: 'library.renew', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await library.renewBook(actorOf(req), params.id)); }),
      errors: ['NOT_ISSUED', 'OVERDUE_CANNOT_RENEW', 'RENEWAL_LIMIT_REACHED'],
    },
    {
      method: 'post', path: '/book-issues/:id/mark-lost', summary: 'Mark an issued book lost and create its replacement fine', permission: 'library.mark_lost', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: lostBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof lostBody }>(req); return okBody(await library.markLost(actorOf(req), params.id, body)); }),
      errors: ['NOT_ISSUED'],
    },

    /* ---------------- fines ---------------- */
    {
      method: 'post', path: '/library-fines/:id/waive', summary: 'Waive an unpaid library fine', permission: 'library.manage_fines', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: waiveBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof waiveBody }>(req); return okBody(await library.waiveFine(actorOf(req), params.id, body.reason)); }),
      errors: ['FINE_NOT_UNPAID'],
    },
    {
      method: 'post', path: '/library-fines/:id/mark-paid', summary: 'Link an existing, valid fee payment to an unpaid library fine', permission: 'library.manage_fines', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: markPaidBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof markPaidBody }>(req); return okBody(await library.markFinePaid(actorOf(req), params.id, body.paymentId)); }),
      errors: ['FINE_NOT_UNPAID', 'PAYMENT_NOT_VALID'],
    },

    /* ---------------- reports ---------------- */
    { method: 'get', path: '/reports/library/overdue', summary: 'Currently overdue issues', permission: 'library.read_reports', ownership: 'none', rateLimit: 'expensive', handler: handler(async (req) => okBody({ overdue: await library.overdueReport(actorOf(req)) })) },
    { method: 'get', path: '/reports/library/most-borrowed', summary: 'Most borrowed books', permission: 'library.read_reports', ownership: 'none', rateLimit: 'expensive', handler: handler(async (req) => okBody({ books: await library.mostBorrowedReport(actorOf(req)) })) },
  ];
}
