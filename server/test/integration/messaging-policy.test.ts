import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { defaultMessagingProvider, resetToDefault } from '../../src/modules/messaging/providers/registry.js';
import { findEnabledEventRules } from '../../src/modules/automation/automation.repo.js';

let app: FastifyInstance;
let clinicId: string;
let admin: { token: string };
let reception: { token: string };

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function newPatient(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/patients', headers: bearer(reception.token),
    payload: { fullName: name, sex: 'female', phone: '+201110002222' },
  });
  return res.json().id;
}
async function optIn(patientId: string): Promise<void> {
  await app.inject({ method: 'POST', url: '/consent', headers: bearer(reception.token), payload: { patientId, channel: 'whatsapp', status: 'opted_in' } });
}
async function send(patientId: string) {
  return app.inject({
    method: 'POST', url: '/messages', headers: bearer(reception.token),
    payload: { channel: 'whatsapp', patientId, templateKey: 'appointment_reminder' },
  });
}
async function setPolicy(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/messaging-policy', headers: bearer(admin.token), payload: body });
}

beforeEach(async () => {
  await resetDb();
  resetToDefault();
  ({ clinicId } = await makeClinic());
  admin = await makeUser(clinicId, 'admin', RoleKey.ADMIN);
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  app = buildServer();
  await app.ready();
  await app.inject({
    method: 'POST', url: '/message-templates', headers: bearer(admin.token),
    payload: { key: 'appointment_reminder', channel: 'whatsapp', body: 'Hi {{firstName}}.' },
  });
});
afterEach(() => resetToDefault());
afterAll(async () => { if (app) await app.close(); });

describe('communication quality: frequency caps', () => {
  it('with no policy configured, behaviour is permissive (existing behaviour unchanged)', async () => {
    const p = await newPatient('Permissive'); await optIn(p);
    expect((await send(p)).json().status).toBe('sent');
    expect((await send(p)).json().status).toBe('sent');
    expect(defaultMessagingProvider().outbox).toHaveLength(2);
  });

  it('a daily cap suppresses further sends to the same patient/channel', async () => {
    await setPolicy({ channel: 'whatsapp', dailyCap: 1 });
    const p = await newPatient('Capped'); await optIn(p);
    expect((await send(p)).json().status).toBe('sent');
    const second = await send(p);
    expect(second.json().status).toBe('suppressed');
    expect(second.json().suppressedReason).toBe('daily_cap');
    expect(defaultMessagingProvider().outbox).toHaveLength(1);
  });

  it('a minimum gap suppresses a too-soon second send', async () => {
    await setPolicy({ channel: 'whatsapp', minGapMinutes: 60 });
    const p = await newPatient('Gapped'); await optIn(p);
    expect((await send(p)).json().status).toBe('sent');
    const second = await send(p);
    expect(second.json().status).toBe('suppressed');
    expect(second.json().suppressedReason).toBe('min_gap');
  });

  it('consent is still enforced independently of policy', async () => {
    await setPolicy({ channel: 'whatsapp', dailyCap: 100 });
    const p = await newPatient('NoConsent'); // not opted in
    const res = await send(p);
    expect(res.json().status).toBe('suppressed');
    expect(res.json().suppressedReason).toBe('no_consent');
  });
});

describe('communication quality: quiet hours', () => {
  it('suppresses an immediate send during the clinic quiet window', async () => {
    const nowHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false }).format(new Date())) % 24;
    await setPolicy({ channel: 'whatsapp', quietHoursEnabled: true, quietStartHour: nowHour, quietEndHour: (nowHour + 1) % 24 });
    const p = await newPatient('Quiet'); await optIn(p);
    const res = await send(p);
    expect(res.json().status).toBe('suppressed');
    expect(res.json().suppressedReason).toBe('quiet_hours');
    expect(defaultMessagingProvider().outbox).toHaveLength(0);
  });
});

describe('engine hardening: rule priority ordering', () => {
  it('returns matching enabled rules ordered by priority (lower first)', async () => {
    await app.inject({ method: 'POST', url: '/automations', headers: bearer(admin.token), payload: { name: 'low', eventType: 'PATIENT_CHECKED_IN', priority: 200, actions: [{ type: 'noop' }] } });
    await app.inject({ method: 'POST', url: '/automations', headers: bearer(admin.token), payload: { name: 'high', eventType: 'PATIENT_CHECKED_IN', priority: 10, actions: [{ type: 'noop' }] } });
    const rules = await findEnabledEventRules(clinicId, 'PATIENT_CHECKED_IN');
    expect(rules.map((r) => r.name)).toEqual(['high', 'low']);
    expect(rules[0]!.priority).toBe(10);
  });

  it('bumps rule version when the definition changes, not on a rename', async () => {
    const created = await app.inject({ method: 'POST', url: '/automations', headers: bearer(admin.token), payload: { name: 'v', eventType: 'PATIENT_CHECKED_IN', actions: [{ type: 'noop' }] } });
    const id = created.json().id;
    expect(created.json().version).toBe(1);
    const renamed = await app.inject({ method: 'PATCH', url: `/automations/${id}`, headers: bearer(admin.token), payload: { name: 'v2' } });
    expect(renamed.json().version).toBe(1); // rename does not bump
    const redefined = await app.inject({ method: 'PATCH', url: `/automations/${id}`, headers: bearer(admin.token), payload: { actions: [{ type: 'noop' }, { type: 'noop' }] } });
    expect(redefined.json().version).toBe(2); // definition change bumps
  });
});
