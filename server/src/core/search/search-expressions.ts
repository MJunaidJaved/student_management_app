/**
 * The exact SQL expressions the search indexes are built on.
 *
 * An expression index is only used when a query repeats the expression
 * character for character. Postgres will not recognise
 * `lower(first_name || ' ' || last_name)` as matching an index on
 * `lower(first_name || ' ' || coalesce(last_name, ''))` — it plans a
 * sequential scan instead, silently. Nothing fails; search simply gets slower
 * every year as the school grows, and the cause is invisible in the code.
 *
 * So the expressions live here, once, and every query interpolates them from
 * these constants rather than retyping them. If one is changed, the matching
 * migration has to change with it — which is the point: the coupling is real,
 * so it is made visible instead of being left as a trap.
 *
 * Verified against migration 003 by the test beside this file.
 */

/**
 * A student's searchable name.
 *
 * `students` has no `full_name` column: it has `first_name` and a NULLABLE
 * `last_name`. The `coalesce` is what makes the concatenation safe — without
 * it, any student with no surname produces NULL and drops out of every name
 * search entirely.
 *
 * Backing indexes: `students_name_trgm_idx` (gin_trgm_ops, contains/fuzzy) and
 * `students_name_prefix_idx` (text_pattern_ops, typeahead).
 */
export const STUDENT_NAME_EXPR = `lower(first_name || ' ' || coalesce(last_name, ''))`;

/** Backing: `guardians_name_trgm_idx`, `guardians_name_prefix_idx`. */
export const GUARDIAN_NAME_EXPR = `lower(full_name)`;

/** Backing: `staff_name_trgm_idx`, `staff_name_prefix_idx`. */
export const STAFF_NAME_EXPR = `lower(full_name)`;

/** Backing: `books_title_trgm_idx`, `books_title_prefix_idx`. */
export const BOOK_TITLE_EXPR = `lower(title)`;

/** Backing: `books_author_trgm_idx`. Author is nullable, hence the coalesce. */
export const BOOK_AUTHOR_EXPR = `lower(coalesce(author, ''))`;

/**
 * Normalise a name for comparison against the indexed expressions.
 *
 * Trim, collapse internal whitespace, case-fold (Part 9.4). "  Ali   Hassan "
 * and "ali hassan" must find the same student, and the index stores the folded
 * form, so the search term has to be folded the same way.
 */
export function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Escape a user's search term for use inside a LIKE pattern.
 *
 * Without this, a term containing `%` matches everything and `_` matches any
 * character — a caller typing "50%" would scan the table. The backslash is
 * escaped first, or it would double-escape the escapes added after it.
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/[%_]/g, (c) => `\\${c}`);
}

/** `term%` — a prefix pattern for typeahead, safe for LIKE. */
export const prefixPattern = (term: string): string => `${escapeLike(normalizeName(term))}%`;

/** `%term%` — a contains pattern; needs a trigram index to be affordable. */
export const containsPattern = (term: string): string => `%${escapeLike(normalizeName(term))}%`;

/**
 * Classify a search term so a unified search can try the cheapest index first
 * (Part 9.1).
 *
 * Order matters. The tests are applied most-specific first, because a national
 * ID is all digits and so is a phone number — checking "looks numeric" before
 * "looks like a phone" would route every ID to a phone lookup.
 */
export type SearchTermKind = 'admission_no' | 'phone' | 'national_id' | 'name';

export function classifySearchTerm(raw: string): SearchTermKind {
  const term = raw.trim();

  // Admission and employee numbers in this schema carry a non-digit prefix or
  // separator (for example "2026-0413"), which is what distinguishes them.
  if (/^[A-Za-z]{1,6}[-/]?\d{2,}$/.test(term) || /^\d{4}-\d{2,}$/.test(term)) {
    return 'admission_no';
  }

  const digits = term.replace(/[\s()+-]/g, '');

  // Pakistani CNIC is 13 digits; phone numbers here are 10-12 with a leading 0
  // or country code. 13 digits is checked first because it is unambiguous.
  if (/^\d{13}$/.test(digits)) return 'national_id';
  if (/^\d{10,12}$/.test(digits)) return 'phone';

  return 'name';
}
