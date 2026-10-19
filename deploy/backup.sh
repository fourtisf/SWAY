#!/usr/bin/env bash
# Nightly backup for the VPS: Postgres (custom-format dump) + uploaded images, with retention.
# Cron (as the deploy user):  15 3 * * *  /srv/sway/deploy/backup.sh >> /var/log/sway-backup.log 2>&1
# Restore:  pg_restore --clean --if-exists -d "$DATABASE_URL" <file>.dump  and untar the uploads archive.
# Copy BACKUP_DIR off the machine (rclone/rsync to object storage); a backup on the same disk is not a backup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sway}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
UPLOAD_DIR="${UPLOAD_DIR:-$ROOT/uploads}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

pg_dump --format=custom --no-owner --file "$BACKUP_DIR/sway-$STAMP.dump" "$DATABASE_URL"
if [ -d "$UPLOAD_DIR" ]; then
  tar -C "$(dirname "$UPLOAD_DIR")" -czf "$BACKUP_DIR/uploads-$STAMP.tar.gz" "$(basename "$UPLOAD_DIR")"
fi
find "$BACKUP_DIR" -type f \( -name 'sway-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
echo "[backup] $STAMP ok: $(du -sh "$BACKUP_DIR" | cut -f1) in $BACKUP_DIR"
