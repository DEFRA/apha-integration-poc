-- ─────────────────────────────────────────────────────────────────────────────
--  workorders.sql — materialised view for the `workorders` change-detection
--  source. Run by the application on server start via mv-setup.js; only if
--  the MV does not already exist (checked against ALL_MVIEWS).
--
--  Naming contract: this file's stem must match the source name in
--  `changeDetection.sources` in src/config.js, and the MV identifier here
--  must match that source's `mv` config entry.
--
--  Why REFRESH COMPLETE ON DEMAND: we don't own PEGA_DATA in prod and cannot
--  create an MV LOG on it (FAST REFRESH requires that). The detector triggers
--  a full refresh on every sweep; correctness comes from hash-diffing against
--  the row-state store, not from the watermark. See detector.js for detail.
--
--  source_scn captures the *source* row's ORA_ROWSCN at refresh time — the
--  MV's own ORA_ROWSCN would be useless as a watermark because a COMPLETE
--  refresh truncates+reloads everything.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE MATERIALIZED VIEW apha_poc.ahwork_ac_mv
  BUILD IMMEDIATE
  REFRESH COMPLETE ON DEMAND
AS
SELECT
  t.pyid,
  t.pzinskey,
  t.pxinsname,
  t.pxobjclass,
  t.pxupdatedatetime,
  t.pystatuswork,
  t.wsactivationdate,
  t.wsstartdate,
  t.wsearliestactivitystartdate,
  t.wslatestactivitycompletiondate,
  t.pysladeadline,
  t.pxcoverinskey,
  t.pydescription,
  t.activitysequencenumber,
  t.activityrequiredflag,
  t.workbasketname,
  t.pyassignedoperator,
  ORA_ROWSCN AS source_scn
FROM pega_data.ahwork_ac t
