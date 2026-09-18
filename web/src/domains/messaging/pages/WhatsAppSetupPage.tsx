import { useState } from 'react';
import { PageHeader } from '../../../components/layout/PageHeader.js';
import { Button, Badge, Card, Alert, EmptyState, ErrorState, Skeleton, type BadgeTone } from '../../../components/ui/index.js';
import { useToast } from '../../../components/ui/index.js';
import { PermissionGate } from '../../../components/auth/guards.js';
import { useI18n } from '../../../lib/i18n/I18nContext.js';
import { useQuery } from '../../../lib/api/useQuery.js';
import { formatDateTime } from '../../../lib/format/datetime.js';
import { ApiError } from '../../../lib/api/types.js';
import { getWhatsAppStatus, pairWhatsApp, reconnectWhatsApp, disconnectWhatsApp, type WhatsAppStatus, type WaStatus, type PairResult } from '../api/messaging.js';

const TONE: Record<WaStatus, BadgeTone> = { disconnected: 'neutral', pairing: 'warning', connected: 'success', error: 'danger' };

/**
 * WhatsApp (GOWA) setup: connection status, pairing (transient QR), refresh and
 * disconnect. No credential or message content is shown — only lifecycle state.
 * The pairing QR is displayed once for scanning and never stored.
 */
export function WhatsAppSetupPage(): JSX.Element {
  const { t, locale } = useI18n();
  const toast = useToast();
  const status = useQuery<WhatsAppStatus>((s) => getWhatsAppStatus(s), []);
  const [pairing, setPairing] = useState<PairResult | null>(null);
  const [busy, setBusy] = useState<'pair' | 'reconnect' | 'disconnect' | null>(null);

  async function pair(): Promise<void> {
    setBusy('pair');
    try {
      setPairing(await pairWhatsApp());
      status.refetch();
    } catch (err) {
      toast.notify(err instanceof ApiError ? err.message : t('msg.err.load'), 'error');
    } finally {
      setBusy(null);
    }
  }
  async function reconnect(): Promise<void> {
    setBusy('reconnect');
    try { await reconnectWhatsApp(); setPairing(null); status.refetch(); }
    catch (err) { toast.notify(err instanceof ApiError ? err.message : t('msg.err.load'), 'error'); }
    finally { setBusy(null); }
  }
  async function disconnect(): Promise<void> {
    setBusy('disconnect');
    try { await disconnectWhatsApp(); setPairing(null); toast.notify(t('msg.wa.disconnected.ok'), 'success'); status.refetch(); }
    catch (err) { toast.notify(err instanceof ApiError ? err.message : t('msg.err.load'), 'error'); }
    finally { setBusy(null); }
  }

  if (status.loading) return <Skeleton height={200} />;
  if (status.error || !status.data) return <ErrorState title={t('msg.err.load')} body={status.error?.message} onRetry={status.refetch} retryLabel={t('common.retry')} />;
  const s = status.data;

  return (
    <div>
      <PageHeader title={t('msg.wa.title')} subtitle={t('msg.wa.subtitle')} />

      {!s.configured ? (
        <Card><EmptyState title={t('msg.wa.notConfigured.title')} body={t('msg.wa.notConfigured.body')} /></Card>
      ) : (
        <>
          <Card title={t('msg.wa.status')}>
            <p><Badge tone={TONE[s.status]}>{t(`msg.wa.status.${s.status}`)}</Badge></p>
            {s.phoneMasked && <p>{t('msg.wa.device')}: <code>{s.phoneMasked}</code></p>}
            {s.lastErrorCode && <p>{t('msg.wa.lastError')}: <code>{s.lastErrorCode}</code></p>}
            {s.lastStatusAt && <p className="mc-muted">{t('msg.wa.lastStatus')}: {formatDateTime(s.lastStatusAt, locale)}</p>}
            <div style={{ display: 'flex', gap: 8, marginBlockStart: 12, flexWrap: 'wrap' }}>
              <PermissionGate permission="messaging:manage">
                <Button onClick={pair} loading={busy === 'pair'}>{t('msg.wa.pair')}</Button>
                <Button variant="secondary" onClick={reconnect} loading={busy === 'reconnect'}>{t('msg.wa.reconnect')}</Button>
                {s.status === 'connected' && <Button variant="ghost" onClick={disconnect} loading={busy === 'disconnect'}>{t('msg.wa.disconnect')}</Button>}
              </PermissionGate>
            </div>
            <Alert tone="info">{t('msg.wa.safeNote')}</Alert>
          </Card>

          {pairing && (
            <Card title={t('msg.wa.scan.title')}>
              <p>{t('msg.wa.scan.body')}</p>
              {pairing.qr.startsWith('http') ? (
                <p><a href={pairing.qr} target="_blank" rel="noreferrer">{pairing.qr}</a></p>
              ) : (
                <pre className="mc-code" aria-label="whatsapp-qr" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{pairing.qr}</pre>
              )}
              {pairing.expiresInSeconds != null && <p className="mc-muted">{t('msg.wa.scan.expires').replace('{n}', String(pairing.expiresInSeconds))}</p>}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
