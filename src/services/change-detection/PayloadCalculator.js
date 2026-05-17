const createLogger = () => ({
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
})

export class PayloadCalculator {
  constructor(oraclePool) {
    this.oraclePool = oraclePool
    this.logger = createLogger()
  }

  /**
    Checks UPDATED_DATETIME across ALL related tables using GREATEST()
    Includes PARTY, PARTY_STATE, PARTY_VERSION, PERSON, ORGANISATION, and all address-related tables
   */
  async getChangedParties(lastPollTime) {
    const connection = await this.oraclePool.getConnection()

    try {
      const query = `
        SELECT DISTINCT
          p.PARTY_PK,
          p.PARTY_ID,
          GREATEST(
            p.UPDATED_DATETIME,
            NVL(ps.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL(pv.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL(per.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL(org.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL((
              SELECT MAX(GREATEST(
                NVL(pca.UPDATED_DATETIME, p.UPDATED_DATETIME),
                NVL(bs.UPDATED_DATETIME, p.UPDATED_DATETIME),
                NVL(ta.UPDATED_DATETIME, p.UPDATED_DATETIME)
              ))
              FROM PARTY_CONTACT_ADDRESS pca
              LEFT JOIN BS7666_ADDRESS bs ON pca.ADDRESS_PK = bs.ADDRESS_PK
              LEFT JOIN TELECOM_ADDRESS ta ON pca.TELECOM_ADDRESS_PK = ta.TELECOM_ADDRESS_PK
              WHERE pca.PARTY_PK = p.PARTY_PK
              AND pca.PARTY_CONTACT_TO_DATE IS NULL
            ), p.UPDATED_DATETIME)
          ) AS MAX_UPDATED_DATETIME,
          ps.PARTY_STATUS_CODE,
          pv.PARTY_TYPE,
          per.PERSON_GIVEN_NAME,
          per.PERSON_FAMILY_NAME,
          per.PERSON_BIRTH_DATE,
          org.ORGANISATION_NAME,
          org.ORGANISATION_TYPE_CODE,
          (
            SELECT JSON_ARRAYAGG(
              JSON_OBJECT(
                'partyContactAddressPk' VALUE pca2.PARTY_CONTACT_ADDRESS_PK,
                'addressPk' VALUE pca2.ADDRESS_PK,
                'telecomAddressPk' VALUE pca2.TELECOM_ADDRESS_PK,
                'paonStartNumber' VALUE bs2.PAON_START_NUMBER,
                'paonDescription' VALUE bs2.PAON_DESCRIPTION,
                'street' VALUE bs2.STREET,
                'town' VALUE bs2.TOWN,
                'administrativeArea' VALUE bs2.ADMINISTRATIVE_AREA,
                'postcode' VALUE bs2.POSTCODE,
                'telecomType' VALUE ta2.TELECOM_ADDRESS_TYPE,
                'mobileNumber' VALUE ta2.MOBILE_NUMBER,
                'telephoneNumber' VALUE ta2.TELEPHONE_NUMBER,
                'email' VALUE ta2.INTERNET_EMAIL_ADDRESS
              )
            )
            FROM PARTY_CONTACT_ADDRESS pca2
            LEFT JOIN BS7666_ADDRESS bs2 ON pca2.ADDRESS_PK = bs2.ADDRESS_PK
            LEFT JOIN TELECOM_ADDRESS ta2 ON pca2.TELECOM_ADDRESS_PK = ta2.TELECOM_ADDRESS_PK
            WHERE pca2.PARTY_PK = p.PARTY_PK
            AND pca2.PARTY_CONTACT_TO_DATE IS NULL
          ) AS ADDRESSES_JSON
        FROM PARTY p
        LEFT JOIN PARTY_STATE ps ON p.PARTY_PK = ps.PARTY_PK
          AND ps.PARTY_STATE_TO_DTTM IS NULL
        LEFT JOIN PARTY_VERSION pv ON p.PARTY_PK = pv.PARTY_PK
          AND pv.PARTY_VERSION_TO_DATETIME = DATE '9999-12-31'
        LEFT JOIN PERSON per ON p.PARTY_PK = per.PARTY_PK
        LEFT JOIN ORGANISATION org ON p.PARTY_PK = org.PARTY_PK
        WHERE
          GREATEST(
            p.UPDATED_DATETIME,
            NVL(ps.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL(pv.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL(per.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL(org.UPDATED_DATETIME, p.UPDATED_DATETIME),
            NVL((
              SELECT MAX(GREATEST(
                NVL(pca.UPDATED_DATETIME, p.UPDATED_DATETIME),
                NVL(bs.UPDATED_DATETIME, p.UPDATED_DATETIME),
                NVL(ta.UPDATED_DATETIME, p.UPDATED_DATETIME)
              ))
              FROM PARTY_CONTACT_ADDRESS pca
              LEFT JOIN BS7666_ADDRESS bs ON pca.ADDRESS_PK = bs.ADDRESS_PK
              LEFT JOIN TELECOM_ADDRESS ta ON pca.TELECOM_ADDRESS_PK = ta.TELECOM_ADDRESS_PK
              WHERE pca.PARTY_PK = p.PARTY_PK
              AND pca.PARTY_CONTACT_TO_DATE IS NULL
            ), p.UPDATED_DATETIME)
          ) > :lastPollTime
        ORDER BY MAX_UPDATED_DATETIME
      `

      const result = await connection.execute(query, { lastPollTime }, { outFormat: 4002 })
      return result.rows.map((row) => this.buildPartyPayload(row))
    } finally {
      await connection.close()
    }
  }

  buildPartyPayload(row) {
    const partyType = row.PARTY_TYPE

    let addresses = []
    if (row.ADDRESSES_JSON) {
      try {
        addresses = JSON.parse(row.ADDRESSES_JSON)
      } catch (e) {
        this.logger.warn(`Failed to parse addresses JSON for party ${row.PARTY_PK}`)
      }
    }

    return {
      partyPk: row.PARTY_PK,
      partyId: row.PARTY_ID,
      partyType,
      status: row.PARTY_STATUS_CODE,
      person:
        partyType === 'PERSON'
          ? {
              givenName: row.PERSON_GIVEN_NAME,
              familyName: row.PERSON_FAMILY_NAME,
              birthDate: row.PERSON_BIRTH_DATE ? row.PERSON_BIRTH_DATE.toISOString() : null
            }
          : null,
      organisation:
        partyType === 'ORGANISATION'
          ? {
              name: row.ORGANISATION_NAME,
              typeCode: row.ORGANISATION_TYPE_CODE
            }
          : null,
      addresses,
      maxUpdatedDateTime: row.MAX_UPDATED_DATETIME.toISOString()
    }
  }

  /**
    Checks UPDATED_DATETIME across ALL related tables for LOCATION
    Includes LOCATION, FEATURE_STATE, addresses, and assets
   */
  async getChangedLocations(lastPollTime) {
    const connection = await this.oraclePool.getConnection()

    try {
      const query = `
        SELECT DISTINCT
          l.FEATURE_PK,
          l.LOCATION_ID,
          l.COMMON_LAND_INDICATOR,
          l.RIGHT_OF_WAY_INDICATOR,
          GREATEST(
            l.UPDATED_DATETIME,
            NVL(fs.UPDATED_DATETIME, l.UPDATED_DATETIME),
            NVL((
              SELECT MAX(GREATEST(
                NVL(fa.UPDATED_DATETIME, l.UPDATED_DATETIME),
                NVL(bs.UPDATED_DATETIME, l.UPDATED_DATETIME)
              ))
              FROM FEATURE_ADDRESS fa
              LEFT JOIN BS7666_ADDRESS bs ON fa.ADDRESS_PK = bs.ADDRESS_PK
              WHERE fa.FEATURE_PK = l.FEATURE_PK
              AND fa.FEATURE_ADDRESS_TO_DATE IS NULL
            ), l.UPDATED_DATETIME),
            NVL((
              SELECT MAX(GREATEST(
                NVL(al.UPDATED_DATETIME, l.UPDATED_DATETIME),
                NVL(ast.UPDATED_DATETIME, l.UPDATED_DATETIME)
              ))
              FROM ASSET_LOCATION al
              LEFT JOIN ASSET_STATE ast ON al.ASSET_PK = ast.ASSET_PK
                AND ast.ASSET_STATE_TO_DTTM IS NULL
              WHERE al.FEATURE_PK = l.FEATURE_PK
              AND al.ASSET_LOCATION_TO_DATE IS NULL
            ), l.UPDATED_DATETIME)
          ) AS MAX_UPDATED_DATETIME,
          fs.FEATURE_STATUS_CODE,
          (
            SELECT JSON_ARRAYAGG(
              JSON_OBJECT(
                'addressPk' VALUE bs2.ADDRESS_PK,
                'paonStartNumber' VALUE bs2.PAON_START_NUMBER,
                'street' VALUE bs2.STREET,
                'town' VALUE bs2.TOWN,
                'postcode' VALUE bs2.POSTCODE
              )
            )
            FROM FEATURE_ADDRESS fa2
            JOIN BS7666_ADDRESS bs2 ON fa2.ADDRESS_PK = bs2.ADDRESS_PK
            WHERE fa2.FEATURE_PK = l.FEATURE_PK
            AND fa2.FEATURE_ADDRESS_TO_DATE IS NULL
          ) AS ADDRESSES_JSON,
          (
            SELECT JSON_ARRAYAGG(
              JSON_OBJECT(
                'assetPk' VALUE al2.ASSET_PK,
                'assetLocationType' VALUE al2.ASSET_LOCATION_TYPE,
                'assetStatusCode' VALUE ast2.ASSET_STATUS_CODE,
                'livestockUnitId' VALUE lu2.UNIT_ID,
                'facilityUnitId' VALUE f2.UNIT_ID,
                'facilityName' VALUE f2.FACILITY_NAME
              )
            )
            FROM ASSET_LOCATION al2
            LEFT JOIN ASSET_STATE ast2 ON al2.ASSET_PK = ast2.ASSET_PK
              AND ast2.ASSET_STATE_TO_DTTM IS NULL
            LEFT JOIN LIVESTOCK_UNIT lu2 ON al2.ASSET_PK = lu2.ASSET_PK
            LEFT JOIN FACILITY f2 ON al2.ASSET_PK = f2.ASSET_PK
            WHERE al2.FEATURE_PK = l.FEATURE_PK
            AND al2.ASSET_LOCATION_TO_DATE IS NULL
            AND al2.ASSET_LOCATION_TYPE = 'PRIMARYLOCATION'
          ) AS ASSETS_JSON
        FROM LOCATION l
        LEFT JOIN FEATURE_STATE fs ON l.FEATURE_PK = fs.FEATURE_PK
        WHERE
          GREATEST(
            l.UPDATED_DATETIME,
            NVL(fs.UPDATED_DATETIME, l.UPDATED_DATETIME),
            NVL((
              SELECT MAX(GREATEST(
                NVL(fa.UPDATED_DATETIME, l.UPDATED_DATETIME),
                NVL(bs.UPDATED_DATETIME, l.UPDATED_DATETIME)
              ))
              FROM FEATURE_ADDRESS fa
              LEFT JOIN BS7666_ADDRESS bs ON fa.ADDRESS_PK = bs.ADDRESS_PK
              WHERE fa.FEATURE_PK = l.FEATURE_PK
              AND fa.FEATURE_ADDRESS_TO_DATE IS NULL
            ), l.UPDATED_DATETIME),
            NVL((
              SELECT MAX(GREATEST(
                NVL(al.UPDATED_DATETIME, l.UPDATED_DATETIME),
                NVL(ast.UPDATED_DATETIME, l.UPDATED_DATETIME)
              ))
              FROM ASSET_LOCATION al
              LEFT JOIN ASSET_STATE ast ON al.ASSET_PK = ast.ASSET_PK
                AND ast.ASSET_STATE_TO_DTTM IS NULL
              WHERE al.FEATURE_PK = l.FEATURE_PK
              AND al.ASSET_LOCATION_TO_DATE IS NULL
            ), l.UPDATED_DATETIME)
          ) > :lastPollTime
        ORDER BY MAX_UPDATED_DATETIME
      `

      const result = await connection.execute(query, { lastPollTime }, { outFormat: 4002 })
      return result.rows.map((row) => this.buildLocationPayload(row))
    } finally {
      await connection.close()
    }
  }

  buildLocationPayload(row) {
    let addresses = []
    let assets = []

    if (row.ADDRESSES_JSON) {
      try {
        addresses = JSON.parse(row.ADDRESSES_JSON)
      } catch (e) {
        this.logger.warn(`Failed to parse addresses for location ${row.FEATURE_PK}`)
      }
    }

    if (row.ASSETS_JSON) {
      try {
        assets = JSON.parse(row.ASSETS_JSON)
      } catch (e) {
        this.logger.warn(`Failed to parse assets for location ${row.FEATURE_PK}`)
      }
    }

    return {
      featurePk: row.FEATURE_PK,
      locationId: row.LOCATION_ID,
      commonLandIndicator: row.COMMON_LAND_INDICATOR,
      rightOfWayIndicator: row.RIGHT_OF_WAY_INDICATOR,
      featureStatus: row.FEATURE_STATUS_CODE,
      addresses,
      assets,
      maxUpdatedDateTime: row.MAX_UPDATED_DATETIME.toISOString()
    }
  }
}
