# MEDCORE — Implementation Status

Honest accounting of what the current vertical slice actually does, measured
against the blueprint's acceptance criteria (§52). Nothing here is a
placeholder: every endpoint has a backend, schema, validation, authorization,
error handling, audit where sensitive, and tests.

## The vertical slice

**Front desk identity & flow:** authenticate → register/identify patient →
issue/scan secure QR → check in → queue. This is the smallest path that
exercises the Identity, Workflow, Event and Governance engines end-to-end.

## Endpoints

| Method | Route | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness + DB check (observability) |
| POST | `/auth/login` | — | Clinic-scoped login → bearer token |
| POST | `/auth/logout` | auth | Revokes the session |
| GET | `/auth/me` | auth | Current principal + permissions |
| POST | `/patients` | `patient:register` | Register; dedup guard; emits `PATIENT_REGISTERED` |
| GET | `/patients/search?q=` | `patient:search` | Clinic-scoped search |
| GET | `/patients/:id` | `patient:read` | Clinic-scoped fetch (404 cross-tenant) |
| POST | `/patients/:id/qr` | `qr:issue` | Issues opaque token + real PNG; no PHI in payload |
| POST | `/qr/resolve` | `qr:resolve` | Resolves scanned payload → patient |
| POST | `/encounters/check-in` | `encounter:checkin` | Opens encounter; emits `PATIENT_CHECKED_IN` |
| GET | `/queue` | `queue:read` | Active encounters, oldest first |

## Acceptance-criteria coverage

| Criterion | Slice status |
| --- | --- |
| Backend exists | ✅ Fastify services over Postgres |
| Database exists | ✅ Normalized schema, migration `0001_core` |
| Validation | ✅ Zod at the edges; DB constraints |
| Authorization | ✅ Permission + clinic scope in every service |
| Error handling | ✅ Typed errors → consistent, non-leaky envelope |
| Audit behavior | ✅ Append-only audit on sensitive + denied actions |
| Tests | ✅ 30 tests: unit, integration, security |
| Migration | ✅ Checksum-guarded, transactional runner |
| Documentation | ✅ `docs/` + README |
| Works on LAN | ✅ Single local server, LAN-bindable, Postgres-local |
| UI (empty/loading/failure states) | ⏳ V1 follow-up — this increment is API-first |

## Tests (30, all passing)

- **Unit:** password hash/verify (+ random salt, malformed-hash safety), token
  opacity/determinism, RBAC grant/deny/scope.
- **Integration:** login success/failure/enumeration-resistance, logout
  invalidation, auth required; register + MRN, input validation, hard/soft
  duplicate + override, search + fetch, unknown id 404; QR issue (no PHI) +
  resolve + unknown-token 404; check-in + event + queue, duplicate active
  encounter 409, unknown-patient check-in 404.
- **Security/governance (the dangerous cases §53):** pharma user cannot
  read/create patient data (403, audited); doctor cannot register (least
  privilege); cross-clinic isolation (404, no leak); sensitive action writes a
  success audit row; audit/event logs are append-only (DELETE/UPDATE rejected).

## Not yet built (designed in `ARCHITECTURE.md`)

Clinical intake + vitals, doctor workspace + "Save & Next", encounter clinical
fields + treatment episodes, patient timeline, reports/PDF, backup/restore,
automation + WhatsApp, AI extraction/summaries, physician & drug masters,
pharma/rep OS, and the intelligence firewall. These attach to the foundation
built here without reworking it.

## How to verify locally

```bash
cd server
npm install
npm run seed     # migrate + seed RBAC + demo clinic (prints logins)
npm test         # 30 tests
npm run dev      # serve on :4000
```
