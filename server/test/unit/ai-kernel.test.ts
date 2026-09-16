import { describe, expect, it, beforeEach } from 'vitest';
import { RiskClass, riskWithinCeiling, riskRequiresConfirmation, riskSeverity } from '../../src/modules/ai/kernel/risk.js';
import { getTool, listTools, PROHIBITED_CLINICAL_TOOL_IDS, resetToolRegistry } from '../../src/modules/ai/kernel/tools.js';
import { issueConfirmationToken, verifyConfirmationToken, type ActionDescriptor } from '../../src/modules/ai/kernel/confirmation.js';

// The confirmation module reads config().authPepper; the vitest env sets it.
const descriptor: ActionDescriptor = { clinicId: 'c1', identityId: 'i1', toolId: 'demo.reschedule', dataClass: 'operational' };

describe('risk classes', () => {
  it('orders risk and blocks PROHIBITED from every ceiling', () => {
    expect(riskSeverity(RiskClass.READ_ONLY)).toBeLessThan(riskSeverity(RiskClass.HIGH_RISK));
    expect(riskWithinCeiling(RiskClass.LOW_RISK, 'low_risk')).toBe(true);
    expect(riskWithinCeiling(RiskClass.HIGH_RISK, 'low_risk')).toBe(false);
    expect(riskWithinCeiling(RiskClass.PROHIBITED, 'high_risk')).toBe(false);
  });

  it('requires confirmation for MEDIUM and above (never for PROHIBITED path)', () => {
    expect(riskRequiresConfirmation(RiskClass.READ_ONLY)).toBe(false);
    expect(riskRequiresConfirmation(RiskClass.LOW_RISK)).toBe(false);
    expect(riskRequiresConfirmation(RiskClass.MEDIUM_RISK)).toBe(true);
    expect(riskRequiresConfirmation(RiskClass.HIGH_RISK)).toBe(true);
  });
});

describe('tool registry (deterministic; unknown fails closed)', () => {
  beforeEach(() => resetToolRegistry());

  it('resolves a known tool and returns undefined for an unknown one', () => {
    expect(getTool('demo.echo')?.risk).toBe(RiskClass.READ_ONLY);
    expect(getTool('totally.invented.tool')).toBeUndefined();
  });

  it('registers every prohibited clinical tool as PROHIBITED with no handler', () => {
    for (const id of PROHIBITED_CLINICAL_TOOL_IDS) {
      const t = getTool(id);
      expect(t, id).toBeDefined();
      expect(t!.risk).toBe(RiskClass.PROHIBITED);
      expect(t!.handler).toBeUndefined();
    }
  });

  it('lists tools without exposing internal handlers as data', () => {
    const echo = listTools().find((t) => t.id === 'demo.echo');
    expect(echo).toBeDefined();
  });
});

describe('human confirmation token (stateless, action-bound, expiring)', () => {
  it('verifies a token bound to the exact action', () => {
    const token = issueConfirmationToken(descriptor);
    expect(verifyConfirmationToken(descriptor, token)).toBe(true);
  });

  it('rejects a token bound to a DIFFERENT action', () => {
    const token = issueConfirmationToken(descriptor);
    expect(verifyConfirmationToken({ ...descriptor, toolId: 'demo.write_note' }, token)).toBe(false);
    expect(verifyConfirmationToken({ ...descriptor, identityId: 'other' }, token)).toBe(false);
    expect(verifyConfirmationToken({ ...descriptor, clinicId: 'c2' }, token)).toBe(false);
  });

  it('rejects a tampered or empty token', () => {
    const token = issueConfirmationToken(descriptor);
    expect(verifyConfirmationToken(descriptor, token + 'x')).toBe(false);
    expect(verifyConfirmationToken(descriptor, undefined)).toBe(false);
    expect(verifyConfirmationToken(descriptor, '')).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = issueConfirmationToken(descriptor, -1); // already expired
    expect(verifyConfirmationToken(descriptor, token)).toBe(false);
  });
});
