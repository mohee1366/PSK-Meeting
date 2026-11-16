#!/usr/bin/env sh
set -eu
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="backups/psk_meeting_${stamp}.dump"
docker compose exec -T postgres pg_dump -U psk -d psk_meeting -Fc > "$file"
if [ ! -s "$file" ]; then echo "Backup failed: empty file" >&2; rm -f "$file"; exit 1; fi
sha256sum "$file" > "${file}.sha256"
echo "Backup created: $file"
