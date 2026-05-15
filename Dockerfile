ARG PARENT_VERSION=3.0.5-node24.14.1
ARG NODE_VERSION=24.14.1
ARG PORT=3000
ARG PORT_DEBUG=9229

FROM defradigital/node-development:${PARENT_VERSION} AS development
ARG PARENT_VERSION
LABEL uk.gov.defra.ffc.parent-image=defradigital/node-development:${PARENT_VERSION}

ARG PORT
ARG PORT_DEBUG
ENV PORT=${PORT}
EXPOSE ${PORT} ${PORT_DEBUG}

COPY --chown=node:node package*.json ./
RUN npm install
COPY --chown=node:node ./src ./src

CMD [ "npm", "run", "docker:dev" ]

# The DEFRA CDP base image, referenced only so its bundled internal CA
# certificate can be copied into the production stage below.
FROM defradigital/node:${PARENT_VERSION} AS cdp-base

# Oracle Instant Client (Basic) is downloaded here and copied into the production
# image. Thick mode — which requires the Instant Client — is needed for CQN.
# It is built against glibc, so the production image can no longer use the
# Alpine-based defradigital/node base. TARGETARCH is set automatically by
# BuildKit (amd64 in CI, arm64 on Apple Silicon).
FROM node:${NODE_VERSION}-slim AS oracle-client
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/oracle
RUN case "${TARGETARCH}" in \
      amd64) IC_ZIP=instantclient-basic-linuxx64.zip ;; \
      arm64) IC_ZIP=instantclient-basic-linux-arm64.zip ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -sSfLO "https://download.oracle.com/otn_software/linux/instantclient/${IC_ZIP}" \
 && unzip -q "${IC_ZIP}" \
 && rm "${IC_ZIP}" \
 && mv instantclient_* instantclient

FROM node:${NODE_VERSION}-slim AS production
ARG NODE_VERSION
LABEL uk.gov.defra.ffc.parent-image=node:${NODE_VERSION}-slim

# curl (CDP PLATFORM HEALTHCHECK REQUIREMENT), tini (init / signal handling),
# ca-certificates, and libaio1 — the runtime dependency of Oracle Instant Client.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini ca-certificates libaio1 \
 && rm -rf /var/lib/apt/lists/*

# Carry over the CDP internal CA certificate from the DEFRA base image so that
# outbound TLS to CDP services keeps working (node:slim does not bundle it).
COPY --from=cdp-base \
     /usr/local/share/ca-certificates/internal-ca.crt \
     /usr/local/share/ca-certificates/internal-ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/internal-ca.crt

# Oracle Instant Client — Thick mode, required for CQN. On Linux the libraries
# must be discoverable via LD_LIBRARY_PATH (passing libDir to initOracleClient
# segfaults); ORACLE_CLIENT_LIB_DIR is the flag src/oracledb.js uses to enable
# Thick mode.
COPY --from=oracle-client /opt/oracle/instantclient /opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient \
    ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient

ENV NODE_ENV=production
WORKDIR /home/node
USER node

COPY --from=development --chown=node:node /home/node/package*.json ./
COPY --from=development --chown=node:node /home/node/src ./src/

RUN npm ci --omit=dev

ARG PORT
ENV PORT=${PORT}
EXPOSE ${PORT}

ENTRYPOINT ["tini", "--"]
CMD [ "node", "src" ]
