import type { AIProvider } from '../ai.types.js';
import { LocalAIProvider } from './local.provider.js';

/**
 * AI provider seam. Callers ask the GATEWAY for a provider; they never import a
 * concrete vendor. The registry holds at most one LOCAL provider (always present
 * — the deterministic default) and OPTIONALLY one CLOUD provider.
 *
 * A cloud provider being registered does NOT mean it will be used: the AI
 * gateway only routes to it when the tenant AI policy permits off-box processing
 * for the request's data class. This keeps "a cloud model exists" and "this data
 * may go to the cloud" as two independent decisions.
 */
let localProvider: AIProvider = new LocalAIProvider();
let cloudProvider: AIProvider | null = null;

/**
 * Register a provider. A provider with `tier: 'cloud'` becomes the cloud slot;
 * anything else replaces the local slot. Backwards compatible: an existing call
 * `registerAIProvider(p)` with no tier still registers a local provider.
 */
export function registerAIProvider(provider: AIProvider): void {
  if (provider.tier === 'cloud') {
    cloudProvider = provider;
  } else {
    localProvider = provider;
  }
}

export function registerCloudAIProvider(provider: AIProvider): void {
  cloudProvider = { ...provider, tier: 'cloud' } as AIProvider;
}

/** The local/default provider (safe for any data class). */
export function getAIProvider(): AIProvider {
  return localProvider;
}

export function getLocalAIProvider(): AIProvider {
  return localProvider;
}

/** The cloud provider, or null when none is registered. */
export function getCloudAIProvider(): AIProvider | null {
  return cloudProvider;
}

export function resetAIProvider(): void {
  localProvider = new LocalAIProvider();
  cloudProvider = null;
}
