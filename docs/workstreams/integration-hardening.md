# Workstream: Integration & Hardening (Agent 1 at QA)

## Mission
After Agents 2–4 complete tasks, Agent 1 integrates branches and runs the final
quality gate (blueprint §54). This is not a parallel workstream — it is the
convergence step.

## Responsibilities
- Merge `agent-2/`, `agent-3/`, `agent-4/` branches into the foundation branch
  via PR. Conflicts should appear only in each agent's own files; a conflict in
  a shared/contract file means the contract process was skipped — stop and
  reconcile with the owning agent.
- Run the full gate on the merged tree:
  ```
  cd server && npm run typecheck && npm test && npm run build
  npm run migrate     # against a fresh db, then seed
  ```
- Security review of the dangerous cases (§53): unauthorized access, pharma →
  patient access, cross-clinic isolation, duplicate records, AI auto-write,
  append-only tamper resistance, no PHI in QR/logs.
- Verify migrations apply cleanly in range order (0001→0399) with no gaps or
  checksum drift.
- Update `IMPLEMENTATION-STATUS.md` to the true merged state.

## Quality-gate checklist
- [ ] Functional: every merged workflow works end-to-end.
- [ ] Security: no user reaches data outside their role/clinic.
- [ ] Data integrity: no duplicate/corrupt records; transactions atomic.
- [ ] Reliability: sensible behavior on db/provider failure.
- [ ] Governance: pharma cannot access clinical patient data; AI cannot finalize
      clinical data without human confirmation.
- [ ] Recovery: backup/restore verified.
- [ ] Deploy: a fresh clinic can install (migrate + seed) without engineering.
