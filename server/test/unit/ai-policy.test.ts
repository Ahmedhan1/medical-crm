import { describe, expect, it } from 'vitest';
import {
  DataClass,
  classifyCapabilityInput,
  parseDataClass,
  severity,
  atLeastAsSensitive,
} from '../../src/modules/ai/classification.js';
import { decide, permitsCloud, PolicyDecision, type TenantAiPolicy } from '../../src/modules/ai/policy.js';

function policy(over: Partial<TenantAiPolicy> = {}): TenantAiPolicy {
  return { clinicId: 'c1', allowCloud: false, cloudMaxClass: DataClass.OPERATIONAL, ...over };
}

describe('data classification', () => {
  it('orders classes by sensitivity', () => {
    expect(severity(DataClass.PUBLIC)).toBeLessThan(severity(DataClass.PHI));
    expect(severity(DataClass.PHI)).toBeLessThan(severity(DataClass.HIGHLY_RESTRICTED));
    expect(atLeastAsSensitive(DataClass.PHI, DataClass.OPERATIONAL)).toBe(true);
    expect(atLeastAsSensitive(DataClass.OPERATIONAL, DataClass.PHI)).toBe(false);
  });

  it('classifies the AI capabilities operating on patient data as PHI', () => {
    expect(classifyCapabilityInput('intake_extraction')).toBe(DataClass.PHI);
    expect(classifyCapabilityInput('summary')).toBe(DataClass.PHI);
    expect(classifyCapabilityInput('transcription')).toBe(DataClass.PHI);
  });

  it('parses only known class strings', () => {
    expect(parseDataClass('phi')).toBe(DataClass.PHI);
    expect(parseDataClass('nonsense')).toBeNull();
  });
});

describe('policy engine — routing decisions (fail-closed)', () => {
  it('PHI with no cloud opt-in stays local (the default)', () => {
    expect(decide(DataClass.PHI, policy())).toBe(PolicyDecision.ALLOW_LOCAL);
  });

  it('PHI with cloud allowed but ceiling below PHI stays local', () => {
    expect(decide(DataClass.PHI, policy({ allowCloud: true, cloudMaxClass: DataClass.OPERATIONAL }))).toBe(
      PolicyDecision.ALLOW_LOCAL,
    );
  });

  it('PHI reaches cloud only when the ceiling explicitly includes PHI', () => {
    expect(decide(DataClass.PHI, policy({ allowCloud: true, cloudMaxClass: DataClass.PHI }))).toBe(
      PolicyDecision.ALLOW_CLOUD,
    );
  });

  it('operational data reaches cloud when opted in at that ceiling', () => {
    expect(decide(DataClass.OPERATIONAL, policy({ allowCloud: true, cloudMaxClass: DataClass.OPERATIONAL }))).toBe(
      PolicyDecision.ALLOW_CLOUD,
    );
  });

  it('HIGHLY_RESTRICTED never leaves the box, even fully opted in', () => {
    expect(
      decide(DataClass.HIGHLY_RESTRICTED, policy({ allowCloud: true, cloudMaxClass: DataClass.HIGHLY_RESTRICTED })),
    ).toBe(PolicyDecision.ALLOW_LOCAL);
  });

  it('permitsCloud is true only for ALLOW_CLOUD', () => {
    expect(permitsCloud(PolicyDecision.ALLOW_CLOUD)).toBe(true);
    expect(permitsCloud(PolicyDecision.ALLOW_LOCAL)).toBe(false);
    expect(permitsCloud(PolicyDecision.DENY)).toBe(false);
  });
});
