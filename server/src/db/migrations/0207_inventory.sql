-- ============================================================================
-- MEDCORE 0207_inventory  (Agent 3 — Inventory / stock control)
--
-- A production inventory domain for a clinic/pharmacy: what is stocked, where it
-- is held, in what batches, how much is on hand, and an append-only ledger of
-- every mutation. Designed around three invariants:
--
--   1. TENANT SCOPE. Every row carries clinic_id; nothing is visible or mutable
--      across clinics. Enforced in the services and by these FKs.
--   2. AUDITABLE HISTORY. `stock_movement` is an append-only ledger — the running
--      `stock_balance` is a materialised convenience, never the source of truth.
--      Corrections are new ADJUSTMENT rows, never edits (append-only trigger).
--   3. CORRECTNESS UNDER CONCURRENCY. Balances are only ever changed inside a
--      transaction that takes a row lock (SELECT ... FOR UPDATE) on the balance
--      row, and a CHECK (on_hand >= 0) is the database-level backstop so stock
--      can never go negative unless a product explicitly allows it.
--
-- BILLING BOUNDARY (Agent 2 owns Billing): a product may carry `is_billable`,
-- an optional `billing_code` and `unit_price` as REFERENCE METADATA only. This
-- migration creates NO invoice/payment/revenue tables and no financial logic —
-- when Billing needs a price it reads these fields through Agent 2's own
-- contract. Inventory never charges anything.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- LOCATION — a place stock is physically held (main store, dispensary, fridge,
-- a branch room). Not the clinic itself; a clinic can have many locations.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_location (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  code          text NOT NULL,                          -- short human code, e.g. 'MAIN'
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'store'
                  CHECK (kind IN ('store','dispensary','room','cold_chain','other')),
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_inventory_location_code ON inventory_location(clinic_id, lower(code));
CREATE INDEX idx_inventory_location_clinic ON inventory_location(clinic_id);

-- ---------------------------------------------------------------------------
-- PRODUCT — the stocked item (a consumable, a device, or a marketed medication
-- product). `medication_product_id` OPTIONALLY links a stocked item to the drug
-- master (0301) so a pharmacy item reuses the canonical product rather than
-- duplicating it — the link is nullable so non-drug supplies are first class.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_product (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  sku                   text NOT NULL,                  -- clinic-unique stock code
  name                  text NOT NULL,
  category              text,                           -- free-form grouping
  unit_of_measure       text NOT NULL DEFAULT 'unit',   -- 'unit','box','ml','mg','vial'
  -- Optional reuse of the drug master (0301). A SOFT reference (no FK) on
  -- purpose: it keeps this migration self-contained within the inventory range
  -- rather than ordering-dependent on the later pharma range, and existence +
  -- clinic scope are validated in the service on write. No duplicate drug concept.
  medication_product_id uuid,
  -- lifecycle controls
  is_batch_tracked      boolean NOT NULL DEFAULT false, -- requires a batch on every movement
  is_expiry_tracked     boolean NOT NULL DEFAULT false, -- batches must carry an expiry
  block_expired_issue   boolean NOT NULL DEFAULT true,  -- refuse ISSUE from an expired batch
  allow_negative_stock  boolean NOT NULL DEFAULT false, -- escape hatch, off by default
  -- low-stock (PERSISTED thresholds — never hardcoded in code)
  reorder_threshold     numeric(14,3) CHECK (reorder_threshold IS NULL OR reorder_threshold >= 0),
  reorder_quantity      numeric(14,3) CHECK (reorder_quantity IS NULL OR reorder_quantity > 0),
  -- billing REFERENCE metadata only (Agent 2 owns Billing; no financial logic here)
  is_billable           boolean NOT NULL DEFAULT false,
  billing_code          text,
  unit_price            numeric(14,4) CHECK (unit_price IS NULL OR unit_price >= 0),
  unit_cost             numeric(14,4) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- an expiry-tracked product must be batch-tracked (an expiry lives on a batch)
  CONSTRAINT product_expiry_requires_batch
    CHECK (is_expiry_tracked = false OR is_batch_tracked = true)
);
CREATE UNIQUE INDEX uq_inventory_product_sku ON inventory_product(clinic_id, lower(sku));
CREATE INDEX idx_inventory_product_clinic ON inventory_product(clinic_id);
CREATE INDEX idx_inventory_product_category ON inventory_product(clinic_id, lower(category));
CREATE INDEX idx_inventory_product_medlink ON inventory_product(medication_product_id)
  WHERE medication_product_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- BATCH / LOT — a received lot of a batch-tracked product, with its expiry.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_batch (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  product_id    uuid NOT NULL REFERENCES inventory_product(id) ON DELETE RESTRICT,
  lot_number    text NOT NULL,
  expiry_date   date,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- One lot number per product (per clinic).
CREATE UNIQUE INDEX uq_inventory_batch_lot
  ON inventory_batch(clinic_id, product_id, lower(lot_number));
CREATE INDEX idx_inventory_batch_product ON inventory_batch(clinic_id, product_id);
CREATE INDEX idx_inventory_batch_expiry ON inventory_batch(clinic_id, expiry_date)
  WHERE expiry_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- STOCK BALANCE — materialised on-hand per (product, location, batch). This is
-- a convenience derived from the movement ledger, protected by a row lock on
-- write and a hard non-negative CHECK. `batch_key` is a generated column that
-- lets a single UNIQUE constraint cover both batch-tracked and untracked rows
-- (a NULL batch would otherwise defeat uniqueness), and gives ON CONFLICT a
-- stable target.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_balance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  product_id    uuid NOT NULL REFERENCES inventory_product(id) ON DELETE RESTRICT,
  location_id   uuid NOT NULL REFERENCES inventory_location(id) ON DELETE RESTRICT,
  batch_id      uuid REFERENCES inventory_batch(id) ON DELETE RESTRICT,
  batch_key     uuid NOT NULL GENERATED ALWAYS AS
                  (COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  on_hand       numeric(14,3) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  version       integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_balance UNIQUE (clinic_id, product_id, location_id, batch_key)
);
CREATE INDEX idx_stock_balance_product ON stock_balance(clinic_id, product_id);
CREATE INDEX idx_stock_balance_location ON stock_balance(clinic_id, location_id);
CREATE INDEX idx_stock_balance_positive ON stock_balance(clinic_id, product_id) WHERE on_hand > 0;

-- ---------------------------------------------------------------------------
-- STOCK MOVEMENT — the append-only ledger. Every mutation is one or (for a
-- TRANSFER) two rows. Each row answers WHO (actor_id), WHAT (product_id),
-- WHEN (occurred_at), WHERE (location_id, + counterparty_location_id for a
-- transfer), HOW MUCH (quantity, and signed quantity_delta for summing), WHY
-- (movement_type + reason). `idempotency_key` makes a retried request a no-op
-- instead of a double movement.
-- ---------------------------------------------------------------------------
CREATE TABLE stock_movement (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                uuid NOT NULL REFERENCES clinic(id) ON DELETE RESTRICT,
  product_id               uuid NOT NULL REFERENCES inventory_product(id) ON DELETE RESTRICT,
  location_id              uuid NOT NULL REFERENCES inventory_location(id) ON DELETE RESTRICT,
  batch_id                 uuid REFERENCES inventory_batch(id) ON DELETE RESTRICT,
  movement_type            text NOT NULL
                             CHECK (movement_type IN ('RECEIVE','ISSUE','TRANSFER','ADJUSTMENT','RETURN')),
  direction                text NOT NULL CHECK (direction IN ('in','out')),
  quantity                 numeric(14,3) NOT NULL CHECK (quantity > 0),
  quantity_delta           numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  -- the other side of a transfer (source for the 'in' row, destination for 'out')
  counterparty_location_id uuid REFERENCES inventory_location(id) ON DELETE RESTRICT,
  transfer_group_id        uuid,                         -- links the two rows of a transfer
  reason                   text,
  reference                text,                         -- external ref (PO no., encounter, etc.)
  idempotency_key          text,
  balance_after            numeric(14,3) NOT NULL,       -- on_hand after this row was applied
  actor_id                 uuid REFERENCES app_user(id),
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- 'in' rows add, 'out' rows subtract: the delta sign must match the direction.
  CONSTRAINT movement_delta_sign
    CHECK ((direction = 'in' AND quantity_delta > 0) OR (direction = 'out' AND quantity_delta < 0))
);
CREATE INDEX idx_stock_movement_product ON stock_movement(clinic_id, product_id, occurred_at DESC);
CREATE INDEX idx_stock_movement_location ON stock_movement(clinic_id, location_id, occurred_at DESC);
CREATE INDEX idx_stock_movement_batch ON stock_movement(clinic_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_stock_movement_transfer ON stock_movement(transfer_group_id) WHERE transfer_group_id IS NOT NULL;
-- A retried request with the same idempotency key never creates a second movement.
CREATE UNIQUE INDEX uq_stock_movement_idem
  ON stock_movement(clinic_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The ledger is immutable: corrections are new ADJUSTMENT rows, never edits.
CREATE TRIGGER trg_stock_movement_append_only
  BEFORE UPDATE OR DELETE ON stock_movement
  FOR EACH STATEMENT EXECUTE FUNCTION medcore_append_only();
