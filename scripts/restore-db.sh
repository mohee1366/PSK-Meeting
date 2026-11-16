#!/usr/bin/env sh
set -eu
if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then echo "Destructive operation blocked. Set CONFIRM_RESTORE=YES after verifying the target database and backup." >&2; exit 2; fi
file=${1:-}
if [ -z "$file" ] || [ ! -s "$file" ]; then echo "Usage: CONFIRM_RESTORE=YES $0 backups/backup.dump" >&2; exit 2; fi
if [ -f "${file}.sha256" ]; then sha256sum -c "${file}.sha256"; fi
echo "Restoring $file into psk_meeting. Current database contents will be replaced."
docker compose exec -T postgres pg_restore -U psk -d psk_meeting --clean --if-exists --no-owner --no-privileges < "$file"
echo "Restore command completed. Verify application health and record counts before reopening access."
