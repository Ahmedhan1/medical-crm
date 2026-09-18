import { useState, type FormEvent } from 'react';
import { Dialog, Input, Select, Button, Alert, useToast } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import {
  registerPatient,
  type PatientSex,
  type PatientSummary,
  type RegisterPatientBody,
} from '../api/clinical.js';

const SEXES: PatientSex[] = ['male', 'female', 'other', 'unknown'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Register-patient dialog. Client-side validation mirrors the backend schema for
 * fast feedback only; the backend re-validates and remains authoritative. A soft
 * duplicate (409) surfaces a confirm-to-override step rather than silently
 * creating a duplicate record.
 */
export function RegisterPatientDialog({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  onRegistered: (patient: PatientSummary) => void;
}): JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [fullName, setFullName] = useState('');
  const [sex, setSex] = useState<PatientSex>('unknown');
  const [birthDate, setBirthDate] = useState('');
  const [phone, setPhone] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [errors, setErrors] = useState<{ fullName?: string; birthDate?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset(): void {
    setFullName('');
    setSex('unknown');
    setBirthDate('');
    setPhone('');
    setNationalId('');
    setErrors({});
    setFormError(null);
    setDuplicate(false);
    setSubmitting(false);
  }

  function close(): void {
    reset();
    onClose();
  }

  function validate(): boolean {
    const next: { fullName?: string; birthDate?: string } = {};
    if (fullName.trim().length < 2) next.fullName = t('clinical.register.err.fullName');
    if (birthDate.trim() && !DATE_RE.test(birthDate.trim()))
      next.birthDate = t('clinical.register.err.birthDate');
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(e: FormEvent, overrideDuplicate = false): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (!validate()) return;
    const body: RegisterPatientBody = {
      fullName: fullName.trim(),
      sex,
      ...(birthDate.trim() ? { birthDate: birthDate.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(nationalId.trim() ? { nationalId: nationalId.trim() } : {}),
      ...(overrideDuplicate ? { overrideDuplicate: true } : {}),
    };
    setSubmitting(true);
    try {
      const patient = await registerPatient(body);
      toast.notify(t('clinical.register.success'), 'success');
      reset();
      onRegistered(patient);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      // A soft name+phone duplicate is a 409 the user can consciously override;
      // a hard duplicate (national id) stays a plain error message.
      const details = (apiErr?.details ?? null) as { existingPatientId?: string } | null;
      if (apiErr?.status === 409 && details?.existingPatientId) {
        setDuplicate(true);
        setFormError(t('clinical.register.duplicate'));
      } else {
        setFormError(apiErr?.message ?? t('clinical.err.load'));
      }
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title={t('clinical.register.title')} closeLabel={t('common.close')}>
      <form onSubmit={(e) => submit(e)} noValidate>
        {formError && (
          <Alert tone={duplicate ? 'warning' : 'danger'} role="alert">
            {formError}
          </Alert>
        )}
        <Input
          label={t('clinical.register.fullName')}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errors.fullName}
          required
          autoFocus
        />
        <Select
          label={t('clinical.register.sex')}
          value={sex}
          onChange={(e) => setSex(e.target.value as PatientSex)}
        >
          {SEXES.map((s) => (
            <option key={s} value={s}>
              {t(`clinical.sex.${s}`)}
            </option>
          ))}
        </Select>
        <Input
          label={t('clinical.register.birthDate')}
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          error={errors.birthDate}
          placeholder="YYYY-MM-DD"
          inputMode="numeric"
        />
        <Input
          label={t('clinical.register.phone')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
        />
        <Input
          label={t('clinical.register.nationalId')}
          value={nationalId}
          onChange={(e) => setNationalId(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBlockStart: 12 }}>
          <Button type="button" variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          {duplicate ? (
            <Button type="button" variant="danger" loading={submitting} onClick={(e) => submit(e, true)}>
              {t('clinical.register.submit')}
            </Button>
          ) : (
            <Button type="submit" loading={submitting}>
              {t('clinical.register.submit')}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
