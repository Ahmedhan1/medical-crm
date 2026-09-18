import { api } from '../../../lib/api/client.js';

/**
 * Messaging setup API — WhatsApp connection lifecycle + consent visibility over
 * the EXISTING Agent-3 endpoints. No credential is ever sent from or returned to
 * the client; the pairing QR is transient. Backend enforces RBAC/tenant.
 */
export type WaStatus = 'disconnected' | 'pairing' | 'connected' | 'error';
export interface WhatsAppStatus {
  provider: string;
  configured: boolean;
  status: WaStatus;
  phoneMasked: string | null;
  lastErrorCode: string | null;
  pairedAt: string | null;
  lastStatusAt: string | null;
}
export interface PairResult { qr: string; expiresInSeconds?: number; status: WhatsAppStatus }

export function getWhatsAppStatus(signal?: AbortSignal): Promise<WhatsAppStatus> {
  return api.get<WhatsAppStatus>('/whatsapp/status', { signal });
}
export function pairWhatsApp(): Promise<PairResult> {
  return api.post<PairResult>('/whatsapp/pair');
}
export function reconnectWhatsApp(): Promise<WhatsAppStatus> {
  return api.post<WhatsAppStatus>('/whatsapp/reconnect');
}
export function disconnectWhatsApp(): Promise<WhatsAppStatus> {
  return api.post<WhatsAppStatus>('/whatsapp/disconnect');
}

// --- Consent visibility ---------------------------------------------------
export type ConsentStatus = 'opted_in' | 'opted_out' | 'unknown';
export interface ConsentRecord { patientId: string; channel: 'whatsapp' | 'sms' | 'email'; status: ConsentStatus; updatedAt: string }
export function getConsents(patientId: string, signal?: AbortSignal): Promise<ConsentRecord[]> {
  return api.get<{ consents: ConsentRecord[] }>(`/consent/${patientId}`, { signal }).then((r) => r.consents);
}
