import {
  stripInternalColumns,
  hashPayload
} from '#/change-detection/row-hash.js'

/**
 * Pure change classifier — the correctness kernel of the sweep, extracted so it
 * can be unit-tested without Oracle or Mongo.
 *
 * Given the rows a sweep fetched (those with source_scn > checkpoint) and the
 * prior state we hold for them, decide which are inserts, which are real
 * updates, and which are hash-equal false positives (a COMPLETE refresh and
 * block-level ORA_ROWSCN both re-surface unchanged rows). Returns one entry per
 * examined row in input order — the caller persists *every* entry (even the
 * skipped ones) so the watermark advances and the next sweep short-circuits
 * them; `event` is set only when something actually changed.
 *
 * Contract:
 *   - `priorState` is a Map keyed by exactly `row[primaryKey]`, with the same
 *     type as the value persisted under the row-state store's `id` field. A
 *     key-type mismatch (e.g. number vs string) silently misses and reclassifies
 *     a real update as an insert — the keys must match exactly.
 *   - This does NOT detect deletes: it never sees the full live id set, only the
 *     changed rows. Deletes are the detector's anti-join concern.
 *   - `event` carries no `source` field; the detector adds `source`/`detectedAt`
 *     when it emits.
 */
export function planChanges({ rows, primaryKey, priorState }) {
  const entries = []

  let maxScn = null

  for (const row of rows) {
    const id = row[primaryKey]
    const sourceScn = Number(row.source_scn)
    const payload = stripInternalColumns(row)
    const payloadHash = hashPayload(payload)

    const prev = priorState.get(id)

    let event

    if (!prev) {
      event = { type: 'insert', id, row: payload, before: undefined }
    } else if (prev.payloadHash !== payloadHash) {
      event = { type: 'update', id, row: payload, before: prev.payload }
    }
    // else: same hash — a refresh/block-SCN false positive. No event, but the
    // entry is still returned so the caller persists it and advances maxScn.

    entries.push({ id, sourceScn, payload, payloadHash, event })

    if (maxScn === null || sourceScn > maxScn) {
      maxScn = sourceScn
    }
  }

  return { entries, maxScn }
}
