#!/bin/bash
set -euo pipefail

# Oracle persists listener hostnames in dbconfig; after container recreation the old hostname can break listener startup.
CFG_DIR="/opt/oracle/oradata/dbconfig/FREE"

if [ -f "$CFG_DIR/listener.ora" ]; then
  sed -E -i 's/\(HOST = [^)]+\)/(HOST = 0.0.0.0)/g' "$CFG_DIR/listener.ora"
fi

if [ -f "$CFG_DIR/tnsnames.ora" ]; then
  sed -E -i 's/\(HOST = [^)]+\)/(HOST = 0.0.0.0)/g' "$CFG_DIR/tnsnames.ora"
fi

# Ensure listener is running after host rewrite.
lsnrctl status >/dev/null 2>&1 || lsnrctl start >/dev/null 2>&1 || true
