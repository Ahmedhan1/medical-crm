import { useState, type FormEvent } from 'react';
import { Dialog } from '../../../components/ui/overlays.js';
import { Button, Alert } from '../../../components/ui/index.js';
import { Input, Select } from '../../../components/ui/fields.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import { createRule, type AutomationRule } from '../api/automation.js';

/**
 * Minimal rule builder for the common case: on an event, send a message via a
 * template. It creates a single `send_message` action; richer condition/action
 * editing is exposed read-only on the detail page. The backend validates the
 * full rule shape, so this dialog only needs the required fields.
 */
export function NewRuleDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (rule: AutomationRule) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState('');
  const [channel, setChannel] = useState<'whatsapp' | 'sms' | 'email'>('whatsapp');
  const [templateKey, setTemplateKey] = useState('');
  const [priority, setPriority] = useState('100');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (name.trim().length < 1) e.name = t('auto.form.err.name');
    if (eventType.trim().length < 1) e.event = t('auto.form.err.event');
    if (templateKey.trim().length < 1) e.template = t('auto.form.err.template');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setFormError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const rule = await createRule({
        name: name.trim(),
        triggerType: 'event',
        eventType: eventType.trim(),
        actions: [{ type: 'send_message', params: { channel, templateKey: templateKey.trim() } }],
        priority: Number(priority) || 100,
      });
      onCreated(rule);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : t('auto.err.load'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('auto.rules.new')} closeLabel={t('common.close')}>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Input label={t('auto.form.name')} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        <Input label={t('auto.form.eventType')} value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="PATIENT_CHECKED_IN" error={errors.event} />
        <Select label={t('auto.form.channel')} value={channel} onChange={(e) => setChannel(e.target.value as 'whatsapp' | 'sms' | 'email')}>
          <option value="whatsapp">WhatsApp</option>
          <option value="sms">SMS</option>
          <option value="email">Email</option>
        </Select>
        <Input label={t('auto.form.template')} value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} placeholder="appointment_reminder" error={errors.template} />
        <Input label={t('auto.form.priority')} type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={submitting}>{t('auto.form.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
