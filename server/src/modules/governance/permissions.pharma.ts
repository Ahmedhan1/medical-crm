import { RoleKey, type WorkstreamPermissions } from './roles.js';

/**
 * PHARMA / HCP / DRUG / INTELLIGENCE permissions — owned by Agent 4.
 *
 * GOVERNANCE BOUNDARY (blueprint §45): pharma roles must NEVER receive any
 * patient/clinical permission. Grant pharma permissions to PHARMA_REP (and any
 * future pharma roles), never to clinical roles, and never grant clinical
 * permissions here.
 *
 * Least privilege inside pharma: anything that changes *governed* state —
 * verifying master data, approving content, managing territories, publishing an
 * intelligence signal — is deliberately NOT granted to PHARMA_REP. Following
 * CCR-005 those governed permissions are held by the purpose-built roles
 * PHARMA_DATA_STEWARD, MEDICAL_AFFAIRS and PHARMA_MANAGER (below), so ADMIN is
 * no longer the only holder. ADMIN still receives every permission automatically.
 */
export const PharmaPermission = {
  // --- HCP / HCO master data -------------------------------------------------
  HCP_READ: 'hcp:read',
  HCP_SEARCH: 'hcp:search',
  /** Create/update an HCP record. Rep-authored records land as `unverified`. */
  HCP_WRITE: 'hcp:write',
  /** Promote an HCP record to `verified` — data stewardship, not field work. */
  HCP_VERIFY: 'hcp:verify',
  /** Merge duplicate HCP identities (destructive to identity resolution). */
  HCP_MERGE: 'hcp:merge',
  HCO_READ: 'hco:read',
  HCO_WRITE: 'hco:write',
  /**
   * Promote an organisation record to `verified` — data stewardship, not field
   * work. Separate from `hco:write` for the same reason `hcp:verify` is separate
   * from `hcp:write`: attesting that a record is true is a different act from
   * recording what someone told you.
   */
  HCO_VERIFY: 'hco:verify',
  /** Merge duplicate organisation identities (destructive to identity resolution). */
  HCO_MERGE: 'hco:merge',

  // --- Drug / medication master ---------------------------------------------
  MEDICATION_READ: 'medication:read',
  /** Steward/import path for the medication master. */
  MEDICATION_WRITE: 'medication:write',

  // --- Territory & field force ----------------------------------------------
  TERRITORY_READ: 'territory:read',
  TERRITORY_MANAGE: 'territory:manage',
  VISIT_READ: 'visit:read',
  VISIT_PLAN: 'visit:plan',
  CALL_REPORT_READ: 'callreport:read',
  CALL_REPORT_WRITE: 'callreport:write',
  SCIENTIFIC_REQUEST_READ: 'scientificrequest:read',
  SCIENTIFIC_REQUEST_WRITE: 'scientificrequest:write',
  /** Answer a scientific request — medical affairs, not the field rep. */
  SCIENTIFIC_REQUEST_FULFILL: 'scientificrequest:fulfill',

  // --- Approved scientific content ------------------------------------------
  CONTENT_READ: 'content:read',
  CONTENT_WRITE: 'content:write',
  CONTENT_APPROVE: 'content:approve',

  // --- Segmentation & campaigns ---------------------------------------------
  SEGMENT_READ: 'segment:read',
  SEGMENT_MANAGE: 'segment:manage',
  CAMPAIGN_READ: 'campaign:read',
  CAMPAIGN_MANAGE: 'campaign:manage',

  // --- Reporting & export ----------------------------------------------------
  /**
   * Bulk extraction of pharma data. Deliberately SEPARATE from every read
   * permission: being allowed to see a record on screen must not by itself
   * authorise exporting it in bulk, because an export leaves the system and is
   * rarely re-checked afterwards.
   */
  PHARMA_EXPORT: 'pharma:export',

  // --- Healthcare intelligence ----------------------------------------------
  /** Read published, threshold-gated, de-identified signals. Never raw data. */
  INTELLIGENCE_SIGNAL_READ: 'intelligence:signal-read',
  /** Run the firewall pipeline and publish signals — a governance action. */
  INTELLIGENCE_PUBLISH: 'intelligence:publish',
} as const;

export const pharmaPermissions: WorkstreamPermissions = {
  permissions: PharmaPermission,
  descriptions: {
    [PharmaPermission.HCP_READ]: 'View an HCP (physician) master record',
    [PharmaPermission.HCP_SEARCH]: 'Search the HCP master',
    [PharmaPermission.HCP_WRITE]: 'Create or update an HCP master record',
    [PharmaPermission.HCP_VERIFY]: 'Verify an HCP master record (data stewardship)',
    [PharmaPermission.HCP_MERGE]: 'Merge duplicate HCP identities',
    [PharmaPermission.HCO_READ]: 'View a healthcare organization (HCO)',
    [PharmaPermission.HCO_WRITE]: 'Create or update a healthcare organization',
    [PharmaPermission.HCO_VERIFY]: 'Verify a healthcare organization record (data stewardship)',
    [PharmaPermission.HCO_MERGE]: 'Merge duplicate healthcare organization identities',
    [PharmaPermission.MEDICATION_READ]: 'View the medication/drug master',
    [PharmaPermission.MEDICATION_WRITE]: 'Create, update or import medication master data',
    [PharmaPermission.TERRITORY_READ]: 'View territories and their HCP targets',
    [PharmaPermission.TERRITORY_MANAGE]: 'Create territories and assign reps/HCP targets',
    [PharmaPermission.VISIT_READ]: 'View HCP visits and visit plans',
    [PharmaPermission.VISIT_PLAN]: 'Plan, reschedule or cancel an HCP visit',
    [PharmaPermission.CALL_REPORT_READ]: 'View call (visit) reports',
    [PharmaPermission.CALL_REPORT_WRITE]: 'Submit a call (visit) report',
    [PharmaPermission.SCIENTIFIC_REQUEST_READ]: 'View scientific information requests',
    [PharmaPermission.SCIENTIFIC_REQUEST_WRITE]: 'Raise a scientific information request',
    [PharmaPermission.SCIENTIFIC_REQUEST_FULFILL]: 'Answer/close a scientific information request',
    [PharmaPermission.CONTENT_READ]: 'View approved scientific content',
    [PharmaPermission.CONTENT_WRITE]: 'Author or revise scientific content',
    [PharmaPermission.CONTENT_APPROVE]: 'Approve, reject or withdraw scientific content',
    [PharmaPermission.SEGMENT_READ]: 'View HCP segments',
    [PharmaPermission.SEGMENT_MANAGE]: 'Define HCP segments and their membership',
    [PharmaPermission.CAMPAIGN_READ]: 'View campaigns and their targets',
    [PharmaPermission.CAMPAIGN_MANAGE]: 'Create and manage campaigns',
    [PharmaPermission.PHARMA_EXPORT]:
      'Export pharma/HCP data in bulk (required in addition to the relevant read permission)',
    [PharmaPermission.INTELLIGENCE_SIGNAL_READ]: 'Read published aggregated intelligence signals',
    [PharmaPermission.INTELLIGENCE_PUBLISH]: 'Run the intelligence firewall and publish signals',
  },
  roleGrants: {
    // The field representative: HCP engagement workflow and read access to
    // governed reference data. No stewardship, no approval, no publication.
    [RoleKey.PHARMA_REP]: [
      PharmaPermission.HCP_READ,
      PharmaPermission.HCP_SEARCH,
      PharmaPermission.HCP_WRITE,
      PharmaPermission.HCO_READ,
      PharmaPermission.MEDICATION_READ,
      PharmaPermission.TERRITORY_READ,
      PharmaPermission.VISIT_READ,
      PharmaPermission.VISIT_PLAN,
      PharmaPermission.CALL_REPORT_READ,
      PharmaPermission.CALL_REPORT_WRITE,
      PharmaPermission.SCIENTIFIC_REQUEST_READ,
      PharmaPermission.SCIENTIFIC_REQUEST_WRITE,
      PharmaPermission.CONTENT_READ,
      PharmaPermission.SEGMENT_READ,
      PharmaPermission.CAMPAIGN_READ,
      PharmaPermission.INTELLIGENCE_SIGNAL_READ,
    ],

    // Data steward: HCP/HCO/medication master stewardship (verify, merge, write).
    // No content approval, no territory/campaign management, no publication.
    [RoleKey.PHARMA_DATA_STEWARD]: [
      PharmaPermission.PHARMA_EXPORT,
      PharmaPermission.HCP_READ,
      PharmaPermission.HCP_SEARCH,
      PharmaPermission.HCP_WRITE,
      PharmaPermission.HCP_VERIFY,
      PharmaPermission.HCP_MERGE,
      PharmaPermission.HCO_READ,
      PharmaPermission.HCO_WRITE,
      PharmaPermission.HCO_VERIFY,
      PharmaPermission.HCO_MERGE,
      PharmaPermission.MEDICATION_READ,
      PharmaPermission.MEDICATION_WRITE,
    ],

    // Medical affairs: scientific content lifecycle and scientific-request
    // fulfilment. (Author≠approver is enforced separately in the content service.)
    [RoleKey.MEDICAL_AFFAIRS]: [
      PharmaPermission.HCP_READ,
      PharmaPermission.HCP_SEARCH,
      PharmaPermission.HCO_READ,
      PharmaPermission.MEDICATION_READ,
      PharmaPermission.SCIENTIFIC_REQUEST_READ,
      // 0310 gave a request a `source_channel`: a medical-information line, an
      // email or a congress question arrives at medical affairs directly, with
      // no representative to raise it. Without this grant those channels were
      // unreachable — the schema offered them and nobody could use them.
      // Separation of duties does NOT rest on withholding this: it is enforced
      // by `assertAnswerable`, which refuses to let anyone answer the question
      // they themselves raised, whatever permissions they hold.
      PharmaPermission.SCIENTIFIC_REQUEST_WRITE,
      PharmaPermission.SCIENTIFIC_REQUEST_FULFILL,
      PharmaPermission.CONTENT_READ,
      PharmaPermission.CONTENT_WRITE,
      PharmaPermission.CONTENT_APPROVE,
      PharmaPermission.INTELLIGENCE_SIGNAL_READ,
    ],

    // Pharma manager: field oversight, segmentation/campaigns and intelligence
    // publication. No master-data verification, no content approval.
    [RoleKey.PHARMA_MANAGER]: [
      PharmaPermission.PHARMA_EXPORT,
      PharmaPermission.HCP_READ,
      PharmaPermission.HCP_SEARCH,
      PharmaPermission.HCO_READ,
      PharmaPermission.MEDICATION_READ,
      PharmaPermission.TERRITORY_READ,
      PharmaPermission.TERRITORY_MANAGE,
      PharmaPermission.VISIT_READ,
      PharmaPermission.CALL_REPORT_READ,
      PharmaPermission.SCIENTIFIC_REQUEST_READ,
      PharmaPermission.CONTENT_READ,
      PharmaPermission.SEGMENT_READ,
      PharmaPermission.SEGMENT_MANAGE,
      PharmaPermission.CAMPAIGN_READ,
      PharmaPermission.CAMPAIGN_MANAGE,
      PharmaPermission.INTELLIGENCE_SIGNAL_READ,
      PharmaPermission.INTELLIGENCE_PUBLISH,
    ],
  },
};
