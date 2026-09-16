import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../../config/env.js';

/**
 * Human confirmation for AI actions (E4).
 *
 * A confirmation is a stateless token bound to the EXACT action (clinic +
 * identity + tool + data class) and a short expiry, signed with the server
 * pepper. Only a human, through an authorized endpoint, can mint one; the AI
 * (which has no access to the pepper) cannot forge or self-confirm. Binding the
 * token to the action means a confirmation for one action cannot authorize a
 * different one, and the TTL bounds replay.
 *
 * This is deliberately minimal — a deterministic authorization primitive, not a
 * UI. No PHI is included in the signed material.
 */
export interface ActionDescriptor {
  clinicId: string;
  identityId: string;
  toolId: string;
  dataClass: string;
}

const LABEL = 'ai-action-confirm:v1';
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

function canonical(d: ActionDescriptor): string {
  return `${d.clinicId}|${d.identityId}|${d.toolId}|${d.dataClass}`;
}

function sign(d: ActionDescriptor, expEpoch: number): string {
  return createHmac('sha256', config().authPepper)
    .update(`${LABEL}|${canonical(d)}|${expEpoch}`)
    .digest('base64url');
}

export function issueConfirmationToken(d: ActionDescriptor, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${exp}.${sign(d, exp)}`;
}

export function verifyConfirmationToken(d: ActionDescriptor, token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false; // expired/invalid
  const expected = sign(d, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
