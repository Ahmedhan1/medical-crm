import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey, Permission } from '../../src/modules/governance/permissions.js';

/**
 * GAP-CLOSURE regression: an AI execution identity must NEVER be granted a human
 * RBAC permission as a scope. AI authority is a separate, AI-only scope
 * vocabulary; createIdentity now rejects any scope equal to a human Permission
 * value, making "AI never receives a human-only permission" a validated
 * invariant instead of relying on the two vocabularies happening to be disjoint.
 */
let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  app = buildServer();
  await app.ready();
});
afterAll(async () => { if (app) await app.close(); });

async function create(scopes: string[]) {
  return app.inject({
    method: 'POST', url: '/ai/identities', headers: bearer(admin.token),
    payload: { agentType: 'test_agent', name: `agent-${Math.random().toString(36).slice(2)}`, scopes },
  });
}

describe('AI identity scopes exclude human permissions', () => {
  it('rejects a human messaging permission granted as an AI scope', async () => {
    const res = await create([Permission.MESSAGING_SEND]);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a human AI-management permission granted as an AI scope', async () => {
    // ai:identity-manage / ai:policy-manage are human kernel-management perms —
    // never AI authority.
    for (const p of [Permission.AI_IDENTITY_MANAGE, Permission.AI_POLICY_MANAGE, Permission.AI_ACTION_CONFIRM]) {
      const res = await create([p]);
      expect(res.statusCode, `expected ${p} to be rejected`).toBe(400);
    }
  });

  it('still accepts a legitimate AI-only scope', async () => {
    const res = await create(['ai:demo-read', 'read:messaging-status']);
    expect(res.statusCode).toBe(201);
  });
});
