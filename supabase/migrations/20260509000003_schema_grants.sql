-- Major v1 — grant DB role privileges for the `major` schema.
--
-- Supabase auto-grants service_role/anon/authenticated USAGE + SELECT on
-- the `public` schema, but custom schemas need explicit grants. Without
-- these, edge functions calling supabase.from('table') against `major.*`
-- get `permission denied for schema major (PG 42501)` even though the
-- service-role client should be all-powerful.
--
-- Major's edge functions use only the service_role (no anon/authenticated
-- callers hit the DB directly), so we grant exclusively to service_role.

grant usage on schema major to service_role;
grant all privileges on all tables in schema major to service_role;
grant all privileges on all sequences in schema major to service_role;
grant execute on all functions in schema major to service_role;

-- Default privileges so future tables/sequences/functions don't need a
-- repeat grant.
alter default privileges in schema major
  grant all privileges on tables to service_role;
alter default privileges in schema major
  grant all privileges on sequences to service_role;
alter default privileges in schema major
  grant execute on functions to service_role;
