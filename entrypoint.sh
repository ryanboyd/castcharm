#!/bin/sh
set -e

# Fix ownership of mounted volumes at startup. This handles two cases:
#   1. An existing volume previously created when the container ran as root
#   2. A host bind-mount for /downloads whose UID doesn't match the app user
#
# This script runs as root, fixes permissions, then drops to the castcharm
# user (uid 1000) before exec'ing the application.

chown -R castcharm:castcharm /data /downloads 2>/dev/null || true

exec gosu castcharm "$@"
