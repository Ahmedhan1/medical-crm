# MEDCORE — Contract Change Requests

A **contract change** is any change that affects behavior another agent relies
on: editing a shared/contract file (see `AGENTS.md` §4), adding a new `RoleKey`,
changing an existing endpoint's request/response shape, changing a shared table,
or defining a cross-workstream event/read contract.

**Not** a contract change (do it directly in your own files): adding a new
permission and granting it to an existing role in your `permissions.<workstream>.ts`;
adding a new event type in your `events.<workstream>.ts`; adding a new endpoint
inside your own feature module; adding a new table in your migration range.

## Process

1. Copy the template below to the top of the "Requests" list.
2. Assign the next `CCR-NNN` id, set **Status: PROPOSED**.
3. Agent 1 reviews. Approved → **APPROVED** (+ who implements the shared part).
   Rejected → **REJECTED** with a reason and an alternative.
4. Dependent work starts only after **APPROVED** and the shared part is merged.
5. When merged, set **Status: DONE**.

## Template

```
### CCR-NNN — <short title>
- Status: PROPOSED | APPROVED | REJECTED | DONE
- Requested by: Agent N
- Date: YYYY-MM-DD
- Affects: <agents / workstreams>
- Contract file(s): <paths>
- Change: <what changes, precisely>
- Reason: <why it is needed>
- Backward compatibility: <migration/compat plan; how existing callers keep working>
- Tests: <what proves it safe>
- Decision (Agent 1): <notes>
```

---

## Requests

### CCR-002 — Redact query strings from the request log (PHI in logs)
- Status: PROPOSED
- Requested by: Agent 2
- Date: 2026-09-16
- Affects: all workstreams (any endpoint taking a query string)
- Contract file(s): `server/src/http/server.ts` (Fastify logger configuration)
- **Finding:** Fastify's default info-level request log records the full URL
  including the query string. `GET /patients/search?q=Ahmed` therefore writes a
  patient name into application logs, which violates `AGENTS.md` rule 9 ("never
  put PHI in ... logs"). Verified by capturing real log output, not by
  inspection.
- Change: give the server's logger a custom request serializer that logs the
  route path and strips (or allow-lists) the query string, e.g.

  ```ts
  const app = Fastify({
    logger: {
      serializers: {
        req(req) {
          const [path] = req.url.split('?');
          return { method: req.method, url: path, hostname: req.hostname };
        },
      },
    },
    // …
  });
  ```
- Reason: this is a cross-cutting governance control. Every workstream will add
  query-string endpoints, and each one that carries an identifier, a phone
  number or a name re-creates the leak. It belongs in the shared logger, not in
  each route.
- Interim mitigation (already shipped, Agent-2 owned files only):
  `/patients/search` is registered with `logLevel: 'warn'`, which suppresses the
  URL-bearing info log for that route alone, and the search is now audited in
  the service layer (actor, result count and query LENGTH — never the term). No
  shared file was touched.
- Backward compatibility: log-format change only; no API or schema impact.
  The interim mitigation can be reverted once this lands.
- Tests: `test/integration/security.test.ts` — "never writes a searched patient
  name into the request log" captures real pino output, asserts the name is
  absent, and asserts a control route in the same module IS still logged so the
  test cannot pass merely because logging is off. Verified to fail when the
  mitigation is removed.
- Decision (Agent 1): _pending_

### CCR-001 — Prescription → medication-master reference
- Status: PROPOSED
- Requested by: Agent 2
- Date: 2026-09-16
- Affects: Agent 4 (P002 drug/medication master), Agent 2 (C007 prescriptions)
- Contract file(s): none yet — this request exists so the eventual link is
  agreed rather than improvised. No shared file changes today.
- Change: `prescription_item` (migration 0103) stores `medication_name` as free
  text plus an OPTIONAL opaque `medication_ref text`. There is deliberately **no
  foreign key** to any medication table. Proposed future contract: once P002
  lands, `medication_ref` carries a stable, documented identifier from the
  medication master (e.g. `<system>:<code>`), resolved through a service Agent 4
  owns. Clinical Core would still never query Agent 4's tables directly, and
  `medication_ref` would remain nullable.
- Reason: prescribing must work for anything not yet in the catalog — a
  compounded preparation, an import, a drug the master has not ingested. A hard
  foreign key would make those unprescribable and would couple the clinical
  schema to another workstream's migration order. Recording the reference now
  means no data migration is needed later.
- Backward compatibility: fully additive. `medication_ref` is already nullable
  and unconstrained, so existing prescriptions stay valid whatever P002 chooses.
  If Agent 4 picks a different identifier shape, only new rows are affected.
- Tests: `test/integration/prescriptions.test.ts` asserts a `medicationRef` is
  stored and returned without any catalog being present.
- Decision (Agent 1): _pending_

---

## Known contracts to respect (baseline, do not break)

- **API error envelope:** `{ "error": { "code", "message", "details?" } }` with
  stable `code` values; success bodies are the resource JSON.
- **Auth:** `Authorization: Bearer <token>`; principal carries `clinicId`,
  `roles`, `permissions`. Every protected route runs `requireAuth`, every
  service asserts a permission and scopes by `clinic_id`.
- **QR payload:** `MEDCORE1:<opaque-base64url>`; NEVER contains PHI.
- **Audit vs events:** sensitive actions → append-only `audit_log` (no PHI in
  metadata); domain facts → append-only `event`, emitted in the same
  transaction as the state change.
- **DB conventions:** every tenant table has `clinic_id`; timestamps are
  `timestamptz`; `audit_log` and `event` reject UPDATE/DELETE.
- **Governance boundaries:** pharma gets no patient-identifiable data; AI output
  is review-first and never auto-writes clinical records.
