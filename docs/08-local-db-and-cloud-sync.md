# Local database and cloud sync

The app runs against a **local PostgreSQL 17.6** (the same version as Supabase).
The Supabase database is a **mirror**: every change committed locally is
replayed onto it in the background. Local reads and writes take
milliseconds; the slow, unreliable link to the cloud only affects how quickly
the mirror catches up, never the app.

## Running the local database

```sh
cd server
npm run db:local -- init     # once: create the cluster + database from DATABASE_URL, start it
npm run db:local -- start    # after a reboot
npm run db:local -- status
npm run migrate:up
```

Binaries live in `~/.local/pg/17` and data in `~/.local/pg/data` (override with
`PG_HOME` / `PG_DATA`). The cluster listens on localhost only, uses password
auth, and runs in UTC.

## How sync works

- Migration `015_sync_changelog` adds a trigger to every table that records each
  row change (whole row images) in `sync_changelog`, inside the same transaction.
  Nothing that rolls back is recorded; nothing that commits is missed.
- `src/core/sync/cloud-sync.ts` (started by the server when `CLOUD_DATABASE_URL`
  is set and `CLOUD_SYNC_ENABLED` is not `false`) drains the log in order, in
  batches of up to 1,000 changes, each applied in one cloud transaction with
  `session_replication_role = replica` (no cloud triggers fire). A batch is
  deleted locally only after the cloud commits, so a crash replays it, and
  replay is idempotent.
- **Bursts**: the log is the queue. A burst of writes or an outage just makes it
  longer; repeated changes to the same row inside a batch are merged. Only
  changes from finished transactions are taken, never past the oldest
  unfinished one, so ordering is preserved.
- Failures are retried with backoff (1 s → 60 s); a batch is never skipped.
  While the two databases are on different migrations the worker pauses.
- Tested locally against a mirror database: 16 concurrent writers
  (10,000+ changes), a long transaction, a unique-key swap, rollbacks and a full
  `TRUNCATE` of every table all replicate to an identical copy.

New tables added by a later migration must end with
`SELECT sync_install_triggers();`.

## Tools

```sh
npm run sync -- status     # pending changes; migrations on both sides
npm run sync -- verify     # row counts + checksums of every table on both sides
npm run sync -- drain      # push everything pending now
npm run sync -- pull       # replace ALL local data with the cloud's
npm run sync -- push-full  # replace ALL cloud data with the local's
```

## Initialising the cloud mirror

Schema changes are not replicated, so the cloud needs the same migrations, then
one full copy:

```sh
npm run migrate:up -- --cloud
npm run sync -- push-full
npm run sync -- verify
```

Then set `CLOUD_SYNC_ENABLED=true` (or remove the line) in `server/.env` and
restart the server.

## Demo data

`npm run seed:school` (with `SUPER_ADMIN_PASSWORD` set) builds a complete
school, The Junior Cambridge School, Nari, through the real API: classes 1–10
with sections A and B, 130 students, 35 staff, timetable, attendance, fees,
exams, payroll, inventory, accounts and admissions. It refuses to run if
students already exist.
