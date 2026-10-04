# Milk POS removal list (Part 3 / Phase 2 deliverable)

**Nothing here has been deleted.** This is the list for your approval. Per
decision 6, removal happens in one separate commit on
`feat/school-management-backend` after Phase 2 is finished, so the old code
stays recoverable in git history.

Counts: **61 source files** across four directories, plus 3 dependency entries
and 1 build script. Frontend file counts are directory totals; those two trees
are entirely POS UI.

---

## 1. Delete outright — till backend (`backend/`, 38 files)

Every file is milk-domain or till-licensing. Nothing here is reused.

| Path | What it is |
|---|---|
| `backend/app.js`, `server.js` | Express app for the till |
| `backend/db/database.js`, `schema.js` | SQLite schema and connection (milk tables) |
| `backend/db/activation-config.js`, `cloud-config.js`, `cloud-http.js` | Product-key licensing and cloud pairing |
| `backend/middleware/auth.js` | In-memory session Map |
| `backend/routes/activation.js`, `admin.js`, `catalog.js`, `finance.js`, `inventory.js`, `sales.js`, `staff.js` | Till HTTP routes |
| `backend/services/` (15 files) | `products`, `categories`, `stock`, `suppliers`, `deals`, `orders`, `credit`, `customers`, `expenses`, `expiry`, `reports`, `settings`, `shifts`, `staff` |
| `backend/sync/client.js`, `payload.js` | Till-to-cloud sync |
| `backend/scripts/rebuild-native.js`, `run-backend.js`, `run-script.js` | better-sqlite3 native rebuild helpers |
| `backend/package.json`, `.npmrc.bak` | Till package manifest |

**Ported before deletion, already done:** `db/errors.js` and `db/validate.js`
informed `core/errors` and `core/http/validate.ts`; `db/phone.js` informed the
phone normalisation in `core/http/validate.ts`. Reviewed, rewritten, not copied
— the originals used binary floats for money.

## 2. Delete outright — cloud API (`cloud/`, 22 files)

Superseded by `server/`.

| Path | What it is |
|---|---|
| `cloud/app.js`, `server.js` | Express app for the dashboard API |
| `cloud/db/schema.js`, `ensure-schema.js` | Milk cloud schema (branches, tills, sales) |
| `cloud/db/product-key.js` | Licence key issuing |
| `cloud/middleware/session.js`, `till-auth.js` | Cookie sessions and till API-key auth |
| `cloud/routes/activation.js`, `auth.js`, `ingest.js`, `ping.js`, `read.js` | Cloud endpoints |
| `cloud/scripts/issue-key.js`, `provision.js` | Licence provisioning |
| `cloud/package.json`, `package-lock.json`, `README.md`, `.gitignore` | Cloud manifests |

**Ported, already done:** `cloud/db/pg.js` → `core/db/pool.ts` (pool setup, the
checkout-not-connect reasoning, `extra_float_digits`); `cloud/env.js` →
`core/config/index.ts` (rewritten with startup validation). The `?`→`$n`
translator was deliberately dropped as a SQLite-era crutch.

⚠️ **`cloud/.env` holds the live database password.** It is gitignored and was
never committed. Delete the file from disk, do not just untrack it.
`server/.env` now carries the same `DATABASE_URL`.

## 3. Delete outright — POS user interfaces

| Path | Notes |
|---|---|
| `frontend/` | Electron till UI (React + Vite). Entirely POS. |
| `dashboard/` | React owner dashboard (branches, sales, payroll screens). Entirely POS. |

**Worth porting first — please confirm:** `frontend/electron/escpos-receipt.js`
and `print-raw-windows.js` are thermal-printer receipt code. Module 5 wants a
"thermal-printer-friendly format, reusing the idea from the old POS" for fee
receipts. I propose copying these two into `server/src/modules/fees/printing/`
during Phase 5 **before** the frontend tree is deleted. They are the only files
in either UI tree I would keep.

## 4. Root manifest and dependencies

`POS/package.json` is named `milk-pos-railway` and its scripts build
`dashboard` and `cloud`. Needs rewriting to point at `server/`.

Dependencies that leave with the code: `better-sqlite3`, `pdfkit`,
`node-fetch`, `form-data`, `nodemon`, `@electron/rebuild`, `electron-rebuild`,
`cors` (the new server uses the `cors` package too, so this one stays in
`server/package.json`).

`postinstall: node scripts/rebuild-native.js` goes away with better-sqlite3 —
that script is the source of the native-build fragility on Windows.

## 5. Not touched

- `POS/.git`, `POS/.gitignore` — the `.gitignore` needs its milk-specific
  entries pruned (`backend/cloud-sync.json`, `backend/activation.json`,
  `backend/device-id.json`, `backend/.simulated-till/`, the SQLite patterns) but
  the file itself stays.
- `POS/docs/`, `POS/server/` — the new work.

## 6. Database

No action. The Supabase database contains **only** the 85 school tables; no
milk tables were ever present in it. The milk schema lived in each till's local
SQLite file, which is not in this repository. Old migrations do not exist —
`001_baseline.sql` is the first.

---

## Proposed order

1. Phase 5: port the two receipt-printing files into the fees module.
2. Phase 5 onward, after that port: delete `frontend/` and `dashboard/`.
3. After Phase 2 (now, on approval): delete `backend/` and `cloud/`, rewrite the
   root `package.json`, prune `.gitignore`, and manually delete `cloud/.env`
   from disk.

Splitting it this way means nothing is deleted before the thing that needed it
has been ported.

## What I need from you

1. **Approve the list**, or tell me what to keep.
2. **Confirm the receipt-printing port** — otherwise those two files go with the
   rest and Module 5 gets a plain PDF receipt only.
3. **Confirm the till and dashboard are truly dead.** Deleting `backend/` breaks
   any installed till that still syncs, and deleting `dashboard/` takes down the
   deployed owner dashboard if it is still running anywhere.
