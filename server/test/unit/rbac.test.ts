import { describe, expect, it } from 'vitest';
import {
  assertSameClinic,
  hasPermission,
  requirePermission,
  type Principal,
} from '../../src/modules/governance/rbac.js';
import { Permission } from '../../src/modules/governance/permissions.js';
import { ForbiddenError } from '../../src/domain/errors.js';

function principal(perms: Permission[], clinicId = 'clinic-a'): Principal {
  return {
    userId: 'u1',
    clinicId,
    username: 'tester',
    roles: ['RECEPTION'],
    permissions: new Set(perms),
  };
}

describe('rbac', () => {
  it('grants when permission present', () => {
    const p = principal([Permission.PATIENT_READ]);
    expect(hasPermission(p, Permission.PATIENT_READ)).toBe(true);
    expect(() => requirePermission(p, Permission.PATIENT_READ)).not.toThrow();
  });

  it('denies when permission absent', () => {
    const p = principal([Permission.PATIENT_READ]);
    expect(hasPermission(p, Permission.PATIENT_REGISTER)).toBe(false);
    expect(() => requirePermission(p, Permission.PATIENT_REGISTER)).toThrow(ForbiddenError);
  });

  it('enforces clinic scope', () => {
    const p = principal([Permission.PATIENT_READ], 'clinic-a');
    expect(() => assertSameClinic(p, 'clinic-a')).not.toThrow();
    expect(() => assertSameClinic(p, 'clinic-b')).toThrow(ForbiddenError);
  });
});
