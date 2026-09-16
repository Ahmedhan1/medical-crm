import { NotFoundError } from '../../domain/errors.js';
import { audit } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import * as content from '../pharma/content.repo.js';
import * as field from '../pharma/field.repo.js';
import * as medaffairs from '../pharma/medaffairs.repo.js';
import { territoriesForHcp } from '../pharma/territory.repo.js';
import { assertHcpInScope } from '../pharma/visibility.js';
import * as repo from './hcp.repo.js';

/**
 * HCP 360 — the authorized single view of a healthcare professional.
 *
 * WHAT IT CONTAINS: the master record and its provenance, specialties,
 * affiliations and departments, practice locations, territories and targeting,
 * professional interests, this company's interactions (visits and call reports),
 * scientific requests, approved-content engagement, representative activity and
 * the aggregated signals relevant to the HCP's territories.
 *
 * WHAT IT DOES NOT CONTAIN, BY CONSTRUCTION: anything about a patient. There is
 * no query in this module — or anywhere reachable from it — against a clinical
 * table. "360" describes the completeness of the *professional* picture, not a
 * merge of the clinical and commercial sides of the platform (§45).
 *
 * Access is doubly scoped: the clinic (tenant) and the caller's territory. A
 * representative cannot open the 360 of an HCP outside their own territories,
 * and the read is audited.
 */
export async function hcp360(principal: Principal, hcpId: string) {
  requirePermission(principal, Permission.HCP_READ);

  const hcp = await repo.getHcpById(principal.clinicId, hcpId);
  if (!hcp) throw new NotFoundError('HCP');
  await assertHcpInScope(principal, hcpId);

  const [
    specialties,
    identifiers,
    credentials,
    affiliations,
    locations,
    interests,
    territories,
    revisions,
    visits,
    callReports,
    openObjections,
    scientificRequests,
    followUps,
    engagement,
  ] = await Promise.all([
    repo.listHcpSpecialties(principal.clinicId, hcpId),
    repo.listHcpIdentifiers(principal.clinicId, hcpId),
    repo.listCredentials(principal.clinicId, hcpId),
    repo.listAffiliations(principal.clinicId, hcpId),
    repo.listPracticeLocations(principal.clinicId, hcpId),
    repo.listInterests(principal.clinicId, hcpId),
    territoriesForHcp(principal.clinicId, hcpId),
    repo.listHcpRevisions(principal.clinicId, hcpId),
    field.listVisits(principal.clinicId, {
      repUserId: null,
      hcpId,
      hcoId: null,
      territoryIds: null,
      status: null,
      modality: null,
      from: null,
      to: null,
      limit: 20,
    }),
    field.listCallReportsForHcp(principal.clinicId, hcpId, 10),
    field.listOpenObjectionsForHcp(principal.clinicId, hcpId, 20),
    medaffairs.listScientificRequests(principal.clinicId, {
      hcpId,
      status: null,
      assignedTo: null,
      inquiryCategory: null,
      priority: null,
      breachedOnly: false,
      territoryIds: null,
      limit: 20,
    }),
    field.listFollowUps(principal.clinicId, {
      ownerUserId: null,
      hcpId,
      status: null,
      limit: 20,
    }),
    content.listEngagementForHcp(principal.clinicId, hcpId, 20),
  ]);

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'hcp.360.read',
    targetType: 'hcp',
    targetId: hcpId,
    metadata: { interactions: visits.length },
  });

  return {
    hcp,
    provenance: hcp.provenance,
    specialties,
    identifiers,
    credentials,
    affiliations,
    practiceLocations: locations,
    interests,
    territories,
    engagement: {
      visits,
      callReports,
      openObjections,
      scientificRequests,
      followUps,
      contentEngagement: engagement,
      representatives: [...new Set(visits.map((v: { repUserId: string }) => v.repUserId))],
    },
    masterDataHistory: revisions,
    dataBoundary:
      'HCP professional and engagement data only. No patient-level data participates in this view (§45).',
  };
}
