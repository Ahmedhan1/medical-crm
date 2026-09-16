import type { Channel, MessagingProvider } from '../messaging.types.js';
import { NoopMessagingProvider } from './noop.provider.js';

/**
 * Provider registry — the seam that keeps MEDCORE vendor-neutral.
 *
 * The rest of the app asks the registry for "the provider for channel X"; it
 * never imports a concrete vendor. A deployment wires its real providers in at
 * startup via `registerProvider`; the default is the local no-op so nothing is
 * required to run. `resetToDefault()` restores a clean state (used by tests).
 */
const byChannel = new Map<Channel, MessagingProvider>();

const defaultProvider = new NoopMessagingProvider();

function seedDefaults(): void {
  for (const channel of defaultProvider.channels) {
    byChannel.set(channel, defaultProvider);
  }
}
seedDefaults();

export function registerProvider(provider: MessagingProvider): void {
  for (const channel of provider.channels) {
    byChannel.set(channel, provider);
  }
}

export function getProviderForChannel(channel: Channel): MessagingProvider {
  const provider = byChannel.get(channel);
  if (!provider) {
    throw new Error(`No messaging provider registered for channel: ${channel}`);
  }
  return provider;
}

/** The built-in local provider (offline default / test double). */
export function defaultMessagingProvider(): NoopMessagingProvider {
  return defaultProvider;
}

/** Restore the registry to only the default provider (test isolation). */
export function resetToDefault(): void {
  byChannel.clear();
  defaultProvider.reset();
  seedDefaults();
}
