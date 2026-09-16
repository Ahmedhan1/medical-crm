import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { getPool } from '../../src/db/pool.js';
import { makeClinic, makeUser, resetDb, type TestUser } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;
let reception: TestUser;
let nurse: TestUser;
let doctor: TestUser;

const bearer = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  nurse = await makeUser(clinicId, 'nurse', RoleKey.NURSE);
  doctor = await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

async function registerPatient(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/patients',
    headers: bearer(reception),
    payload: { fullName: name, sex: 'female' },
  });
  return res.json().id;
}

async function checkIn(patientId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/encounters/check-in',
    headers: bearer(reception),
    payload: { patientId },
  });
  return res.json().id;
}

async function startEpisode(
  patientId: string,
  payload: Record<string, unknown>,
  user: TestUser = doctor,
) {
  return app.inject({
    method: 'POST',
    url: `/patients/${patientId}/treatment-episodes`,
    headers: bearer(user),
    payload,
  });
}

const BASE = { label: 'Amlodipine 5mg daily', startedOn: '2026-01-10' };

describe('C005 — treatment episodes', () => {
  it('starts an episode with no response recorded yet', async () => {
    const patientId = await registerPatient('Episode Patient');
    const res = await startEpisode(patientId, { ...BASE, indication: 'Hypertension' });

    expect(res.statusCode).toBe(201);
    const episode = res.json();
    expect(episode.status).toBe('active');
    expect(episode.endedOn).toBeNull();
    expect(episode.latestResponse).toBeNull();
    expect(episode.responseCount).toBe(0);
  });

  it('tracks a longitudinal response series and reports the latest', async () => {
    const patientId = await registerPatient('Longitudinal Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    for (const [observedOn, response] of [
      ['2026-01-24', 'unchanged'],
      ['2026-02-14', 'improved'],
      ['2026-03-14', 'resolved'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/treatment-episodes/${episodeId}/responses`,
        headers: bearer(doctor),
        payload: { observedOn, response },
      });
      expect(res.statusCode).toBe(201);
    }

    const res = await app.inject({
      method: 'GET',
      url: `/treatment-episodes/${episodeId}`,
      headers: bearer(doctor),
    });
    const { episode, responses } = res.json();
    expect(episode.responseCount).toBe(3);
    expect(episode.latestResponse).toBe('resolved');
    expect(responses.map((r: { response: string }) => r.response)).toEqual([
      'unchanged',
      'improved',
      'resolved',
    ]);
    expect(responses[0].observedOn).toBe('2026-01-24');
  });

  it('keeps recorded responses append-only', async () => {
    const patientId = await registerPatient('Append Only Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;
    await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/responses`,
      headers: bearer(doctor),
      payload: { observedOn: '2026-01-24', response: 'improved' },
    });
    await expect(
      getPool().query(`UPDATE treatment_response SET response = 'worsened'`),
    ).rejects.toThrow(/append-only/);
    await expect(getPool().query(`DELETE FROM treatment_response`)).rejects.toThrow(/append-only/);
  });

  it('completes an episode and refuses a second closure', async () => {
    const patientId = await registerPatient('Completed Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/end`,
      headers: bearer(doctor),
      payload: { status: 'completed', endedOn: '2026-03-14' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('completed');
    expect(res.json().endedOn).toBe('2026-03-14');

    const again = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/end`,
      headers: bearer(doctor),
      payload: { status: 'completed', endedOn: '2026-03-15' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('records a discontinuation with its reason', async () => {
    const patientId = await registerPatient('Discontinued Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/end`,
      headers: bearer(doctor),
      payload: {
        status: 'discontinued',
        endedOn: '2026-02-01',
        discontinuationReason: 'adverse_effect',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().discontinuationReason).toBe('adverse_effect');
  });

  it('requires a reason for a discontinuation and forbids one otherwise', async () => {
    const patientId = await registerPatient('Reason Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    const noReason = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/end`,
      headers: bearer(doctor),
      payload: { status: 'discontinued', endedOn: '2026-02-01' },
    });
    expect(noReason.statusCode).toBe(400);

    const strayReason = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/end`,
      headers: bearer(doctor),
      payload: {
        status: 'completed',
        endedOn: '2026-02-01',
        discontinuationReason: 'ineffective',
      },
    });
    expect(strayReason.statusCode).toBe(400);
  });

  it('rejects dates that precede the start of treatment', async () => {
    const patientId = await registerPatient('Chronology Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    const earlyResponse = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/responses`,
      headers: bearer(doctor),
      payload: { observedOn: '2026-01-01', response: 'improved' },
    });
    expect(earlyResponse.statusCode).toBe(400);

    const earlyEnd = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/end`,
      headers: bearer(doctor),
      payload: { status: 'completed', endedOn: '2026-01-01' },
    });
    expect(earlyEnd.statusCode).toBe(400);
  });

  it('refuses an encounter reference belonging to a different patient', async () => {
    const mine = await registerPatient('Owner Patient');
    const theirs = await registerPatient('Other Patient');
    const theirEncounter = await checkIn(theirs);

    const res = await startEpisode(mine, { ...BASE, encounterId: theirEncounter });
    expect(res.statusCode).toBe(400);
  });

  it('anchors an episode to the visit it was decided at', async () => {
    const patientId = await registerPatient('Anchored Patient');
    const encounterId = await checkIn(patientId);
    const res = await startEpisode(patientId, { ...BASE, encounterId });
    expect(res.statusCode).toBe(201);
    expect(res.json().originEncounterId).toBe(encounterId);
  });

  it('lists a patient episodes and filters by status', async () => {
    const patientId = await registerPatient('Listed Patient');
    const first = (await startEpisode(patientId, BASE)).json().id;
    await startEpisode(patientId, { label: 'Physiotherapy', startedOn: '2026-02-01' });
    await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${first}/end`,
      headers: bearer(doctor),
      payload: { status: 'completed', endedOn: '2026-01-31' },
    });

    const all = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/treatment-episodes`,
      headers: bearer(doctor),
    });
    expect(all.json().episodes).toHaveLength(2);

    const active = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/treatment-episodes?status=active`,
      headers: bearer(doctor),
    });
    expect(active.json().episodes).toHaveLength(1);
    expect(active.json().episodes[0].label).toBe('Physiotherapy');
  });

  it('gives a nurse read access but no write access', async () => {
    const patientId = await registerPatient('Nurse Scope Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    const read = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/treatment-episodes`,
      headers: bearer(nurse),
    });
    expect(read.statusCode).toBe(200);

    const write = await startEpisode(patientId, BASE, nurse);
    expect(write.statusCode).toBe(403);

    const response = await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/responses`,
      headers: bearer(nurse),
      payload: { observedOn: '2026-02-01', response: 'improved' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('denies treatment episodes to reception entirely', async () => {
    const patientId = await registerPatient('Reception Scope Patient');
    expect((await startEpisode(patientId, BASE, reception)).statusCode).toBe(403);
    const read = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/treatment-episodes`,
      headers: bearer(reception),
    });
    expect(read.statusCode).toBe(403);
  });

  it('does not expose an episode from another clinic', async () => {
    const patientId = await registerPatient('Isolated Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;

    const other = await makeClinic('Other Clinic');
    const otherDoctor = await makeUser(other.clinicId, 'doc2', RoleKey.DOCTOR);
    const res = await app.inject({
      method: 'GET',
      url: `/treatment-episodes/${episodeId}`,
      headers: bearer(otherDoctor),
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps the treatment label out of the audit trail', async () => {
    const patientId = await registerPatient('Audited Episode Patient');
    await startEpisode(patientId, { label: 'Methotrexate weekly', startedOn: '2026-01-10' });
    const { rows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE action = 'treatment_episode.start'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.metadata)).not.toMatch(/methotrexate/i);
  });

  it('surfaces episodes and responses on the patient timeline', async () => {
    const patientId = await registerPatient('Timeline Episode Patient');
    const episodeId = (await startEpisode(patientId, BASE)).json().id;
    await app.inject({
      method: 'POST',
      url: `/treatment-episodes/${episodeId}/responses`,
      headers: bearer(doctor),
      payload: { observedOn: '2026-02-14', response: 'improved', notes: 'BP now 128/82' },
    });

    const timeline = await app.inject({
      method: 'GET',
      url: `/patients/${patientId}/timeline`,
      headers: bearer(doctor),
    });
    const entries = timeline.json().entries as Array<{
      kind: string;
      summary: string | null;
      detail: Record<string, unknown>;
    }>;
    const episode = entries.find((e) => e.kind === 'treatment_episode');
    const response = entries.find((e) => e.kind === 'treatment_response');
    expect(episode?.summary).toBe('Amlodipine 5mg daily');
    expect(response?.detail.response).toBe('improved');
    expect(response?.detail.episodeId).toBe(episodeId);
  });
});
