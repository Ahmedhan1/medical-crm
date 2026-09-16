import type { Channel } from './messaging.types.js';

/**
 * Recipient masking for the operational log. A destination address is contact
 * PHI, so `message_log` stores only a masked form: enough to recognise a record
 * operationally, never enough to re-derive the address.
 */
export function maskRecipient(to: string, channel: Channel): string {
  if (channel === 'email') return maskEmail(to);
  return maskPhone(to);
}

function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length);
  const keepPrefix = trimmed.startsWith('+') ? 3 : 0; // country hint only
  const last4 = trimmed.slice(-4);
  const prefix = trimmed.slice(0, keepPrefix);
  const maskedLen = trimmed.length - keepPrefix - 4;
  return `${prefix}${'*'.repeat(Math.max(0, maskedLen))}${last4}`;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '*'.repeat(email.length);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}${domain}`;
}
