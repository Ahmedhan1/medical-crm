# MEDCORE — Customer Guide

Welcome to MEDCORE, a local-first clinic operating system that runs on your own
MEDCORE BOX (a computer or server at your clinic). Your patient data stays on your
premises; the Internet is used only for optional features (WhatsApp messaging,
license checks, updates, cloud AI where enabled).

This guide set is written for a clinic administrator or the person operating the
BOX — not for software developers.

## The guides

| Guide | What it covers | For whom |
| --- | --- | --- |
| **README** (this file) | Overview, quick start, first login | Everyone |
| [INSTALL](./INSTALL.md) | Prerequisites, installing MEDCORE, `vendor.bat` | Installer / IT |
| [OPERATIONS](./OPERATIONS.md) | Start/stop, health, backup, restore, update, offline, logs, diagnostics | Operator |
| [LICENSE](./LICENSE.md) | Activation, editions, offline grace, key rotation | Administrator / Vendor |
| [ADMIN & SECURITY](./ADMIN-AND-SECURITY.md) | Users & roles, clinic setup, security & privacy, support | Administrator |

Feature guides for clinical work, WhatsApp/automation, AI, and CRM/reporting are
delivered by the respective product modules; this set covers the platform,
installation, licensing and operations that Agent 1 owns.

## Quick start (5 steps)

1. **Install** — run the vendor installer (`vendor.bat install` on Windows). It
   checks prerequisites, creates a secure configuration, sets up the database,
   and creates your administrator account. It prints a one-time admin password —
   **write it down**.
2. **Activate your license** — `vendor.bat license status` shows your BOX's
   installation id; give it to your vendor, receive `license.json`, then
   `vendor.bat license activate license.json`. (Clinical core works even before
   activation; see [LICENSE](./LICENSE.md).)
3. **Start** — `vendor.bat start`, then `vendor.bat health` should report `ok`.
4. **Sign in** — open `http://<box-address>/` in a browser, sign in as `admin`
   with the one-time password, and change it immediately.
5. **Set up your clinic** — add your clinic details, users (doctors, nurses,
   reception), then begin daily use.

## First login

- URL: `http://localhost/` on the BOX, or `http://<box-lan-ip>/` from clinic
  devices on the same network.
- Username: `admin` (or the name chosen at install).
- Password: the one-time password printed during install. You are expected to
  change it on first sign-in.
- Language: use the language toggle (English / العربية) in the top bar. The
  interface fully mirrors for Arabic (right-to-left).

## What needs the Internet, and what does not

- **Works fully offline:** patient registration, appointments, consultations,
  prescriptions, clinical documentation, reports, backup/restore.
- **Needs the Internet (optional):** WhatsApp messaging, cloud AI providers,
  periodic license re-verification, software updates. If the Internet is
  unavailable, clinical work continues; only these optional features pause.

See [OPERATIONS → Offline mode](./OPERATIONS.md#offline-mode).
