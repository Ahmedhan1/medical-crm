-- ============================================================================
-- MEDCORE 0900_platform_indexes  (Platform / Agent 1)
--
-- Cross-cutting performance migration. Reserved platform range 0900–0999 runs
-- AFTER every domain migration (0100–0399), because it indexes columns on
-- tables those migrations create.
--
-- Audit finding F-01: ~80 foreign keys had no backing index. This migration
-- adds ONLY the high-value ones — the two universal query axes:
--   * patient_id on clinical child tables (patient history / timeline reads)
--   * clinic_id on child tables that lacked a leading index (tenant filtering)
-- Low-value actor columns (created_by/recorded_by/reviewed_by/…) are left
-- unindexed on purpose: they are rarely queried and would only add write cost.
--
-- All statements are additive and idempotent (IF NOT EXISTS), so this migration
-- is safe to (re)apply and never changes behaviour.
-- ============================================================================

-- --- patient_id: per-patient history / timeline access -----------------------
CREATE INDEX IF NOT EXISTS ix_plat_intake_patient ON intake(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_vital_patient ON vital(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_encounter_clinical_patient ON encounter_clinical(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_assessment_patient ON assessment(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_diagnosis_patient ON diagnosis(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_treatment_plan_patient ON treatment_plan(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_clinical_note_patient ON clinical_note(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_treatment_episode_patient ON treatment_episode(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_treatment_response_patient ON treatment_response(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_prescription_patient ON prescription(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_follow_up_patient ON follow_up(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_comm_consent_patient ON communication_consent(patient_id);
CREATE INDEX IF NOT EXISTS ix_plat_message_log_patient ON message_log(patient_id);

-- --- clinic_id: tenant filtering on child tables lacking a leading index ------
CREATE INDEX IF NOT EXISTS ix_plat_qr_token_clinic ON qr_token(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_prescription_item_clinic ON prescription_item(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_automation_run_clinic ON automation_run(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_hcp_specialty_clinic ON hcp_specialty(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_hcp_practice_location_clinic ON hcp_practice_location(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_hcp_hco_affiliation_clinic ON hcp_hco_affiliation(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_hcp_revision_clinic ON hcp_revision(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_medication_ingredient_clinic ON medication_ingredient(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_medication_revision_clinic ON medication_revision(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_territory_assignment_clinic ON territory_assignment(clinic_id);
CREATE INDEX IF NOT EXISTS ix_plat_call_report_product_clinic ON call_report_product(clinic_id);
