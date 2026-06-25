-- ─────────────────────────────────────────────────────────────────────────────
--  008_setup_cqn_grants.sql
--  Grants required for Continuous Query Notification (CQN) against PEGA_DATA.
--  The default test pool user is `system` (DBA) so this is largely documentary,
--  but it lets the spike survive a switch to a least-privilege subscriber.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER SESSION SET CONTAINER = FREEPDB1;

BEGIN EXECUTE IMMEDIATE 'GRANT CHANGE NOTIFICATION TO pega_data'; EXCEPTION WHEN OTHERS THEN NULL; END;
/
