import { useState, type FormEvent } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Alert } from '../../../components/ui/index.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { ApiError } from '../../../lib/api/types.js';
import { askReceptionist, type ReceptionistResponse } from '../api/ai.js';

/**
 * AI receptionist console. Administrative assistant only: any clinical question
 * is escalated to staff and never answered. The response makes the escalation and
 * the non-mutating nature explicit so an operator can trust the boundary.
 */
export function AiReceptionistPage(): JSX.Element {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ReceptionistResponse | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await askReceptionist(text.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ai.err.load'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title={t('ai.recep.title')} subtitle={t('ai.recep.subtitle')} />
      <Card>
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <label className="mc-field">
            <span className="mc-field__label">{t('ai.recep.input')}</span>
            <textarea className="mc-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('ai.recep.input')} />
          </label>
          <div><Button type="submit" loading={busy} disabled={!text.trim()}>{t('ai.recep.send')}</Button></div>
        </form>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}

      {res && (
        <Card title={t('ai.recep.reply')}>
          <p aria-live="polite">{res.reply}</p>
          <p>
            {t('ai.recep.category')}: <Badge tone={res.category === 'clinical' ? 'warning' : 'info'}>{res.category}</Badge>
            {' '}{t('ai.recep.action')}: <Badge tone="neutral">{res.action}</Badge>
          </p>
          {res.category === 'clinical' && <Alert tone="warning">{t('ai.recep.clinicalNotice')}</Alert>}
          <Alert tone="info">{t('ai.recep.nonMutating')}</Alert>
        </Card>
      )}
    </div>
  );
}
