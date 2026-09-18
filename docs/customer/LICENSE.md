# MEDCORE — License Management

MEDCORE uses a **membership license**, not a license-key file. A license is a
signed statement from the vendor that binds your subscription to one specific
installation. It is tamper-resistant (cryptographically signed) and supports
offline operation.

## Concepts
- **Installation id** — a unique id your BOX generates once at first run. Shown by
  `vendor.bat license status`.
- **License** — a signed document from the vendor containing your customer/tenant
  id, product **edition**, **feature entitlements**, an **expiry**, and an
  **offline grace period**. It is bound to your installation id and tenant, so it
  cannot be copied to another box.
- **Public key** — pinned into your BOX by the vendor; used to verify licenses.
  The matching **private key stays with the vendor** and is never on your box.

## Activation
1. On the BOX: `vendor.bat license status` → copy the **installation id**.
2. Send the installation id (and your purchase details) to your vendor.
3. Receive a `license.json` file.
4. On the BOX: `vendor.bat license activate license.json`.
5. Confirm: `vendor.bat license status` shows `status: active`, your plan and
   edition.

Activation **fails closed**: a tampered license, or a license issued for a
different installation or tenant, is refused.

## Status values
- **active** — valid and within its term.
- **grace** — expired, but within the offline grace window; everything keeps
  working while you renew.
- **expired** — past expiry and past grace; commercial features turn off.
- **unverified** — no license activated, or the signature could not be verified.

## What a lapsed license does — and does not — affect
**Clinical core is never disabled by licensing.** Patient registration,
appointments, consultations, prescriptions, clinical documentation, reports and
backup/restore keep working even when the license is `expired` or `unverified`, or
when the box is offline. Only **commercial add-on features** (as listed in your
license entitlements) turn off when the license is not active or in grace. This is
by design: a licensing or connectivity problem must never stop patient care.

## Offline and online verification
- The BOX verifies the license **locally** on every start using the pinned public
  key — no Internet required.
- When the Internet is available, MEDCORE periodically re-checks license status
  with the vendor (for renewals and revocation). If it cannot reach the vendor, it
  falls back to the locally cached license and its **offline grace period**.
- **Clock protection:** MEDCORE remembers the latest time it has seen. If the
  system clock is moved backwards to try to escape an expiry, MEDCORE detects the
  rollback and evaluates the license against the last known-good time instead, so
  grace cannot be re-opened by changing the clock.

## Renewal and revocation
- **Renewal:** your vendor issues a new `license.json` with a later expiry; run
  `vendor.bat license activate` with it. No downtime.
- **Revocation:** handled by the vendor during online re-verification; the box then
  reflects the new status.

## Key rotation and recovery (vendor)
- The vendor may rotate signing keys; each license carries a `keyId`. A box can be
  shipped/updated with the new public key, and licenses signed by the new key
  verify against it. Keep old public keys available until all licenses signed with
  the old key have expired.
- **Never** place the private signing key on a customer box or in the application.
  The issuer tool (`server/src/license/issuer.ts`) reads the private key from a
  file or environment variable at signing time only, on the vendor's secure
  machine.
- **Recovery:** if a box is rebuilt, it generates a new installation id; re-issue
  the license for the new id (the old license simply stops matching).
