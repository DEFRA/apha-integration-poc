import convict from 'convict'
import convictFormatWithValidator from 'convict-format-with-validator'

import { convictValidateMongoUri } from '#/common/helpers/convict/validate-mongo-uri.js'

convict.addFormat(convictValidateMongoUri)
convict.addFormats(convictFormatWithValidator)

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

export const config = convict({
  serviceVersion: {
    doc: 'The service version, this variable is injected into your docker container in CDP environments',
    format: String,
    nullable: true,
    default: null,
    env: 'SERVICE_VERSION'
  },
  host: {
    doc: 'The IP address to bind',
    format: 'ipaddress',
    default: '0.0.0.0',
    env: 'HOST'
  },
  port: {
    doc: 'The port to bind',
    format: 'port',
    default: 3001,
    env: 'PORT'
  },
  serviceName: {
    doc: 'Api Service Name',
    format: String,
    default: 'apha-integration-poc'
  },
  cdpEnvironment: {
    doc: 'The CDP environment the app is running in. With the addition of "local" for local development',
    format: [
      'local',
      'infra-dev',
      'management',
      'dev',
      'test',
      'perf-test',
      'ext-test',
      'prod'
    ],
    default: 'local',
    env: 'ENVIRONMENT'
  },
  log: {
    isEnabled: {
      doc: 'Is logging enabled',
      format: Boolean,
      default: !isTest,
      env: 'LOG_ENABLED'
    },
    level: {
      doc: 'Logging level',
      format: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: 'info',
      env: 'LOG_LEVEL'
    },
    format: {
      doc: 'Format to output logs in',
      format: ['ecs', 'pino-pretty'],
      default: isProduction ? 'ecs' : 'pino-pretty',
      env: 'LOG_FORMAT'
    },
    redact: {
      doc: 'Log paths to redact',
      format: Array,
      default: isProduction
        ? ['req.headers.authorization', 'req.headers.cookie', 'res.headers']
        : ['req', 'res', 'responseTime']
    }
  },
  mongo: {
    mongoUrl: {
      doc: 'URI for mongodb',
      format: String,
      default: 'mongodb://127.0.0.1:27017/',
      env: 'MONGO_URI'
    },
    databaseName: {
      doc: 'database for mongodb',
      format: String,
      default: 'apha-integration-poc',
      env: 'MONGO_DATABASE'
    },
    mongoOptions: {
      retryWrites: {
        doc: 'Enable Mongo write retries, overrides mongo URI when set.',
        format: Boolean,
        default: null,
        nullable: true,
        env: 'MONGO_RETRY_WRITES'
      },
      readPreference: {
        doc: 'Mongo read preference, overrides mongo URI when set.',
        format: [
          'primary',
          'primaryPreferred',
          'secondary',
          'secondaryPreferred',
          'nearest'
        ],
        default: null,
        nullable: true,
        env: 'MONGO_READ_PREFERENCE'
      }
    }
  },
  oracledb: {
    sam: {
      username: {
        doc: 'SAM Database username',
        format: String,
        default: 'system',
        env: 'ORACLEDB_SAM_SMDB_USERNAME'
      },
      password: {
        doc: 'SAM Database password',
        format: String,
        default: 'password',
        sensitive: true,
        env: 'ORACLEDB_SAM_SMDB_PASSWORD'
      },
      host: {
        doc: 'SAM Database host (host:port)',
        format: String,
        default: 'localhost:1521',
        env: 'ORACLEDB_SAM_SMDB_HOST'
      },
      dbname: {
        doc: 'SAM Database service name',
        format: String,
        default: 'FREEPDB1',
        env: 'ORACLEDB_SAM_SMDB_DBNAME'
      },
      poolMin: {
        doc: 'SAM Database pool minimum connections',
        format: Number,
        default: 0,
        env: 'ORACLEDB_SAM_SMDB_POOL_MIN'
      },
      poolMax: {
        doc: 'SAM Database pool maximum connections',
        format: Number,
        default: 4,
        env: 'ORACLEDB_SAM_SMDB_POOL_MAX'
      },
      poolTimeout: {
        doc: 'SAM Database pool idle connection timeout (seconds)',
        format: Number,
        default: 60,
        env: 'ORACLEDB_SAM_SMDB_POOL_TIMEOUT'
      },
      poolCloseWaitTime: {
        doc: 'SAM Database pool close wait time (seconds)',
        format: Number,
        default: 10,
        env: 'ORACLEDB_SAM_SMDB_POOL_CLOSE_WAIT_TIME'
      },
      poolAlias: {
        doc: 'SAM Database pool alias (used for getPool lookups)',
        format: String,
        default: 'samPool',
        env: 'ORACLEDB_SAM_SMDB_POOL_ALIAS'
      }
    },
    pega: {
      username: {
        // PEGA reuses the SAM credentials in the deployed environment — only
        // ORACLEDB_SAM_SMDB_USERNAME/PASSWORD are provisioned as secrets, and
        // the bridge service authenticates the PEGA pool the same way.
        doc: 'PEGA Database username (shared with SAM in the deployed env)',
        format: String,
        default: 'system',
        env: 'ORACLEDB_SAM_SMDB_USERNAME'
      },
      password: {
        doc: 'PEGA Database password (shared with SAM in the deployed env)',
        format: String,
        default: 'password',
        sensitive: true,
        env: 'ORACLEDB_SAM_SMDB_PASSWORD'
      },
      host: {
        doc: 'PEGA Database host (host:port)',
        format: String,
        default: 'localhost:1521',
        env: 'ORACLEDB_PEGA_HOST'
      },
      dbname: {
        doc: 'PEGA Database service name',
        format: String,
        default: 'FREEPDB1',
        env: 'ORACLEDB_PEGA_DBNAME'
      },
      poolMin: {
        doc: 'PEGA Database pool minimum connections',
        format: Number,
        default: 0,
        env: 'ORACLEDB_PEGA_POOL_MIN'
      },
      poolMax: {
        doc: 'PEGA Database pool maximum connections',
        format: Number,
        default: 4,
        env: 'ORACLEDB_PEGA_POOL_MAX'
      },
      poolTimeout: {
        doc: 'PEGA Database pool idle connection timeout (seconds)',
        format: Number,
        default: 60,
        env: 'ORACLEDB_PEGA_POOL_TIMEOUT'
      },
      poolCloseWaitTime: {
        doc: 'PEGA Database pool close wait time (seconds)',
        format: Number,
        default: 10,
        env: 'ORACLEDB_PEGA_POOL_CLOSE_WAIT_TIME'
      },
      poolAlias: {
        doc: 'PEGA Database pool alias (used for getPool lookups)',
        format: String,
        default: 'pegaPool',
        env: 'ORACLEDB_PEGA_POOL_ALIAS'
      }
    }
  },
  oracleClientLibDir: {
    doc: 'Path to Oracle Instant Client libraries. When set, oracledb runs in Thick mode (required for CQN).',
    format: String,
    nullable: true,
    default: null,
    env: 'ORACLE_CLIENT_LIB_DIR'
  },
  changeDetection: {
    enabled: {
      doc: 'Enable the change-detection subsystem on server start. Reads from materialised views, diffs against a Mongo-backed row-state store, and emits domain change events. CQN is used as an optional fast-path wake-up; the timer-driven sweep is the resilience backstop.',
      format: Boolean,
      default: false,
      env: 'CHANGE_DETECTION_ENABLED'
    },
    defaultIntervalMs: {
      doc: 'Default sweep interval (ms) — the safety-net poll that ensures changes are never missed even when CQN is silent.',
      format: Number,
      default: 60_000,
      env: 'CHANGE_DETECTION_INTERVAL_MS'
    },
    mvOwnerUser: {
      doc: 'Oracle user that OWNS the materialised views (the schema they live in). The app opens a short-lived connection as this user to create any missing MVs on start — Oracle requires the MV-owning user to be the session user when the defining query crosses schemas (e.g. APHA_POC.ahwork_ac_mv selecting from PEGA_DATA.ahwork_ac).',
      format: String,
      default: 'apha_poc',
      env: 'CHANGE_DETECTION_MV_OWNER_USER'
    },
    mvOwnerPassword: {
      doc: 'Password for the materialised-view owner user.',
      format: String,
      default: 'password',
      sensitive: true,
      env: 'CHANGE_DETECTION_MV_OWNER_PASSWORD'
    },
    sources: {
      workorders: {
        pool: {
          doc: 'Name of the OracleDB pool (key under `oracledb`) this source belongs to.',
          format: String,
          default: 'pega'
        },
        sourceTable: {
          doc: 'Fully-qualified source table the MV mirrors. Used in logs/diagnostics only.',
          format: String,
          default: 'PEGA_DATA.AHWORK_AC'
        },
        mv: {
          doc: 'Fully-qualified materialised view the detector reads from.',
          format: String,
          default: 'APHA_POC.AHWORK_AC_MV'
        },
        primaryKey: {
          doc: 'Column name (lowercase) used to identify a row across sweeps.',
          format: String,
          default: 'pyid'
        },
        cqnQuery: {
          doc: 'Optional CQN query that wakes the detector when the source changes. When omitted the source runs timer-only.',
          format: String,
          nullable: true,
          default: 'SELECT pyid, pystatuswork FROM pega_data.ahwork_ac'
        }
      }
    }
  },
  httpProxy: {
    doc: 'HTTP Proxy URL',
    format: String,
    nullable: true,
    default: null,
    env: 'HTTP_PROXY'
  },
  tracing: {
    header: {
      doc: 'CDP tracing header name',
      format: String,
      default: 'x-cdp-request-id',
      env: 'TRACING_HEADER'
    }
  }
})

config.validate({ allowed: 'strict' })
