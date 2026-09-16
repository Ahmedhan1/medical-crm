import { z } from 'zod';

/**
 * Provenance is mandatory on every pharma reference record (blueprint §8, §23).
 *
 * A master-data value is only trustworthy if you can answer: where did it come
 * from, which version of that source, for which jurisdiction, when was it last
 * verified, and how confident are we? These fields are therefore required at
 * the API boundary — not optional metadata bolted on later — and they are
 * carried on `hcp`, `hco`, `specialty`, `medication`, `medication_product`,
 * affiliations, identifiers and practice locations alike.
 */
export const VerificationStatus = {
  UNVERIFIED: 'unverified',
  PENDING_REVIEW: 'pending_review',
  VERIFIED: 'verified',
  DISPUTED: 'disputed',
  RETIRED: 'retired',
} as const;
export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

/**
 * Jurisdiction is an ISO-3166 alpha-2 country code, optionally with a
 * subdivision (`EG`, `EG-C`, `US-CA`). Regulatory status, drug registration and
 * data-protection rules are all jurisdiction-specific, so a record that does not
 * say which jurisdiction it describes cannot be governed.
 */
export const JurisdictionSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, 'jurisdiction must be an ISO-3166 code such as "EG" or "US-CA"');

export const ProvenanceSchema = z.object({
  /** Where the value came from, e.g. `field_rep`, `eda_public_register`. */
  source: z.string().trim().min(2).max(120),
  /** Version/edition of that source, e.g. a dataset release or import run id. */
  sourceVersion: z.string().trim().max(120).optional(),
  /** Stable reference within the source, e.g. a record id or URL. */
  sourceRef: z.string().trim().max(500).optional(),
  jurisdiction: JurisdictionSchema,
  /** 0–1 confidence for enriched/derived values. Absent means "not scored". */
  confidence: z.number().min(0).max(1).optional(),
});

export type ProvenanceInput = z.infer<typeof ProvenanceSchema>;

/** Provenance as it is returned to callers. */
export interface Provenance {
  source: string;
  sourceVersion: string | null;
  sourceRef: string | null;
  jurisdiction: string;
  confidence: number | null;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
}

/**
 * A record created by a field representative is never "verified" — verification
 * is a stewardship act performed by a principal holding `hcp:verify`. This keeps
 * unverified field intelligence and verified master data distinguishable.
 */
export const INITIAL_VERIFICATION_STATUS: VerificationStatus = VerificationStatus.UNVERIFIED;
