import { describe, it, expect } from 'vitest';
import {
  validateAiOutput,
  type ValidationErr,
} from '../../src/modules/ai/schema/output-schemas.js';
import { SCHEMA_VERSIONS } from '../../src/modules/ai/schema/versions.js';

describe('validateAiOutput — intake_extraction', () => {
  it('accepts a valid intake output and returns the schema version', () => {
    const res = validateAiOutput('intake_extraction', {
      fields: [
        { name: 'chiefComplaint', value: 'Headache for 3 days' },
        { name: 'severity', value: '7/10', sourceSpan: [0, 12] },
      ],
      citations: [{ ref: 'evt-1', kind: 'event', quote: 'headache' }],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.schemaVersion).toBe(SCHEMA_VERSIONS.intake_extraction);
      expect(res.value.fields).toHaveLength(2);
    }
  });

  it('rejects an unknown field name', () => {
    const res = validateAiOutput('intake_extraction', {
      fields: [{ name: 'bloodType', value: 'O+' }],
      citations: [],
    });
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown extra key (strict)', () => {
    const res = validateAiOutput('intake_extraction', {
      fields: [{ name: 'notes', value: 'ok', evil: 'x' }],
      citations: [],
    });
    expect(res.ok).toBe(false);
  });

  it('rejects an empty value', () => {
    const res = validateAiOutput('intake_extraction', {
      fields: [{ name: 'notes', value: '' }],
      citations: [],
    });
    expect(res.ok).toBe(false);
  });
});

describe('validateAiOutput — summary', () => {
  it('accepts a valid summary and returns the schema version', () => {
    const res = validateAiOutput('summary', {
      summary: 'Patient seen for follow-up; stable.',
      citations: [{ ref: 'enc-9', kind: 'encounter' }],
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.schemaVersion).toBe(SCHEMA_VERSIONS.summary);
    }
  });
});

describe('validateAiOutput — PHI safety', () => {
  it('never leaks the offending input value into issues', () => {
    // The value violates the enum/strict rules AND carries a distinctive
    // marker. If it appears in issues, PHI is leaking into error messages.
    const res = validateAiOutput('intake_extraction', {
      fields: [
        {
          name: 'not_a_real_field',
          value: 'SECRET_PHI_VALUE_12345',
          patientName: 'SECRET_PHI_VALUE_12345',
        },
      ],
      citations: [],
    });

    expect(res.ok).toBe(false);
    const err = res as ValidationErr;
    expect(err.issues.length).toBeGreaterThan(0);
    expect(err.issues.join(' ')).not.toContain('SECRET_PHI_VALUE_12345');
    expect(err.schemaVersion).toBe(SCHEMA_VERSIONS.intake_extraction);
  });
});
