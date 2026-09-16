import { describe, expect, it } from 'vitest';
import { renderTemplate, templateVariables } from '../../src/modules/messaging/templates.js';
import { maskRecipient } from '../../src/modules/messaging/redact.js';
import { ValidationError } from '../../src/domain/errors.js';

describe('message template rendering', () => {
  it('substitutes only declared variables', () => {
    const body = 'Hi {{patientName}}, your visit at {{clinicName}} is confirmed.';
    expect(templateVariables(body).sort()).toEqual(['clinicName', 'patientName']);
    expect(renderTemplate(body, { patientName: 'Sara', clinicName: 'Nile Clinic' })).toBe(
      'Hi Sara, your visit at Nile Clinic is confirmed.',
    );
  });

  it('throws (does not send half-rendered copy) when a variable is missing', () => {
    expect(() => renderTemplate('Hi {{patientName}} {{mrn}}', { patientName: 'Sara' })).toThrow(ValidationError);
  });

  it('ignores supplied variables the template does not reference', () => {
    expect(renderTemplate('Hello {{firstName}}', { firstName: 'Sara', secret: 'x' })).toBe('Hello Sara');
  });
});

describe('recipient masking (no full address in the log)', () => {
  it('masks a phone keeping only a country hint and last 4', () => {
    const masked = maskRecipient('+201234567890', 'whatsapp');
    expect(masked).toMatch(/^\+20\*+7890$/);
    expect(masked).not.toContain('123456');
  });

  it('masks an email keeping only the first char and domain', () => {
    expect(maskRecipient('sara.hesham@example.com', 'email')).toMatch(/^s\*+@example\.com$/);
  });
});
