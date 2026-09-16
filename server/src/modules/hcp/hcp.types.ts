import type { Provenance, VerificationStatus } from '../pharma/provenance.js';

/**
 * The HCO master lives in `hco.types.ts` (migrations 0307/0308). It is
 * re-exported here so existing importers keep working and, more importantly, so
 * there is exactly ONE definition of an organisation in the codebase.
 */
export type { Hco, HcoType, OwnershipType, OperatingStatus } from './hco.types.js';

/** The physician / healthcare-professional master record. */
export interface Hcp {
  id: string;
  clinicId: string;
  /** Which kind of healthcare professional this record describes. */
  professionalCategory:
    | 'physician'
    | 'pharmacist'
    | 'dentist'
    | 'nurse'
    | 'veterinarian'
    | 'researcher'
    | 'allied_health'
    | 'other';
  fullName: string;
  givenName: string | null;
  familyName: string | null;
  title: string | null;
  primarySpecialtyId: string | null;
  professionalEmail: string | null;
  professionalPhone: string | null;
  preferredLanguage: string | null;
  notes: string | null;
  provenance: Provenance;
  recordVersion: number;
  status: 'active' | 'inactive' | 'retired' | 'merged';
  mergedIntoHcpId: string | null;
  /** Validity window of the professional record itself. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** When the current verification lapses; null means no expiry was set. */
  verificationExpiresAt: string | null;
  /** Why the record was rejected or suspended. */
  verificationNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Specialty {
  id: string;
  clinicId: string;
  taxonomy: string;
  code: string;
  displayName: string;
  parentId: string | null;
  source: string;
  sourceVersion: string | null;
  jurisdiction: string | null;
  lastVerifiedAt: string | null;
}

export interface HcpIdentifier {
  id: string;
  hcpId: string;
  identifierSystem: string;
  identifierValue: string;
  issuingJurisdiction: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  sourceVersion: string | null;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
}

export interface HcpAffiliation {
  id: string;
  hcpId: string;
  hcoId: string;
  hcoName: string | null;
  /** The governed department link (0308), when the affiliation carries one. */
  hcoDepartmentId?: string | null;
  /** The pre-0308 free-text department. Legacy; prefer `hcoDepartmentId`. */
  department: string | null;
  roleTitle: string | null;
  affiliationType: 'primary' | 'secondary' | 'academic' | 'consulting' | 'honorary';
  startDate: string | null;
  endDate: string | null;
  source: string;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
  confidence: number | null;
}

export interface PracticeLocation {
  id: string;
  hcpId: string;
  hcoId: string | null;
  label: string | null;
  addressLine: string | null;
  city: string | null;
  region: string | null;
  country: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  visitingHours: Record<string, unknown>;
  isPrimary: boolean;
  territoryId: string | null;
  source: string;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
}

export interface ProfessionalInterest {
  id: string;
  hcpId: string;
  interest: string;
  interestType: 'therapeutic_area' | 'research' | 'education' | 'digital' | 'other';
  strength: 'low' | 'medium' | 'high';
  source: string;
  confidence: number | null;
}

export interface HcpCredential {
  id: string;
  hcpId: string;
  credentialType: 'degree' | 'board_certification' | 'fellowship' | 'licence' | 'training' | 'other';
  credentialCode: string | null;
  credentialName: string;
  issuingBody: string | null;
  issuingJurisdiction: string | null;
  awardedOn: string | null;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  sourceDate: string | null;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
  confidence: number | null;
}

/** Where a single HCP attribute came from, resolved from the revision history. */
export interface AttributeProvenance {
  attribute: string;
  source: string;
  recordVersion: number;
  changedAt: string;
  changedBy: string | null;
  changeType: string;
}

export interface HcpSpecialtyLink {
  specialtyId: string;
  code: string;
  displayName: string;
  taxonomy: string;
  /** True when the specialty hangs off a parent in the taxonomy. */
  isSubspecialty: boolean;
  isPrimary: boolean;
  source: string;
  confidence: number | null;
}

export interface HcpRevision {
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
