/**
 * The one success envelope and the one error envelope (Part 5.3).
 *
 * Every response carries the request id, so a report from a user ("it failed at
 * about eleven") can be tied to exactly one log line.
 */

export type Envelope<T> = {
  data: T;
  meta: ResponseMeta;
};

export type ResponseMeta = {
  requestId: string;
  /** Present on list responses only. */
  page?: PageMeta;
  /** Set by endpoints served from a summary table, so a client can say how fresh it is. */
  lastRefreshedAt?: string;
};

export type PageMeta = {
  /** Opaque; pass back as `cursor` to continue. Null when there is no next page. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  /**
   * Only present when the caller asked for it with `withTotal=true`.
   *
   * Counting is a full scan on attendance, payments and audit logs, so it is
   * opt-in rather than always paid for (Part 5.5).
   */
  total?: number;
};

export type ErrorEnvelope = {
  error: {
    /** Machine-readable, from the AppError subclass. */
    code: string;
    /** Safe to display. */
    message: string;
    /** Field-level detail on a 422. */
    issues?: { field: string; message: string }[];
  };
  meta: { requestId: string };
};

export const ok = <T>(data: T, requestId: string, extra: Omit<ResponseMeta, 'requestId'> = {}): Envelope<T> => ({
  data,
  meta: { requestId, ...extra },
});

export type Page<T> = { items: T[]; page: PageMeta };
