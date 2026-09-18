-- ============================================================================
-- MEDCORE 0400_billing  (Agent 2 — Billing & Finance)
--
-- The financial domain: billable-service catalog, invoices + line items,
-- payments, and a per-clinic invoice-number sequence. Sits in the 0400 range
-- (clinical 0100s, AI 0200s, pharma 0300s, finance 0400s) — a brand-new
-- workstream, no existing table duplicated.
--
-- MONEY IS INTEGER MINOR UNITS. Every amount is `bigint` in the currency's
-- minor unit (piastres for EGP, cents for USD) with a `currency` code. There is
-- no floating-point money anywhere: all arithmetic is integer, so totals and
-- balances are exact. CHECK constraints keep amounts non-negative and quantities
-- positive; the service keeps derived totals/balances consistent inside one
-- transaction, and the DB is the last line of defence.
--
-- Master data is NOT duplicated: patient is a FK; a line may optionally point at
-- a `billable_service` (our own catalog) — products/inventory owned by Agent 3
-- are referenced by an opaque, nullable `source_ref` string (no FK across the
-- ownership boundary), never re-modelled here.
-- ============================================================================

-- Per-clinic monotonic invoice numbering. One row per clinic; the issue path
-- upserts-and-increments under the row lock so two concurrent issues can never
-- receive the same number.
CREATE TABLE billing_sequence (
  clinic_id        uuid PRIMARY KEY REFERENCES clinic(id) ON DELETE RESTRICT,
  next_invoice_no  bigint NOT NULL DEFAULT 1 CHECK (next_invoice_no >= 1)
);

-- Catalog of billable services (consultation, procedure fee, etc.). Prices are
-- clinic-scoped. Tax is stored as basis points (1400 = 14.00%) so tax maths stay
-- integer. A service is deactivated, never deleted, so historical invoice lines
-- keep a valid reference.
CREATE TABLE billable_service (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  code             text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 40),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency         text NOT NULL DEFAULT 'EGP' CHECK (currency ~ '^[A-Z]{3}$'),
  tax_rate_bp      integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_billable_service_code UNIQUE (clinic_id, code)
);
CREATE INDEX idx_billable_service_clinic ON billable_service(clinic_id, is_active, name);

-- Invoice header. `status` domain is CHECK-constrained; legal TRANSITIONS are an
-- allow-list in the service. Money columns are maintained together in one
-- transaction: total = subtotal - discount + tax; balance_due = total - amount_paid.
CREATE TABLE invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  patient_id        uuid NOT NULL REFERENCES patient(id) ON DELETE RESTRICT,
  -- The visit this invoice bills for, when it originated at an encounter.
  encounter_id      uuid REFERENCES encounter(id) ON DELETE SET NULL,
  -- Assigned only at issue; a draft has no number yet.
  invoice_number    text,
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','issued','partially_paid','paid','void','cancelled')),
  currency          text NOT NULL DEFAULT 'EGP' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor    bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor    bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor         bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor       bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_paid_minor bigint NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  balance_due_minor bigint NOT NULL DEFAULT 0 CHECK (balance_due_minor >= 0),
  notes             text,
  due_date          date,
  issued_at         timestamptz,
  paid_at           timestamptz,
  voided_at         timestamptz,
  void_reason       text,
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Paid amount can never exceed the total (overpayment is refused in the
  -- service; this is the schema backstop).
  CONSTRAINT ck_invoice_paid_le_total CHECK (amount_paid_minor <= total_minor),
  -- Balance is exactly what is still owed.
  CONSTRAINT ck_invoice_balance CHECK (balance_due_minor = total_minor - amount_paid_minor),
  -- A number exists iff the invoice has left draft.
  CONSTRAINT ck_invoice_number_when_issued CHECK (
    (status = 'draft' AND invoice_number IS NULL)
      OR (status = 'cancelled')
      OR (status IN ('issued','partially_paid','paid','void') AND invoice_number IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_invoice_number ON invoice(clinic_id, invoice_number)
  WHERE invoice_number IS NOT NULL;
CREATE INDEX idx_invoice_clinic_status ON invoice(clinic_id, status, created_at DESC);
CREATE INDEX idx_invoice_clinic_patient ON invoice(clinic_id, patient_id, created_at DESC);
CREATE INDEX idx_invoice_issued_at ON invoice(clinic_id, issued_at)
  WHERE issued_at IS NOT NULL;
-- Outstanding-balance worklist: still-owed invoices.
CREATE INDEX idx_invoice_outstanding ON invoice(clinic_id, status)
  WHERE status IN ('issued','partially_paid');

-- Invoice line items. Cascade with the invoice (a line has no life of its own).
-- Editable only while the invoice is a draft (enforced in the service). Line
-- money is integer: line_subtotal = quantity*unit_price - discount; then tax;
-- line_total = line_subtotal + tax.
CREATE TABLE invoice_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id          uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  invoice_id         uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  line_no            integer NOT NULL CHECK (line_no >= 1),
  -- Optional pointer to our own service catalog. Products/inventory owned by
  -- Agent 3 are referenced via `source_ref` (opaque), never a cross-domain FK.
  service_id         uuid REFERENCES billable_service(id) ON DELETE SET NULL,
  source_ref         text,
  description        text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  quantity           integer NOT NULL CHECK (quantity >= 1),
  unit_price_minor   bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor     bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bp        integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  line_subtotal_minor bigint NOT NULL CHECK (line_subtotal_minor >= 0),
  tax_minor          bigint NOT NULL CHECK (tax_minor >= 0),
  line_total_minor   bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_item_line UNIQUE (invoice_id, line_no)
);
CREATE INDEX idx_invoice_item_invoice ON invoice_item(invoice_id, line_no);

-- Payments against an invoice. A payment is immutable once recorded except for a
-- governed reversal (status completed → reversed); a `billing_payment_immutable`
-- trigger blocks any other mutation. `idempotency_key` makes a retried "record
-- payment" request safe (unique per clinic).
CREATE TABLE payment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  invoice_id       uuid NOT NULL REFERENCES invoice(id) ON DELETE RESTRICT,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         text NOT NULL DEFAULT 'EGP' CHECK (currency ~ '^[A-Z]{3}$'),
  method           text NOT NULL CHECK (method IN ('cash','card','bank_transfer','insurance','wallet','other')),
  reference        text,
  status           text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','reversed')),
  idempotency_key  text,
  paid_at          timestamptz NOT NULL DEFAULT now(),
  reversed_at      timestamptz,
  reversal_reason  text,
  created_by       uuid NOT NULL REFERENCES app_user(id),
  reversed_by      uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_payment_idempotency ON payment(clinic_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_payment_invoice ON payment(invoice_id, created_at);
CREATE INDEX idx_payment_clinic_paid_at ON payment(clinic_id, paid_at);
-- Revenue worklist: completed payments only.
CREATE INDEX idx_payment_completed ON payment(clinic_id, paid_at)
  WHERE status = 'completed';

-- A recorded payment is a financial fact: amount, invoice, method and paid_at can
-- never change. The only permitted mutation is a governed reversal, which sets
-- status='reversed' + reversed_at/by/reason and touches nothing else. DELETE is
-- always blocked.
CREATE OR REPLACE FUNCTION billing_payment_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment is append-only; DELETE is not permitted';
  END IF;
  IF NEW.amount_minor <> OLD.amount_minor
     OR NEW.invoice_id <> OLD.invoice_id
     OR NEW.currency <> OLD.currency
     OR NEW.method <> OLD.method
     OR NEW.paid_at <> OLD.paid_at
     OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'payment is immutable; only a governed reversal may change it';
  END IF;
  IF OLD.status = 'reversed' THEN
    RAISE EXCEPTION 'payment is already reversed; it cannot change again';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_payment_immutable
  BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION billing_payment_immutable();
