-- ─────────────────────────────────────────────────────────────────────────────
--  009_setup_change_detection_schema.sql
--  APHA_POC user and the prerequisite grants that the app cannot give itself
--  (granting SELECT on a table in a schema we don't own requires DBA, and
--  granting MV-creation privileges requires DBA too).
--
--  Per-source materialised views are NOT created here — the application
--  deploys them on start from src/change-detection/materialised-views/*.sql
--  via src/change-detection/mv-setup.js. This script just provisions the
--  one-time DBA-level prerequisites that the app inherits.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER SESSION SET CONTAINER = FREEPDB1;

BEGIN
  EXECUTE IMMEDIATE 'CREATE USER apha_poc IDENTIFIED BY "password"';
EXCEPTION WHEN OTHERS THEN
  IF SQLCODE = -1920 THEN NULL; -- User already exists
  ELSE RAISE;
  END IF;
END;
/

GRANT CONNECT, RESOURCE TO apha_poc;
/

GRANT CREATE MATERIALIZED VIEW TO apha_poc;
/

ALTER USER apha_poc QUOTA UNLIMITED ON USERS;
/

-- APHA_POC needs DIRECT SELECT on the source table — not via role — because
-- Oracle parses a materialised view's defining query using the owner's direct
-- privileges. Without this, the app's CREATE MATERIALIZED VIEW (run as
-- apha_poc) would fail with ORA-01031.
GRANT SELECT ON pega_data.ahwork_ac TO apha_poc;
/
