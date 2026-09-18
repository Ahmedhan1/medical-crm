import type { Provenance, VerificationStatus } from '../pharma/provenance.js';

/**
 * HCO master-data types (migrations 0307 / 0308).
 *
 * The organisation side of the HCP master: the organisation itself, its public
 * business identifiers, its physical sites, its departments, and the read-model
 * pieces the HCO 360 view composes. Nothing here describes a patient or a care
 * episode — an HCO is a commercial and professional counterparty (§45).
 */

/** Who owns the organisation. Drives engagement rules and segmentation. */
export type OwnershipType =
  | 'public'
  | 'private'
  | 'ngo'
  | 'university'
  | 'military'
  | 'religious'
  | 'mixed'
  | 'unknown';

/**
 * Whether the organisation (or site, or department) is actually operating.
 * Distinct from `isActive`, which is a flag on the RECORD: a site can be closed
 * in the world while its record stays active and useful for history.
 */
export type OperatingStatus = 'active' | 'suspended' | 'closed' | 'merged';

export type HcoType =
  | 'hospital'
  | 'clinic'
  | 'pharmacy'
  | 'university'
  | 'laboratory'
  | 'group_practice'
  | 'ministry'
  | 'other';

/** A healthcare organization (hospital, clinic, pharmacy, university…). */
export interface Hco {
  id: string;
  clinicId: string;
  name: string;
  hcoType: HcoType;
  parentHcoId: string | null;
  ownershipType: OwnershipType;
  operatingStatus: OperatingStatus;
  /** Identity resolution: a merged organisation points at its survivor. */
  mergedIntoHcoId: string | null;
  country: string;
  region: string | null;
  city: string | null;
  addressLine: string | null;
  postalCode: string | null;
  provenance: Provenance;
  /** Validity window of the organisation record itself. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** When the current verification lapses; null means no expiry was set. */
  verificationExpiresAt: string | null;
  /** Why the record was rejected or suspended. */
  verificationNote: string | null;
  recordVersion: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A PUBLIC BUSINESS identifier of the organisation — a registration, facility
 * licence or tax number published in a commercial or health-authority register.
 * Never an identifier belonging to a person; the service allow-list refuses
 * those, exactly as `hcp_identifier` refuses civil identity documents.
 */
export interface HcoIdentifier {
  id: string;
  hcoId: string;
  identifierSystem: string;
  identifierValue: string;
  issuingJurisdiction: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  sourceVersion: string | null;
  sourceDate: string | null;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
}

/** A physical site of an organisation. */
export interface HcoLocation {
  id: string;
  clinicId: string;
  hcoId: string;
  label: string;
  addressLine: string | null;
  city: string | null;
  region: string | null;
  country: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  territoryId: string | null;
  isPrimary: boolean;
  operatingStatus: OperatingStatus;
  provenance: Provenance;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  verificationExpiresAt: string | null;
  verificationNote: string | null;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** An organisational unit, optionally sited at one location. */
export interface HcoDepartment {
  id: string;
  clinicId: string;
  hcoId: string;
  hcoLocationId: string | null;
  name: string;
  /** Optional: plenty of real departments map to no clinical specialty. */
  specialtyId: string | null;
  specialtyDisplayName: string | null;
  operatingStatus: OperatingStatus;
  provenance: Provenance;
  verificationExpiresAt: string | null;
  verificationNote: string | null;
  recordVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Append-only history for a site or a department (0313).
 *
 * Deliberately the same shape as {@link HcoRevision}: a reader who has learned
 * to read one organisation's history can read a site's without relearning it.
 */
export interface HcoComponentRevision {
  recordVersion: number;
  changeType: 'create' | 'update' | 'verify' | 'status_change' | 'verification_expired';
  changedFields: string[];
  source: string;
  changedBy: string | null;
  changedAt: string;
}

/** Append-only master-data history for an organisation. */
export interface HcoRevision {
  recordVersion: number;
  changeType:
    | 'create'
    | 'update'
    | 'verify'
    | 'status_change'
    | 'merge'
    /** Written by the expiry sweep, so an automatic lapse is distinguishable
     *  from a human decision in the history. */
    | 'verification_expired';
  changedFields: string[];
  source: string;
  changedBy: string | null;
  changedAt: string;
}

/** An HCP affiliated to this organisation, as the 360 view presents them. */
export interface AffiliatedHcp {
  hcpId: string;
  fullName: string;
  professionalCategory: string;
  /** The HCP's primary specialty, when one is recorded. */
  specialtyId: string | null;
  specialtyDisplayName: string | null;
  affiliationId: string;
  affiliationType: string;
  roleTitle: string | null;
  /** The governed department link (0308), when the affiliation carries one. */
  departmentId: string | null;
  departmentName: string | null;
  /** The pre-0308 free-text value, kept and shown as legacy. */
  legacyDepartment: string | null;
  startDate: string | null;
  endDate: string | null;
  verificationStatus: VerificationStatus;
}

/** Specialty coverage of an organisation, derived from its affiliated HCPs. */
export interface SpecialtyCoverage {
  specialtyId: string;
  code: string;
  displayName: string;
  /** How many currently affiliated HCPs practise it. */
  hcpCount: number;
}
