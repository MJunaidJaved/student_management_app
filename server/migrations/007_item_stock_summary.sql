-- 007_item_stock_summary.sql
--
-- Proposal 3 in docs/schema-proposals.md, approved. Part 9.4, Module 11.
--
-- True stock is the sum of `stock_movements`, which is append-only and
-- therefore the authority. This table is a cache of that sum, maintained inside
-- the same transaction as each movement, because a stock-on-hand screen that
-- re-aggregates every movement for every item gets slower forever.
--
-- It is a cache, so it can drift — a bug in a handler, a manual correction. The
-- reconciliation job Part 9.4 asks for compares this against
-- SUM(stock_movements) and reports the difference rather than silently
-- overwriting it, because a mismatch is a signal that something wrote stock
-- wrongly, and hiding it loses the evidence.
--
-- The CHECK is a second guard on the thing that must never happen. The real
-- protection is the row lock taken on this row before an outgoing movement is
-- written, which is what serialises two simultaneous issues of the last unit.

-- Up Migration

CREATE TABLE item_stock (
  item_id    bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,

  -- numeric(14,4) to match the movement quantity scale: some items are issued
  -- fractionally (metres of cloth, reams).
  quantity   numeric(14,4) NOT NULL DEFAULT 0,

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT item_stock_non_negative CHECK (quantity >= 0)
);

CREATE TRIGGER trg_item_stock_updated
  BEFORE UPDATE ON item_stock
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The low-stock alert job joins this against items.reorder_level, so ordering
-- by quantity is the access pattern.
CREATE INDEX item_stock_quantity_idx ON item_stock (quantity);

COMMENT ON TABLE item_stock IS
  'Cached sum of stock_movements per item, maintained in the same transaction as each movement. stock_movements remains the authority; a reconciliation job reports drift.';

-- Down Migration

DROP TABLE IF EXISTS item_stock;
