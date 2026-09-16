import { describe, expect, it } from 'vitest';
import {
  Permission,
  ROLE_DEFINITIONS,
  RoleKey,
} from '../../src/modules/governance/permissions.js';
import { ClinicalPermission } from '../../src/modules/governance/permissions.clinical.js';

/**
 * CCR-005 RBAC audit: the new pharma separation-of-duties roles hold only their
 * intended governed subset, never a clinical permission, and the elevated
 * permissions are no longer ADMIN-only.
 */
const CLINICAL = new Set<string>(Object.values(ClinicalPermission));

function perms(role: RoleKey): Set<string> {
  return new Set(ROLE_DEFINITIONS[role].permissions);
}

describe('RBAC — pharma separation of duties (CCR-005)', () => {
  it('every new pharma role holds NO clinical permission', () => {
    for (const role of [
      RoleKey.PHARMA_DATA_STEWARD,
      RoleKey.MEDICAL_AFFAIRS,
      RoleKey.PHARMA_MANAGER,
    ]) {
      for (const p of ROLE_DEFINITIONS[role].permissions) {
        expect(CLINICAL.has(p), `${role} must not hold clinical ${p}`).toBe(false);
      }
    }
  });

  it('data steward can verify/merge master data but cannot approve content or publish', () => {
    const p = perms(RoleKey.PHARMA_DATA_STEWARD);
    expect(p.has(Permission.HCP_VERIFY)).toBe(true);
    expect(p.has(Permission.HCP_MERGE)).toBe(true);
    expect(p.has(Permission.MEDICATION_WRITE)).toBe(true);
    expect(p.has(Permission.CONTENT_APPROVE)).toBe(false);
    expect(p.has(Permission.INTELLIGENCE_PUBLISH)).toBe(false);
    expect(p.has(Permission.TERRITORY_MANAGE)).toBe(false);
  });

  it('medical affairs can approve content and fulfil requests but cannot manage territories/campaigns', () => {
    const p = perms(RoleKey.MEDICAL_AFFAIRS);
    expect(p.has(Permission.CONTENT_APPROVE)).toBe(true);
    expect(p.has(Permission.SCIENTIFIC_REQUEST_FULFILL)).toBe(true);
    expect(p.has(Permission.TERRITORY_MANAGE)).toBe(false);
    expect(p.has(Permission.CAMPAIGN_MANAGE)).toBe(false);
    expect(p.has(Permission.HCP_VERIFY)).toBe(false);
  });

  it('pharma manager can manage territories/campaigns and publish, but cannot verify or approve content', () => {
    const p = perms(RoleKey.PHARMA_MANAGER);
    expect(p.has(Permission.TERRITORY_MANAGE)).toBe(true);
    expect(p.has(Permission.CAMPAIGN_MANAGE)).toBe(true);
    expect(p.has(Permission.INTELLIGENCE_PUBLISH)).toBe(true);
    expect(p.has(Permission.CONTENT_APPROVE)).toBe(false);
    expect(p.has(Permission.HCP_VERIFY)).toBe(false);
  });

  it('the elevated permissions are no longer ADMIN-only (least privilege, not broadening)', () => {
    // Each elevated permission is now held by a non-ADMIN, purpose-built role.
    const holders: Array<[string, RoleKey]> = [
      [Permission.HCP_VERIFY, RoleKey.PHARMA_DATA_STEWARD],
      [Permission.CONTENT_APPROVE, RoleKey.MEDICAL_AFFAIRS],
      [Permission.INTELLIGENCE_PUBLISH, RoleKey.PHARMA_MANAGER],
    ];
    for (const [permission, role] of holders) {
      expect(perms(role).has(permission), `${role} should hold ${permission}`).toBe(true);
    }
    // ...and PHARMA_REP still holds none of them.
    const rep = perms(RoleKey.PHARMA_REP);
    for (const [permission] of holders) {
      expect(rep.has(permission)).toBe(false);
    }
  });

  it('ADMIN still receives every permission', () => {
    const admin = perms(RoleKey.ADMIN);
    for (const p of Object.values(Permission)) {
      expect(admin.has(p), `ADMIN should hold ${p}`).toBe(true);
    }
  });
});
