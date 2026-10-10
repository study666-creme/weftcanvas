-- Canvas uses PostgreSQL as a private server-side store. MemFire exposes the
-- public schema through a PostgREST-compatible API, so inherited/default grants
-- for browser roles must never authorize these tables directly.
DO $canvas_security$
DECLARE
  canvas_table RECORD;
  browser_role TEXT;
BEGIN
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC';
  FOR browser_role IN
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
      browser_role
    );
  END LOOP;

  FOR canvas_table IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename LIKE 'canvas\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      canvas_table.schemaname,
      canvas_table.tablename
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC',
      canvas_table.schemaname,
      canvas_table.tablename
    );

    FOR browser_role IN
      SELECT rolname
      FROM pg_roles
      WHERE rolname IN ('anon', 'authenticated')
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
        canvas_table.schemaname,
        canvas_table.tablename,
        browser_role
      );
    END LOOP;
  END LOOP;
END
$canvas_security$;
