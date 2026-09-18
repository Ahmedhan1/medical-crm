import { config } from '../../../../config/env.js';
import { registerProvider } from '../registry.js';
import { GowaWhatsAppProvider, type WhatsAppLifecycle } from './gowa.provider.js';
import type { MessagingProvider } from '../../messaging.types.js';

/**
 * WhatsApp provider wiring. When the box is configured with a GOWA base URL, the
 * GOWA adapter becomes the `whatsapp` channel's sending provider AND the pairing
 * lifecycle backend. With no config the messaging registry keeps its local
 * no-op provider, so the box runs fully offline (and tests are deterministic).
 *
 * The lifecycle instance is held here (not in the send-only messaging registry)
 * so the WhatsApp service can reach pairing/status/disconnect without leaking a
 * GOWA-specific type into the generic messaging pipeline.
 */
let lifecycle: (MessagingProvider & WhatsAppLifecycle) | null = null;

/** Wire GOWA from validated config. Idempotent; a no-op when unconfigured. */
export function configureWhatsAppFromConfig(): void {
  const wa = config().whatsapp;
  if (!wa.enabled || !wa.baseUrl) return;
  const provider = new GowaWhatsAppProvider({
    baseUrl: wa.baseUrl,
    ...(wa.basicAuth !== undefined ? { basicAuth: wa.basicAuth } : {}),
    timeoutMs: wa.timeoutMs,
  });
  registerProvider(provider);
  lifecycle = provider;
}

/** Test/DI hook: install a lifecycle-capable provider (e.g. a fake GOWA). */
export function setWhatsAppLifecycle(provider: MessagingProvider & WhatsAppLifecycle): void {
  registerProvider(provider);
  lifecycle = provider;
}

/** The active WhatsApp lifecycle backend, or null when WhatsApp is not configured. */
export function getWhatsAppLifecycle(): (MessagingProvider & WhatsAppLifecycle) | null {
  return lifecycle;
}

/** Restore the unconfigured state (test isolation). */
export function resetWhatsApp(): void {
  lifecycle = null;
}
