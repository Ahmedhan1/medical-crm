import type {
  Channel,
  MessagingProvider,
  OutboundMessage,
  ProviderSendResult,
} from '../messaging.types.js';

/**
 * Local, dependency-free messaging provider — the default so MEDCORE is never
 * coupled to a vendor and so tests/offline clinics work without credentials.
 *
 * It "accepts" every message and returns a deterministic provider reference. It
 * keeps an in-memory outbox representing the vendor's inbox (NOT an application
 * log) so tests can assert what would have been transmitted. Because this is the
 * vendor side of the boundary, the outbox may hold the rendered body; the
 * application's own `message_log` never does.
 */
export interface CapturedMessage extends OutboundMessage {
  providerRef: string;
  at: number;
}

export class NoopMessagingProvider implements MessagingProvider {
  readonly id = 'local-noop';
  readonly channels: readonly Channel[] = ['whatsapp', 'sms', 'email'];

  /** In-memory "vendor inbox" for inspection in tests. Not a persistent log. */
  readonly outbox: CapturedMessage[] = [];

  /** When set, the next send() fails once — used to exercise retry paths. */
  private failNext = 0;

  failOnce(times = 1): void {
    this.failNext += times;
  }

  reset(): void {
    this.outbox.length = 0;
    this.failNext = 0;
  }

  async send(message: OutboundMessage): Promise<ProviderSendResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { status: 'failed', errorCode: 'provider_unavailable', errorMessage: 'simulated failure' };
    }
    const providerRef = `noop-${Date.now()}-${this.outbox.length}-${Math.random().toString(36).slice(2, 8)}`;
    this.outbox.push({ ...message, providerRef, at: Date.now() });
    return { status: 'sent', providerRef };
  }
}
