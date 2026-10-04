/**
 * The service base class (Part 4.2).
 *
 * Provides CRUD delegation, before/after hooks (Template Method), transaction
 * handling and consistent not-found behaviour, so a concrete service writes
 * only the rules that are actually specific to it.
 *
 * Two deliberate constraints:
 *
 *   * **Every method takes an `Actor`.** There is no ambient "current user";
 *     the actor is passed explicitly into `transaction()` so the database
 *     session variables the audit triggers read cannot be wrong or absent.
 *
 *   * **Hooks run inside the transaction.** `beforeCreate` validating against a
 *     row it read in a different transaction would be checking a snapshot that
 *     has already moved on, which is how a uniqueness check passes and the
 *     insert then fails.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../db/uow';
import type { BaseRepository, BaseRow, Id, ListOptions } from './base-repository';
import type { ConditionBuilder } from '../db/query-builder';
import { decodeCursor, type SortDirection } from '../db/query-builder';
import type { PageMeta } from '../http/envelope';

/** What a list endpoint sends in, before it becomes repository options. */
export type ListRequest = {
  cursor?: string | undefined;
  limit?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: SortDirection | undefined;
  includeDeleted?: boolean | undefined;
};

export abstract class BaseService<TRow extends BaseRow, TView = TRow> {
  protected abstract readonly repository: BaseRepository<TRow>;

  /** Default sort key, used to validate an incoming cursor. */
  protected abstract readonly defaultSortKey: string;

  /**
   * Row to API shape. Part 4 forbids returning raw database rows, so this is
   * abstract rather than defaulting to identity — a service has to decide.
   */
  protected abstract toView(row: TRow): TView;

  /* ---------------- hooks (Template Method) ---------------- */

  /** Validate or enrich before an insert. Throw to reject. */
  protected async beforeCreate(
    _uow: Uow,
    _actor: Actor,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return data;
  }

  protected async afterCreate(_uow: Uow, _actor: Actor, _row: TRow): Promise<void> {}

  protected async beforeUpdate(
    _uow: Uow,
    _actor: Actor,
    _existing: TRow,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return data;
  }

  protected async afterUpdate(_uow: Uow, _actor: Actor, _row: TRow): Promise<void> {}

  /** Refuse a delete that would orphan live data. Throw to reject. */
  protected async beforeDelete(_uow: Uow, _actor: Actor, _existing: TRow): Promise<void> {}

  /**
   * Per-record scope check.
   *
   * Default is open, because most reference tables (classes, subjects, rooms)
   * have no per-record scope — access is decided entirely by the permission.
   * Anything holding personal data overrides this, and its route declares an
   * ownership policy other than 'none'.
   */
  protected async assertCanAccess(_uow: Uow, _actor: Actor, _row: TRow): Promise<void> {}

  /* ---------------- operations ---------------- */

  async getById(actor: Actor, id: Id): Promise<TView> {
    return readTransaction(actor, async (uow) => {
      const row = await this.repository.getById(uow, id);
      await this.assertCanAccess(uow, actor, row);
      return this.toView(row);
    });
  }

  async list(
    actor: Actor,
    request: ListRequest = {},
    filters?: ConditionBuilder,
  ): Promise<{ items: TView[]; page: PageMeta }> {
    return readTransaction(actor, async (uow) => {
      const options: ListOptions = {
        limit: request.limit,
        sortBy: request.sortBy,
        sortDir: request.sortDir,
        includeDeleted: request.includeDeleted,
        // Decoded here rather than in the repository so a cursor built for a
        // different sort is rejected before any query runs.
        cursor: request.cursor
          ? decodeCursor(request.cursor, request.sortBy ?? this.defaultSortKey)
          : undefined,
      };

      const result = await this.repository.listPage(uow, options, filters);
      return {
        items: result.items.map((row) => this.toView(row)),
        page: {
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          limit: options.limit ?? 25,
        },
      };
    });
  }

  async create(actor: Actor, data: Record<string, unknown>): Promise<TView> {
    return transaction(actor, async (uow) => {
      const prepared = await this.beforeCreate(uow, actor, data);
      const row = await this.repository.create(uow, prepared);
      await this.afterCreate(uow, actor, row);
      return this.toView(row);
    });
  }

  /**
   * Update by id.
   *
   * `expectedUpdatedAt` is the optimistic-concurrency token from Part 9.5. When
   * the caller supplies one, a change since they read the record is a 409
   * rather than a silent overwrite of someone else's edit.
   */
  async update(
    actor: Actor,
    id: Id,
    data: Record<string, unknown>,
    expectedUpdatedAt?: string,
  ): Promise<TView> {
    return transaction(actor, async (uow) => {
      const existing = await this.repository.getById(uow, id);
      await this.assertCanAccess(uow, actor, existing);

      const prepared = await this.beforeUpdate(uow, actor, existing, data);
      const row = await this.repository.update(uow, id, prepared, expectedUpdatedAt);
      await this.afterUpdate(uow, actor, row);
      return this.toView(row);
    });
  }

  async softDelete(actor: Actor, id: Id): Promise<void> {
    await transaction(actor, async (uow) => {
      const existing = await this.repository.getById(uow, id);
      await this.assertCanAccess(uow, actor, existing);
      await this.beforeDelete(uow, actor, existing);
      await this.repository.softDelete(uow, id);
    });
  }

  async restore(actor: Actor, id: Id): Promise<TView> {
    return transaction(actor, async (uow) => {
      const row = await this.repository.restore(uow, id);
      return this.toView(row);
    });
  }
}
