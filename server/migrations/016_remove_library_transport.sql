-- 016_remove_library_transport.sql
--
-- The school does not run a library or a transport service through this
-- system, so both modules are removed: their tables, the vehicle-capacity
-- trigger function, their permission codes (and any role grants of them), the
-- Librarian role, and their settings. The application code for both modules is
-- removed in the same change.
--
-- Nothing outside these modules references their tables (every foreign key
-- points outward, to students, staff and payments), so the drops are
-- self-contained. Children are dropped before parents.

-- Up Migration

DROP TABLE IF EXISTS student_transport;
DROP TABLE IF EXISTS route_stops;
DROP TABLE IF EXISTS routes;
DROP TABLE IF EXISTS vehicles;
DROP TABLE IF EXISTS drivers;
DROP FUNCTION IF EXISTS check_vehicle_capacity();

DROP TABLE IF EXISTS library_fines;
DROP TABLE IF EXISTS book_issues;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS book_categories;

DELETE FROM role_permissions
 WHERE permission_id IN (SELECT id FROM permissions WHERE module IN ('library', 'transport'));
DELETE FROM permissions WHERE module IN ('library', 'transport');

DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE name = 'Librarian');
DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name = 'Librarian');
DELETE FROM roles WHERE name = 'Librarian';

DELETE FROM settings WHERE key LIKE 'library.%' OR key LIKE 'transport.%';

-- Down Migration

DO $$
BEGIN
  RAISE EXCEPTION 'Migration 016 cannot be reverted: the library and transport modules and their data were removed. Restore from a backup instead.';
END $$;
