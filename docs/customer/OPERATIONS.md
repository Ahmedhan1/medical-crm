# MEDCORE — Operations Guide

All routine operations run through `vendor.bat` (Windows) or
`node install/medcorectl.mjs` (any OS). Every command is safe, idempotent, and
never prints secrets.

## Service control
| Command | What it does |
| --- | --- |
| `vendor.bat start` | Start the MEDCORE service |
| `vendor.bat stop` | Stop it |
| `vendor.bat restart` | Restart it |
| `vendor.bat status` | Is it running and is the database reachable? |
| `vendor.bat health` | Detailed health: DB latency, applied migrations, pool, last backup |

`health` returns `status: "ok"` when the database is reachable. It contains **no
patient data** — safe to read or screenshot for support.

## Backups
MEDCORE backups are `pg_dump` archives, optionally AES-256-GCM encrypted with your
`BACKUP_ENCRYPTION_KEY`, with a SHA-256 integrity checksum.

| Command | What it does |
| --- | --- |
| `vendor.bat backup` | Create an encrypted backup now |
| `node install/medcorectl.mjs backup` | Same, cross-platform |

- Backups are written to `BACKUP_DIR` (default `state/backups`). **Back this folder
  up off-box** (external/encrypted drive or your IT backup) — a backup on the same
  disk does not protect against disk loss.
- Backups may contain PHI, so they are never downloadable through the web app and
  never printed to the terminal.
- Recommended: at least one backup per day. Retention (how many daily/weekly/
  monthly copies to keep) is configurable.

## Restore
Restore is **destructive** (it overwrites a database), so it is a deliberate
operator action, never a web action:
```
vendor.bat restore <backup-id> --yes
```
Restoring into the live database refuses to proceed without `--yes`. To rehearse a
restore safely, restore into a spare database first. After restore, run
`vendor.bat health`.

## Updates
```
vendor.bat update
```
The update is **safe by construction**:
1. Takes a pre-update backup (aborts the update if the backup fails).
2. Applies database migrations (forward-only, transactional).
3. Rebuilds the application.
4. Tells you to run `vendor.bat health` and restart.

If a migration fails, the update stops and the pre-update backup is intact — restore
it with `vendor.bat restore <id> --yes`. Never update during a busy clinic session;
take updates at a quiet time and confirm `health` is green afterward.

## Offline mode
MEDCORE is local-first. If the Internet is unavailable:
- **Clinical work continues normally** — registration, appointments, consultations,
  prescriptions, documentation, reports, backup/restore all run against the local
  database.
- **Optional online features pause** — WhatsApp sending, cloud AI, license
  re-verification, updates. They resume automatically when connectivity returns.
- Your license keeps working through its configured **offline grace period** even
  if license re-verification cannot reach the vendor (see [LICENSE](./LICENSE.md)).

## Logs
```
vendor.bat logs
```
Lists recent logs in `install/logs/` (bootstrap, service, diagnostics). Application
logs never contain patient identifiers, query strings, or database error details
(these are stripped centrally).

## Support diagnostics
```
vendor.bat diagnostics
```
Writes a **PHI-free** support bundle to `install/logs/diagnostics-<time>.json`
containing versions, health, metrics and license status — no patient data and no
secrets. Send this file to support instead of database contents.

## Recovery checklist (disk failure / new box)
1. Provision a new BOX and run `vendor.bat install`.
2. Copy your latest off-box backup to `BACKUP_DIR`.
3. `vendor.bat restore <backup-id> --yes`.
4. Re-activate the license for the new installation id (`vendor.bat license
   status` → send the id to your vendor → `vendor.bat license activate`).
5. `vendor.bat start` and confirm `vendor.bat health` is green.
