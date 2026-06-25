# Plan — change-detection refactor

## Goal

Refactor the `src/change-detection/` subsystem so it is optimal, robust, and
easy to understand and maintain, while preserving 100% of its externally
observable behaviour (public API, emitted event shapes, CQN/MV/timer
semantics) and keeping every existing test green. Strip historical /
changelog / "stage of AI implementation" comments and tighten the remaining
ones to explain *why*, not *when*.

## Context (current state)

- Public API (`src/change-detection/index.js`): `bootstrap({db,logger})`,
  `watch(source, {filter, shape})`, `shutdown()`, `_detectorForTesting(source)`.
  Also contains the `Registry` class and the `createWatcher` factory (with a
  subtle pre-attach event buffer) and config/util helpers — three concerns in
  one 299-line file.
- `detector.js` (496 lines): the `Detector` class owns the timer, the CQN
  subscription + bounded-backoff resubscribe, the single-flight sweep mutex
  with coalescing, MV self-deploy on start, and the whole sweep algorithm
  (refresh → fetch changed rows → hash-classify → emit → persist → detect
  deletions → advance checkpoint). It also carries pure helpers (`hashPayload`,
  `lowercaseKeys`, `stripInternalColumns`, `errSummary`, `safeEmit`).
- Stores: `checkpoint-store.js` (watermark), `state-store.js` (per-row hash +
  payload). The sweep does per-row sequential Mongo I/O: one `get` then one
  `upsert` per changed row, plus a per-deleted-id `get`.
- `cqn-wakeup.js`, `mv-refresh.js`, `mv-setup.js`, low-level `src/cqn.js`,
  and the Hapi `src/plugins/change-detection.js` round out the subsystem.

## Assumptions

- **The Oracle-backed integration suites cannot run in this environment** (no
  Oracle/Mongo containers; `ORACLE_CLIENT_LIB_DIR` is set so they are *not*
  auto-skipped, but there is no DB to connect to). The refactor must preserve
  exact runtime semantics on the Oracle path and rely on (a) careful reasoning,
  (b) the four reviewers, and (c) new/existing **unit** tests for any logic
  validatable without Oracle. **Every new test added by this plan must avoid the
  Oracle path entirely (no `skipIf(!ORACLE_CLIENT_LIB_DIR)`), using in-memory
  Mongo (`vitest-mongodb`) or fake stores + module-mocked `oracledb`/
  `mv-refresh`/`mv-setup` so it always runs in CI.**
- The test files pin the following internal surface, which MUST be preserved:
  `_detectorForTesting(source)` returning a detector with `.triggerSweep(reason)`,
  `.runSweep(reason)` (monkeypatched in `resilience.test.js`), and a mutable
  `.cqn` property; store method names/signatures; `ensureMaterializedView`
  signature returning `{created}`.
- Emitted event shape is a contract: `{type, source, id, row, before,
  detectedAt}` with `type ∈ insert|update|delete`, plus a unified `change`
  event and an `error` event. `filter(event)` and `shape(row)` watcher options.
- The exact CQN-only log strings are asserted by `cqn-only.test.js`
  (`'CQN wake-up subscribed'`, `'CQN notification received (MV pipeline
  disabled; log-only)'`) and must be preserved verbatim.
- Row ids are strings today (`pyid`); `priorState` lookups compare them as-is.
  A future numeric-PK source would need id normalisation at the detector
  boundary — out of scope, noted so it isn't silently assumed away.
- `docs/dba-grants-svcaphaintegration.sql` (untracked) is unrelated and will
  not be touched.

## Non-goals

- No change to the public API surface, event shapes, config schema, or the
  Mongo collection names/document shapes (`cqn_checkpoints`, `cqn_row_state`).
- No change to CQN/MV/timer *semantics*: still timer-as-backstop, CQN as
  best-effort wake-up, COMPLETE-refresh + hash-compare for correctness,
  anti-join delete detection every sweep, **and the per-row emit-then-persist
  partial-failure (duplicate-on-retry) window**.
- No new features, sources, or config.
- Not rewriting the test suites; additive unit tests only.

## Stages

Ordering is **test-foundation-first**: the zero-risk structural moves and the
end-to-end integration test land *before* the detector internals are rewired,
so that integration test guards the rewire.

### Stage 1 — Comment & history hygiene (no behaviour change)

Strip comments that narrate implementation history or AI build stages; **keep
and tighten** the comments explaining *why the current code is shaped the way it
is*. No code/logic changes.

- Files: all `src/change-detection/*.js`, `src/cqn.js`,
  `src/plugins/change-detection.js`, and history-narrating **comments only** in
  test files (`server-boot.test.js:8`, `consumer-api.test.js:55`). Where a test
  keeps a tricky assertion whose rationale lived in a cross-file pointer (e.g.
  the "shutdown before wipe" ordering), inline a short self-contained rationale
  rather than deleting it. Assertions/structure untouched.
- **Remove** (history/meta only): superseded-script references (`mv-setup.js:132`),
  CI-failure war-stories (`cqn.js:21`), "Following the pattern in…", "see the
  matching comment in…", any "Stage N" markers.
- **Keep & tighten**: sweep-cycle / hash-vs-watermark, coalescing, anti-join
  delete, the buffer contract, the atomic first-caller claim, why the CQN
  connection is held open, why client-initiated CQN, why COMPLETE refresh.
- Acceptance: `git show -w` is comments-only (no executable-line diffs); for each
  removed comment confirm the adjacent code was not also deleted; no surviving
  comment references a past impl / setup-script number / CI incident / other test
  file / "stage"; every "why" invariant still documented; lint clean; runnable
  unit tests pass.

### Stage 2 — Split `index.js`; establish the end-to-end test foundation

Pure structural move (no logic change) plus the **real-wiring integration test**
that will guard every later stage.

- `src/change-detection/registry.js`: `Registry` + `readSourceConfig`.
- `src/change-detection/watcher.js`: `createWatcher` + `safeBool` / `applyShape`.
- `index.js` → thin facade: `bootstrap`/`watch`/`shutdown`/`_detectorForTesting`
  re-exported, holding the module-level `registry`.
- New `watcher.test.js` (unit; fake `EventEmitter` "detector"): (a) event before
  any listener attaches is buffered; (b) first `newListener` drains via
  `queueMicrotask` after the listener is registered; (c) **two** listeners
  attached synchronously **both** receive buffered events **and the exact event
  count** (proves the second `newListener` microtask is a no-op, not a
  double-drain); (d) post-drain pass-through; (e) `filter` throw
  swallowed+logged, dropped; (f) `shape` **throw** swallowed+logged, event
  dropped; (g) a `shape` fn that **returns `undefined`** does **NOT** drop — the
  event is still emitted with `row: undefined` (current behaviour: `applyShape`
  returns the spread object, which is truthy; only a thrown shape drops — pin
  this so the move preserves it); (h) **`error` events buffered then drained**;
  (i) `stop()` detaches `change`/`error` + `removeAllListeners`.
- New `integration.test.js` (no Oracle; **real** `watch()` → **real** `Registry`
  → **real** `Detector` → **real** `createWatcher` buffer). In-memory Mongo for
  the stores; **`config.set('changeDetection.mvEnabled', true)` in the fixture
  (and restore in teardown)** — the default is CQN-only, under which
  `triggerStartupSweep()` is a no-op and no startup event would fire;
  module-mock `#/oracledb.js` (`getPool` → fake connection; `oracledb.thin =
  true` so the CQN path is skipped), `mv-refresh.js` (no-op), and `mv-setup.js`
  (`ensureMaterializedView` → no-op); stub `Detector.prototype.fetchChangedRows`
  to yield one canned row. The fake connection's `execute` must also return a
  controlled result for `detectDeletions`' live-id `SELECT` that **includes the
  canned row's id** (so the anti-join finds no missing ids and emits no spurious
  delete) — or stub `detectDeletions` to a no-op; otherwise the startup sweep
  could throw or emit a phantom delete. Assertions: a consumer attaching
  `.on('change')`
  **after** `await watch()` resolves still receives the startup-sweep event
  (real buffer drain through the real watcher attached before the startup
  sweep); two concurrent `watch(sameSource)` calls share exactly one detector
  (`_detectorForTesting` identity) and both receive events; `shutdown()` tears
  down cleanly. This single test exercises the real Registry↔Detector↔Watcher
  wiring end-to-end and is re-run by Stages 4–5. (It replaces the weaker
  mocked-detector registry test — mocking the detector would hollow out the very
  path under test.)
- Acceptance: public API imports unchanged for all callers/tests;
  `watcher.test.js` + `integration.test.js` pass; `git grep` shows no duplicate
  definitions; facade holds only singleton + delegation, no business logic; lint
  clean.

### Stage 3 — Extract pure helpers + a pure classifier (no `detector.js` change)

Pure algorithm extraction, reviewable in isolation; `detector.js` is **not
touched** in this stage.

- New `src/change-detection/row-hash.js`: pure `hashPayload`, `lowercaseKeys`,
  `stripInternalColumns` (copied **verbatim** — algorithm unchanged).
  `row-hash.test.js`: **golden-digest** assertions locking current output for
  `Date`/`bigint`/`Buffer`/nested-object/`undefined`-valued keys; hash stability
  across key order; column lowercasing; internal-column stripping.
- New `src/change-detection/classify.js`: pure
  `planChanges({ rows, primaryKey, priorState }) → { entries, maxScn }`. Each
  entry = `{ id, sourceScn, payload, payloadHash, event? }`; `event` is the
  `{type, id, row, before}` payload present only for an insert (no prior) or a
  real update (hash differs), `undefined` on a hash-equal false positive.
  Returns an entry for **every** examined row, in input order;
  `maxScn = max(sourceScn over ALL entries incl. skips)` (or `null` when empty).
  Documented contract: `priorState` keys are exactly `row[primaryKey]` with the
  same type as the Mongo `id` field; the function does **not** handle deletes.
  `classify.test.js`: insert; real update carrying `before`; hash-equal
  **skip-but-still-persist**; **`maxScn` advances when the highest-SCN row is a
  skip**; input ordering; mismatched key-type lookup misses → row mis-classified
  as insert (pins the Map-key contract so a coercion regression fails the test).
- Acceptance: `row-hash.test.js` + `classify.test.js` pass; no change anywhere
  else (`git show` touches only the two new modules + tests); lint clean.

### Stage 4 — Rewire `detector.js` onto the classifier (per-row `get` retained)

Behaviour-identical rewire — **no I/O shape change** (per-row `stateStore.get`
kept). Guarded end-to-end by the Stage 2 integration test plus a new unit test.

- `runSweep(reason)` becomes a thin sequence: `refreshMv` → `fetchChangedRows` →
  build `priorState` (per-row `stateStore.get`, as today) → `planChanges(...)` →
  loop entries in order: `if (entry.event) emitChange({ ...entry.event, source })`
  **then** `stateStore.upsert(...)` per entry (interleaved emit-then-persist,
  exactly as today) → `detectDeletions` → `if (maxScn > checkpoint)
  checkpointStore.set`. `emitChange` stays the single emission choke-point
  (attaches `source`, adds `detectedAt`). `fetchChangedRows`/`detectDeletions`
  stay normal (non-`#`) methods. `hashPayload`/`lowercaseKeys`/
  `stripInternalColumns` now imported from `row-hash.js`; their definitions are
  removed from `detector.js`.
- New `src/change-detection/detector.test.js` (no Oracle; fake stores +
  module-mocked `#/oracledb.js` `getPool` + `mv-refresh.js`):
  - **Sweep orchestration** — stub `fetchChangedRows` to return canned rows; spy
    `emitChange` + store calls. Assert: hash-equal rows are `upsert`ed
    **without** an emit; insert/update **emit-then-upsert in order**; `upsert` is
    called with the correct positional args `(source, id, payloadHash, payload,
    sourceScn)` — assert field-level, not just call-count; emitted payloads carry
    `{type,source,id,row,before,detectedAt}`; **`checkpointStore.set(maxScn)` is
    called even when every row is a hash-equal skip** (zero events), and is
    **not** called when `maxScn === checkpoint`; the delete phase runs **after**
    the changed-row upserts; `detectDeletions` reads `liveIds` from a fresh
    post-`refreshMv` MV read (assert call order `refreshMv → fetch → liveIds
    SELECT`); delete path emits (with `before: prev?.payload`) then calls
    `stateStore.delete(source, id)`; a `fetchChangedRows` that throws once
    surfaces an `error` event, calls `connection.close()` in `finally`, leaves
    the timer alive, clears `activeSweep`, and the **next** sweep succeeds.
  - **Coalescing/mutex contract** (mirrors `resilience.test.js`, no Oracle):
    monkeypatch `runSweep` to throw once then succeed; assert `triggerSweep`
    routes through `this.runSweep(reason)` dynamically, a throw clears
    `activeSweep` to `null`, concurrent triggers coalesce into exactly one
    follow-up, and `stopped`/`mvEnabled` guards short-circuit.
- Acceptance: `runSweep`/`triggerSweep` remain assignable methods (own/prototype,
  not `#private`); `triggerSweep` calls `this.runSweep(reason)` dynamically;
  `emit('error')` stays on a monkeypatch-reachable path; for identical input the
  emitted events + order + `before` + `maxScn` + checkpoint condition + persisted
  documents are identical to pre-refactor (asserted by `classify.test.js` +
  `detector.test.js`); `integration.test.js` still passes; CQN-only log strings
  unchanged (diff/grep); lint clean.

### Stage 5 — Batch the prior-state reads (`getMany`)

The one "optimal" lever kept: collapse per-row `get` round-trips into one batched
read. **Reads only** — no write/emit change, failure window untouched (see
pushback re: write-batching).

- `state-store.js`: add `getMany(source, ids) → Map<id, doc>` — single `$in`
  find, **chunked (chunk size 1000)** to stay clear of the 16 MB BSON limit on a
  bulk startup sweep; empty input → empty `Map`, no query; returns a fresh
  collection (no aliasing into any internal state). Existing single-row methods
  untouched.
- `detector.js`: build `priorState` via one `getMany` (chunked) instead of the
  per-row loop; in `detectDeletions`, compute the missing-id set from `listIds`
  vs the live MV ids (unchanged, still **after** the changed-row upserts), then
  fetch `before` payloads for just that (usually small) missing set via one
  `getMany`; emit + delete in the same `listIds` order. Comment that `getMany`
  holds the `priorState` Map alongside `changedRows` (≈2× peak heap on a large
  catch-up — acceptable); the Map is read-only during the entry loop.
- `state-store.test.js` extended: `getMany([])` (empty Map, no query); full
  document-shape round-trip (`payloadHash`/`payload`/`sourceScn`) keyed by row
  `id`; chunk-boundary case (> 1000 ids, no missed/duplicate ids); returned
  collection is not aliased to internal state.
- Re-run `detector.test.js` (now exercising the `getMany` path) and
  `integration.test.js`.
- Acceptance: a grep for `.payloadHash` / `.payload` / `stateStore.get(`
  confirms every prior-state read call-site moved to the `getMany` map in
  lockstep; classification + emit order + persisted docs unchanged vs Stage 4
  (re-run `detector.test.js` + `integration.test.js`); new `state-store` tests
  pass; lint clean.

## Decisions made

- **Five small stages, test-foundation-first.** The index split + the real-wiring
  `integration.test.js` land in Stage 2, before any detector-internals change, so
  that integration test (real Registry↔Detector↔Watcher) guards Stages 4–5. Pure
  classifier extraction (Stage 3) is separated from the detector rewire (Stage 4)
  and from the I/O batching (Stage 5) so each is a small, independently-reviewable
  diff with executable coverage. (Resolves round-3 HIGH "integration gap" and
  MEDIUM "Stage 2 too large / order the structural move first".)
- **A real-wiring `integration.test.js` (not a mocked-detector registry test).**
  Mocking the Detector would hollow out the very path under test; using the real
  Detector with fake stores + mocked Oracle I/O exercises the genuine wiring
  without a database.
- **Write-batching (`bulkUpsert`/`bulkDelete`) dropped, not deferred** (see
  pushback). Only batched **reads** are kept; they carry no failure-window change.
- **Pure classifier instead of `#private` sweep methods**, so the
  correctness-critical logic is unit-testable without Oracle, with an explicit
  `priorState` Map-key contract guarded by a test.
- **All new tests are Oracle-free and always run in CI** (no
  `skipIf(!ORACLE_CLIENT_LIB_DIR)`), via in-memory Mongo or fake stores + mocked
  Oracle modules — compensating for the un-runnable integration suites.
- **Preserve every test-observable internal** (`_detectorForTesting`, assignable
  `runSweep`/`triggerSweep`, mutable `.cqn`, store signatures,
  `ensureMaterializedView → {created}`) rather than "modernise" them.

## Reviewer pushback (rejected / de-scoped)

- **Write-batching of state-store upserts/deletes (`bulkUpsert`/`bulkDelete`).**
  Considered for the "optimal" goal but **dropped** on unanimous round-1 reviewer
  advice (Codex/Grok/opencode/Gemini all HIGH): emit-all-then-bulk-persist widens
  the partial-failure duplicate window from one row to the whole batch — a real
  divergence from "behaviour-preserving" that cannot be validated in this
  environment and is not worth the marginal POC throughput gain. Batched **reads**
  are retained because reads carry no such failure-window change.
- **Cross-type (numeric) primary-key normalisation.** Out of scope: today's only
  source uses a string `pyid`. Documented in Assumptions so a future numeric-PK
  source is a conscious follow-up, not a silent landmine.
