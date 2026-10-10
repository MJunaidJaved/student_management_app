/**
 * API tests for inventory (Section 5, Module 11).
 *
 * Runs against the real database. Stock correctness is the point: every
 * movement here checks the actual recorded quantity, not just the HTTP
 * status, and the concurrency test exercises the same two simultaneous
 * requests a real double-click or retry would send.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_inventory__', password: 'InventoryPassw0rd!2026' };
const NOBODY = { username: '__apitest_inventory_nobody__', password: 'InventoryPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let token: string;
let nobodyToken: string;
const userIds: string[] = [];

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeUser(creds: { username: string; password: string }, roleName: string | null): Promise<string> {
  return transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(creds.password);
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [creds.username]);
    const id = existing
      ? (await uow.one<{ id: string }>(`UPDATE users SET password_hash = $2, is_active = true, must_change_password = false, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING id::text AS id`, [existing.id, hash])).id
      : (await uow.one<{ id: string }>(`INSERT INTO users (username, password_hash, user_type, must_change_password, is_active) VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`, [creds.username, hash])).id;
    await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
    if (roleName) await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [id, roleName]);
    return id;
  });
}

async function login(creds: { username: string; password: string }): Promise<string> {
  const res = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: creds });
  if (res.status !== 200) throw new Error(`Login failed for ${creds.username}: ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  userIds.push(await makeUser(ADMIN, SUPER_ADMIN_ROLE));
  userIds.push(await makeUser(NOBODY, null));
  token = await login(ADMIN);
  nobodyToken = await login(NOBODY);
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    for (const id of userIds) {
      await uow.count(`UPDATE users SET is_active = false WHERE id = $1`, [id]);
      await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
    }
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('Inventory API', () => {
  let categoryId: string;
  let itemId: string;
  // items.sku is unique and these rows are never cleaned up (stock_movements
  // and purchase_orders reference them, same "permanent fixture" reasoning
  // as fees.api.test.ts's own undeletable rows) — a fresh suffix per run
  // keeps a second run from colliding on the first run's SKU.
  const runSuffix = Date.now().toString(36);

  it('denies catalog reads to a caller without inventory.read', async () => {
    const res = await call('/api/v1/item-categories', { token: nobodyToken });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request before any business logic runs', async () => {
    const res = await fetch(`${baseUrl}/api/v1/items`);
    expect(res.status).toBe(401);
  });

  it('creates a category and an item with zero starting stock', async () => {
    const cat = await call('/api/v1/item-categories', { method: 'POST', body: { name: `__apitest Stationery ${runSuffix}` } });
    expect(cat.status, JSON.stringify(cat.body)).toBe(201);
    categoryId = cat.body.data.id;

    const item = await call('/api/v1/items', {
      method: 'POST',
      body: { sku: `__APITEST-SKU-1-${runSuffix}`, name: '__apitest Notebook', categoryId, unit: 'pcs', reorderLevel: '5' },
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    itemId = item.body.data.id;
    expect(item.body.data.stockQuantity).toBe('0');
  });

  it('rejects issuing stock that does not exist yet (insufficient stock)', async () => {
    const res = await call('/api/v1/stock/issue', { method: 'POST', body: { itemId, quantity: '1' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('receives a purchase order and raises stock, recorded as a movement', async () => {
    const supplier = await call('/api/v1/suppliers', { method: 'POST', body: { name: '__apitest Supplier' } });
    const po = await call('/api/v1/purchase-orders', {
      method: 'POST',
      body: { supplierId: supplier.body.data.id, orderDate: '2026-01-01', items: [{ itemId, quantity: '10', unitCost: '2.50' }] },
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const ordered = await call(`/api/v1/purchase-orders/${po.body.data.id}/mark-ordered`, { method: 'POST' });
    expect(ordered.status).toBe(200);

    const received = await call(`/api/v1/purchase-orders/${po.body.data.id}/receive`, {
      method: 'POST',
      body: { items: [{ itemId, quantity: '10' }] },
    });
    expect(received.status, JSON.stringify(received.body)).toBe(200);
    expect(received.body.data.fullyReceived).toBe(true);

    const movements = await call(`/api/v1/items/${itemId}/movements`);
    expect(movements.status).toBe(200);
    expect(movements.body.data.movements.some((m: { type: string; quantity: string }) => m.type === 'in' && Number(m.quantity) === 10)).toBe(true);
  });

  it('issues stock within the available quantity and records the movement', async () => {
    const res = await call('/api/v1/stock/issue', { method: 'POST', body: { itemId, quantity: '3' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number(res.body.data.quantity)).toBe(7);
  });

  it('refuses to issue more stock than is on hand', async () => {
    const res = await call('/api/v1/stock/issue', { method: 'POST', body: { itemId, quantity: '100' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    // The failed attempt must not have changed anything.
    const movements = await call(`/api/v1/items/${itemId}/movements`);
    const total = movements.body.data.movements.reduce((sum: number, m: { type: string; quantity: string }) => sum + (m.type === 'out' ? -Number(m.quantity) : Number(m.quantity)), 0);
    expect(total).toBe(7);
  });

  it('rejects a zero-delta stock adjustment as a validation error, not a silent no-op', async () => {
    const res = await call('/api/v1/stock/adjust', { method: 'POST', body: { itemId, quantityDelta: '0', reason: 'test' } });
    expect(res.status).toBe(422);
  });

  it('allows two concurrent issue requests against stock for exactly one, never driving it negative', async () => {
    // Fresh item with exactly 1 unit, so the two concurrent requests below
    // are a genuine race for the same last unit, not two independent draws.
    const raceItem = await call('/api/v1/items', { method: 'POST', body: { sku: `__APITEST-SKU-RACE-${runSuffix}`, name: '__apitest Race Item', categoryId, unit: 'pcs', reorderLevel: '0' } });
    const raceItemId = raceItem.body.data.id;
    const supplier = await call('/api/v1/suppliers', { method: 'POST', body: { name: '__apitest Race Supplier' } });
    const po = await call('/api/v1/purchase-orders', { method: 'POST', body: { supplierId: supplier.body.data.id, orderDate: '2026-01-01', items: [{ itemId: raceItemId, quantity: '1', unitCost: '1.00' }] } });
    await call(`/api/v1/purchase-orders/${po.body.data.id}/mark-ordered`, { method: 'POST' });
    await call(`/api/v1/purchase-orders/${po.body.data.id}/receive`, { method: 'POST', body: { items: [{ itemId: raceItemId, quantity: '1' }] } });

    const [a, b] = await Promise.all([
      call('/api/v1/stock/issue', { method: 'POST', body: { itemId: raceItemId, quantity: '1' } }),
      call('/api/v1/stock/issue', { method: 'POST', body: { itemId: raceItemId, quantity: '1' } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 422]);

    const movements = await call(`/api/v1/items/${raceItemId}/movements`);
    const outCount = movements.body.data.movements.filter((m: { type: string }) => m.type === 'out').length;
    expect(outCount).toBe(1);

    const reconcile = await call('/api/v1/stock/reconcile');
    const drift = reconcile.body.data.drift.find((d: { itemId: string }) => d.itemId === raceItemId);
    expect(drift === undefined || drift.cached === drift.computed).toBe(true);
  });

  it('denies issuing stock to a caller without inventory.issue_stock', async () => {
    const res = await call('/api/v1/stock/issue', { token: nobodyToken, method: 'POST', body: { itemId, quantity: '1' } });
    expect(res.status).toBe(403);
  });

  it('flags a low-stock item once it is at or below its reorder level', async () => {
    const res = await call('/api/v1/items/low-stock');
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((i: { id: string }) => i.id === itemId)).toBe(false); // 7 > reorder level 5
    await call('/api/v1/stock/issue', { method: 'POST', body: { itemId, quantity: '3' } }); // down to 4
    const after = await call('/api/v1/items/low-stock');
    expect(after.body.data.items.some((i: { id: string }) => i.id === itemId)).toBe(true);
  });
});
