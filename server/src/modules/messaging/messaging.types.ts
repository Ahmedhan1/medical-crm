/**
 * Messaging domain types + the vendor-agnostic provider contract (blueprint §39).
 *
 * No provider is hard-coded anywhere. Application code depends only on
 * `MessagingProvider`; a concrete vendor (WhatsApp Business API, an SMS gateway,
 * an SMTP relay) is registered at the edge and can be swapped without touching
 * business logic. The default is a local no-op provider so tests and offline
 * clinics work with zero external dependencies.
 */

export type Channel = 'whatsapp' | 'sms' | 'email';

export const CHANNELS: readonly Channel[] = ['whatsapp', 'sms', 'email'] as const;

/**
 * A fully-resolved outbound message handed to a provider. `to` and `body` may
 * contain patient-identifiable content (a phone number, a name) — that is the
 * one authorized place PHI crosses to an external system, and it is NEVER
 * persisted to `message_log`. The provider transmits it in-memory only.
 */
export interface OutboundMessage {
  channel: Channel;
  to: string;
  body: string;
  templateKey?: string;
}

export interface ProviderSendResult {
  status: 'sent' | 'failed';
  /** Provider-assigned id used to correlate later delivery-status callbacks. */
  providerRef?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * The single interface every messaging vendor adapter implements. Keep it
 * minimal: given a resolved message, transmit it and report a result. Retry,
 * consent, logging and idempotency are handled by the messaging service, not
 * the provider, so adapters stay thin and interchangeable.
 */
export interface MessagingProvider {
  readonly id: string;
  readonly channels: readonly Channel[];
  send(message: OutboundMessage): Promise<ProviderSendResult>;
}

export type MessageStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'dead';

export interface MessageRecord {
  id: string;
  clinicId: string;
  patientId: string | null;
  channel: Channel;
  provider: string;
  templateKey: string | null;
  recipientMasked: string | null;
  status: MessageStatus;
  suppressedReason: string | null;
  providerRef: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
