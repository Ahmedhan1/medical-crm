import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clockWitnessPath } from './paths.js';

/**
 * Monotonic clock witness — a soft defense against clock rollback used to escape
 * an expired license. We persist the latest timestamp we have ever observed; if
 * the system clock later reads meaningfully EARLIER than that witness, the wall
 * clock has moved backwards and expiry decisions made from it are suspect.
 *
 * This never blocks clinical work on its own (a real clock correction can move
 * time back). It is a SIGNAL the license service uses to prefer online
 * re-verification and to refuse to *extend* grace off a rolled-back clock.
 */
const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes of legitimate skew/correction

interface Witness {
  maxSeenIso: string;
}

function read(): Witness | null {
  try {
    if (!existsSync(clockWitnessPath())) return null;
    return JSON.parse(readFileSync(clockWitnessPath(), 'utf8')) as Witness;
  } catch {
    return null;
  }
}

/**
 * Record `now` and report whether it went backwards past tolerance relative to
 * the highest timestamp ever seen. Advances the witness when now is newer.
 */
export function observeClock(now: Date): { rolledBack: boolean; maxSeen: Date } {
  const w = read();
  const prevMax = w ? Date.parse(w.maxSeenIso) : Number.NaN;
  const nowMs = now.getTime();

  if (Number.isNaN(prevMax)) {
    persist(now);
    return { rolledBack: false, maxSeen: now };
  }
  if (nowMs > prevMax) {
    persist(now);
    return { rolledBack: false, maxSeen: now };
  }
  const rolledBack = nowMs < prevMax - TOLERANCE_MS;
  return { rolledBack, maxSeen: new Date(prevMax) };
}

function persist(now: Date): void {
  try {
    mkdirSync(dirname(clockWitnessPath()), { recursive: true });
    writeFileSync(clockWitnessPath(), JSON.stringify({ maxSeenIso: now.toISOString() }), {
      mode: 0o600,
    });
  } catch {
    /* best effort — absence of the witness just disables rollback detection */
  }
}
