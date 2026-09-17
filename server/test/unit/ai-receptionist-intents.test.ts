import { describe, it, expect } from 'vitest';
import { classifyReceptionistIntent } from '../../src/modules/ai/receptionist/intents.js';

/**
 * CLINICAL-1 regression: the clinical-first guard must catch INFLECTED clinical
 * terms, not only the exact stem. A trailing \b on a stem prefix used to make
 * `diagnos\b` miss "diagnose"/"diagnosis" and `prescri\b` miss
 * "prescribe"/"prescription" — under-escalating a clinical question to
 * administrative. These lock the prefix-matching fix.
 */
describe('receptionist clinical classifier catches inflected clinical terms', () => {
  const CLINICAL = [
    'can you diagnose me',
    'what is my diagnosis',
    'they diagnosed me with something',
    'please prescribe an antibiotic',
    'i need a prescription refill',
    'what treatment do you suggest',
    'is there a therapy for this',
    'i keep vomiting',
    'i feel dizzy',
    'my wound is infected',
    'what is my prognosis',
  ];
  it.each(CLINICAL)('classifies %o as clinical (escalate)', (text) => {
    const { category, intent } = classifyReceptionistIntent(text);
    expect(category).toBe('clinical');
    expect(intent).toBe('clinical_question');
  });

  const ADMINISTRATIVE = [
    'what are your opening hours',
    'where is the clinic located',
    'i want to book an appointment',
    'what documents should i bring',
  ];
  it.each(ADMINISTRATIVE)('keeps %o administrative (no false clinical escalation)', (text) => {
    expect(classifyReceptionistIntent(text).category).toBe('administrative');
  });
});
