import crypto from 'node:crypto'

/**
 * Pure row helpers shared by the sweep. Extracted so the hash contract — the
 * thing that makes change detection correct on top of a COMPLETE-refresh MV
 * with block-level ORA_ROWSCN false positives — is unit-testable on its own.
 */

export function lowercaseKeys(obj) {
  const out = {}

  for (const key of Object.keys(obj)) {
    out[key.toLowerCase()] = obj[key]
  }

  return out
}

export function stripInternalColumns(row) {
  const payload = { ...row }
  delete payload.source_scn

  return payload
}

export function hashPayload(payload) {
  // Sorted keys so column-order changes from the driver don't churn hashes;
  // Date / BigInt / Buffer normalized so they round-trip stably.
  const sorted = {}

  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key]
  }

  const json = JSON.stringify(sorted, (_key, value) => {
    if (value instanceof Date) {
      return value.toISOString()
    }

    if (typeof value === 'bigint') {
      return value.toString()
    }

    if (Buffer.isBuffer(value)) {
      return value.toString('base64')
    }

    return value
  })

  return crypto.createHash('sha256').update(json).digest('hex')
}
