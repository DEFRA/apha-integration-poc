/**
 * Table configuration for SAM database change detection.  Defines metadata for each table to support generic polling.
 */

export const TABLE_CONFIG = {
  PARTY: {
    primaryKey: 'PARTY_PK',
    entityIdField: 'partyPk',
    payloadMethod: 'getChangedParties'
  },
  LOCATION: {
    primaryKey: 'FEATURE_PK',
    entityIdField: 'featurePk',
    payloadMethod: 'getChangedLocations'
  },
  HOLDING: {
    primaryKey: 'HOLDING_PK',
    entityIdField: 'holdingPk',
    payloadMethod: 'getChangedHoldings'
  },
  ASSET: {
    primaryKey: 'ASSET_PK',
    entityIdField: 'assetPk',
    payloadMethod: 'getChangedAssets'
  }
  // Add remaining SAM tables as needed
}

export function getTableConfig(tableName) {
  const config = TABLE_CONFIG[tableName]
  if (!config) {
    throw new Error(`Table ${tableName} not configured. Add to table-config.js`)
  }
  return config
}
