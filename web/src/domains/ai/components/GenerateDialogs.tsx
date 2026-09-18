import { useState, type FormEvent } from 'react';
import { Dialog } from '../../../components/ui/overlays.js';
import { Button, Alert } from '../../../components/ui/index.js';
import { Input, Select } from '../../../components/ui/fields.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import { createIntakeDraft, generateSummary, type AIDraft } from '../api/ai.js';

/** Intake extraction dialog — text → structured intake DRAFT (review-first). */
export function IntakeDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: AIDraft) => void }): JSX.Element {
  const { t } = useI18n();
  const [subjectType, setSubjectType] = useState<'patient' | 'encounter'>('patient');
  const [subjectId, setSubjectId] = useState('');
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const err: Record<string, string> = {};
    if (subjectId.trim().length < 8) err.subject = t('ai.intake.err.subject');
    if (text.trim().length < 1) err.text = t('ai.intake.err.text');
    setErrors(err);
    if (Object.keys(err).length) return;
    setBusy(true);
    setFormError(null);
    try {
      onCreated(await createIntakeDraft({ subjectType, subjectId: subjectId.trim(), text: text.trim() }));
    } catch (er) {
      setFormError(er instanceof ApiError ? er.message : t('ai.err.load'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('ai.intake.title')} closeLabel={t('common.close')}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Select label={t('ai.intake.subjectType')} value={subjectType} onChange={(e) => setSubjectType(e.target.value as 'patient' | 'encounter')}>
          <option value="patient">patient</option>
          <option value="encounter">encounter</option>
        </Select>
        <Input label={t('ai.intake.subjectId')} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} error={errors.subject} />
        <label className="mc-field">
          <span className="mc-field__label">{t('ai.intake.text')}</span>
          <textarea className="mc-input" rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('ai.intake.text')} />
          {errors.text && <span className="mc-field__error" role="alert">{errors.text}</span>}
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy}>{t('ai.intake.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Summary generation dialog — grounded patient summary DRAFT (review-first). */
export function SummaryDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: AIDraft) => void }): JSX.Element {
  const { t } = useI18n();
  const [patientId, setPatientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (patientId.trim().length < 8) { setError(t('ai.intake.err.subject')); return; }
    setError(undefined);
    setBusy(true);
    setFormError(null);
    try {
      onCreated(await generateSummary(patientId.trim()));
    } catch (er) {
      setFormError(er instanceof ApiError ? er.message : t('ai.err.load'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('ai.summary.title')} closeLabel={t('common.close')}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Input label={t('ai.summary.patientId')} value={patientId} onChange={(e) => setPatientId(e.target.value)} error={error} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button type="button" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy}>{t('ai.summary.submit')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
