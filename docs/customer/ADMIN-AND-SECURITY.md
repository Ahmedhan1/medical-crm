# MEDCORE — Administrator, Security & Privacy Guide

## Users and roles
MEDCORE uses role-based access control. Every screen and action is permission-
gated on the server, so what a user can do never depends on the browser alone.

- **Administrator** — full access; manages users, clinic settings, backups,
  license. Create one real admin per responsible person; do not share accounts.
- **Doctor** — clinical authority: diagnoses, prescriptions, procedures, care
  plans. Only doctors hold prescribing authority.
- **Nurse** — vitals, observations, allergies, clinical support tasks.
- **Reception** — registration, appointments, arrivals, the queue.
- **Pharma roles** (rep / manager / data steward / medical affairs) — the CRM and
  intelligence side, with a strict firewall from patient clinical data.

First sign-in: change the one-time admin password immediately. Give each staff
member their own account with the least role they need.

## What each control requires and does
- **Create user / assign role** — Administrator. Grants exactly the permissions of
  that role; the server enforces them on every request.
- **Backups** — `backup:manage` (Administrator). Create/list/verify via the admin
  API; restore is operator-only (CLI), so a web session can never overwrite the
  database or download a backup.
- **License status** — `license:manage` (Administrator). Read-only; shows edition,
  plan, features and validity, never the signature or keys.

## Security overview (what protects your data)
- **Local-first:** patient data stays in the local database on your BOX. The web
  interface makes only same-origin calls to the local backend.
- **Authentication:** passwords are hashed (scrypt) with a server-side secret;
  sessions are opaque tokens; repeated failed logins are rate-limited and locked
  out; logout revokes the session.
- **Tenant isolation:** every record is scoped to your clinic; cross-clinic access
  is impossible through the API.
- **PHI safety:** patient identifiers never appear in application logs, in events,
  in QR codes, or in database error messages (these are stripped centrally).
  Support diagnostics are PHI-free by construction.
- **Transport & headers:** the API sends strict security headers (a locked-down
  content-security-policy, no framing, no referrer leakage). For clinic-wide use,
  serve MEDCORE behind HTTPS on your LAN (the vendor package can provision this).
- **AI safety:** AI never diagnoses or prescribes autonomously; AI-suggested
  output is review-first and a human must accept it. AI requests pass a governed
  gateway and an action guard.
- **Pharma firewall:** the CRM/intelligence side has zero access to patient-level
  clinical data; aggregate intelligence enforces a minimum cohort size and
  suppression so individuals cannot be re-identified.
- **Exports:** governed by permission and territory, row-limited, explicit-field,
  protected against spreadsheet formula injection, and audited.

## Privacy
- Patient data does not leave the BOX unless you explicitly enable an online
  feature (e.g. WhatsApp messages, which send only what a message needs, under
  patient consent and quiet-hours rules).
- Backups may contain patient data; store them encrypted and off-box, and treat
  them with the same care as the live system.

## Support without exposing patient data
When you contact support:
1. Run `vendor.bat diagnostics` and send the generated `diagnostics-*.json`
   (PHI-free: versions, health, metrics, license status).
2. Run `vendor.bat logs` and share recent log lines if asked — logs contain no
   patient identifiers.
3. Never send a database backup to support unless explicitly required and
   transferred securely; it contains patient data.

## Administrator routine checklist
- Daily: confirm `vendor.bat health` is green; confirm a backup exists.
- Weekly: verify a backup restores into a spare database; copy backups off-box.
- On staff change: disable the departing user; rotate the admin password if it was
  shared.
- Before an update: `vendor.bat backup`, then `vendor.bat update` at a quiet time.
