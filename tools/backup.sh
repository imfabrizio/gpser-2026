#!/usr/bin/env bash
# Backup completo del database (uso: DATABASE_URL=... tools/backup.sh [cartella])
# Richiede pg_dump con versione >= a quella del server (Neon: vedi la versione nel pannello del progetto).
set -euo pipefail
: "${DATABASE_URL:?imposta DATABASE_URL (indirizzo di connessione di Neon)}"
DIR="${1:-backup}"; mkdir -p "$DIR"
FILE="$DIR/garecri-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > "$FILE"
echo "backup salvato: $FILE ($(du -h "$FILE" | cut -f1))"
# ripristino su un database vuoto:  gunzip -c FILE | psql "$DATABASE_URL"
