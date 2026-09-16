import type { AIProvider } from '../ai.types.js';
import { LocalAIProvider } from './local.provider.js';

/**
 * AI provider seam. Callers ask for "the AI provider"; they never import a
 * concrete vendor. A deployment registers its model adapter at startup; the
 * default is the deterministic local provider so nothing is required to run.
 */
let current: AIProvider = new LocalAIProvider();

export function registerAIProvider(provider: AIProvider): void {
  current = provider;
}

export function getAIProvider(): AIProvider {
  return current;
}

export function resetAIProvider(): void {
  current = new LocalAIProvider();
}
