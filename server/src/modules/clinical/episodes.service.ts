import { z } from 'zod';
import { getPool, withTransaction, type PoolClient } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import { getPatientById } from '../identity/patients.repo.js';
import { findEncounter } from './encounter.repo.js';

/**
 * Treatment episodes (blueprint §15). An episode spans encounters: it starts at
 * one visit and its outcome is observed at later ones. Responses are recorded
 * as an append-only series rather than a single field, so "did this work?" keeps
 * its history instead of collapsing to the latest answer.
 */

export type EpisodeStatus = 'active' | 'completed' | 'discontinued';
export type ResponseValue = 'resolved' | 'improved' | 'unchanged' | 'worsened' | 'unknown';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const StartEpisodeSchema = z.object({
  label: z.string().trim().min(2).max(200),
  indication: z.string().trim().max(1_000).optional(),
  startedOn: isoDate,
  encounterId: z.string().uuid().optional(),
  diagnosisId: z.string().uuid().optional(),
});

export const RecordResponseSchema = z.object({
  response: z.enum(['resolved', 'improved', 'unchanged', 'worsened', 'unknown']),
  observedOn: isoDate,
  notes: z.string().trim().max(4_000).optional(),
  encounterId: z.string().uuid().optional(),
});

export const EndEpisodeSchema = z
  .object({
    status: z.enum(['completed', 'discontinued']),
    endedOn: isoDate,
    discontinuationReason: z
      .enum(['adverse_effect', 'ineffective', 'patient_choice', 'other'])
      .optional(),
  })
  .refine((v) => (v.status === 'discontinued') === (v.discontinuationReason !== undefined), {
    message: 'A discontinuation reason is required for a discontinued episode, and only then',
    path: ['discontinuationReason'],
  });

export const ListEpisodesSchema = z.object({
  status: z.enum(['active', 'completed', 'discontinued']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface TreatmentResponse {
  id: string;
  episodeId: string;
  encounterId: string | null;
  response: ResponseValue;
  observedOn: string;
  notes: string | null;
  recordedBy: string;
  createdAt: string;
}

export interface TreatmentEpisode {
  id: string;
  patientId: string;
  originEncounterId: string | null;
  diagnosisId: string | null;
  label: string;
  indication: string | null;
  status: EpisodeStatus;
  startedOn: string;
  endedOn: string | null;
  discontinuationReason: string | null;
  recordedBy: string;
  latestResponse: ResponseValue | null;
  responseCount: number;
}

interface EpisodeRow {
  id: string;
  patient_id: string;
  origin_encounter_id: string | null;
  diagnosis_id: string | null;
  label: string;
  indication: string | null;
  status: EpisodeStatus;
  started_on: string;
  ended_on: string | null;
  discontinuation_reason: string | null;
  recorded_by: string;
  latest_response: ResponseValue | null;
  response_count: string;
}

interface ResponseRow {
  id: string;
  episode_id: string;
  encounter_id: string | null;
  response: ResponseValue;
  observed_on: string;
  notes: string | null;
  recorded_by: string;
  created_at: string;
}

/** `date` columns arrive as Date objects; render them back as plain ISO dates. */
const asDate = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : v;

function mapEpisode(r: EpisodeRow): TreatmentEpisode {
  return {
    id: r.id,
    patientId: r.patient_id,
    originEncounterId: r.origin_encounter_id,
    diagnosisId: r.diagnosis_id,
    label: r.label,
    indication: r.indication,
    status: r.status,
    startedOn: asDate(r.started_on)!,
    endedOn: asDate(r.ended_on),
    discontinuationReason: r.discontinuation_reason,
    recordedBy: r.recorded_by,
    latestResponse: r.latest_response,
    responseCount: Number(r.response_count),
  };
}

function mapResponse(r: ResponseRow): TreatmentResponse {
  return {
    id: r.id,
    episodeId: r.episode_id,
    encounterId: r.encounter_id,
    response: r.response,
    observedOn: asDate(r.observed_on)!,
    notes: r.notes,
    recordedBy: r.recorded_by,
    createdAt: r.created_at,
  };
}

/**
 * Episode projection including the most recent response. The correlated
 * subqueries keep "latest response" derived from the append-only series rather
 * than denormalized onto the episode, where it could drift out of agreement
 * with the observations it summarizes.
 */
const EPISODE_SELECT = `
  SELECT te.id, te.patient_id, te.origin_encounter_id, te.diagnosis_id, te.label,
         te.indication, te.status, te.started_on, te.ended_on,
         te.discontinuation_reason, te.recorded_by,
         (SELECT tr.response FROM treatment_response tr
           WHERE tr.episode_id = te.id
           ORDER BY tr.observed_on DESC, tr.created_at DESC LIMIT 1) AS latest_response,
         (SELECT count(*) FROM treatment_response tr WHERE tr.episode_id = te.id)
           AS response_count
    FROM treatment_episode te`;

async function loadEpisode(
  runner: Pick<PoolClient, 'query'>,
  clinicId: string,
  episodeId: string,
): Promise<TreatmentEpisode | null> {
  const { rows } = await runner.query<EpisodeRow>(
    `${EPISODE_SELECT} WHERE te.clinic_id = $1 AND te.id = $2`,
    [clinicId, episodeId],
  );
  return rows[0] ? mapEpisode(rows[0]) : null;
}

/** Verify an encounter reference belongs to this patient before storing it. */
async function assertEncounterBelongsToPatient(
  clinicId: string,
  encounterId: string,
  patientId: string,
): Promise<void> {
  const encounter = await findEncounter(clinicId, encounterId);
  if (!encounter || encounter.patientId !== patientId) {
    throw new ValidationError('encounterId does not belong to this patient');
  }
}

export async function startEpisode(
  principal: Principal,
  patientId: string,
  raw: unknown,
): Promise<TreatmentEpisode> {
  requirePermission(principal, Permission.TREATMENT_EPISODE_WRITE);

  const parsed = StartEpisodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid treatment episode', parsed.error.flatten());
  }
  const input = parsed.data;

  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');
  // A merged record is a tombstone that points at the surviving patient; new
  // clinical work must go there. Every sibling clinical-creation path enforces
  // this — without it a treatment episode would be written under the merged id
  // and orphaned from the survivor's longitudinal reads (which are not
  // lineage-folded), never surfacing in the surviving patient's 360.
  if (patient.status === 'merged') {
    throw new ConflictError('This record was merged; start the episode on the surviving patient', {
      mergedIntoId: patient.mergedIntoId,
    });
  }

  if (input.encounterId) {
    await assertEncounterBelongsToPatient(principal.clinicId, input.encounterId, patient.id);
  }
  if (input.diagnosisId) {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM diagnosis WHERE id = $1 AND clinic_id = $2 AND patient_id = $3`,
      [input.diagnosisId, principal.clinicId, patient.id],
    );
    if (!rows[0]) throw new ValidationError('diagnosisId does not belong to this patient');
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO treatment_episode
         (clinic_id, patient_id, origin_encounter_id, diagnosis_id, label, indication,
          started_on, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        principal.clinicId,
        patient.id,
        input.encounterId ?? null,
        input.diagnosisId ?? null,
        input.label,
        input.indication ?? null,
        input.startedOn,
        principal.userId,
      ],
    );
    const episodeId = rows[0]!.id;

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.TREATMENT_EPISODE_STARTED,
      subjectType: 'treatment_episode',
      subjectId: episodeId,
      actorId: principal.userId,
      payload: { patientId: patient.id, encounterId: input.encounterId ?? null },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'treatment_episode.start',
      outcome: 'success',
      targetType: 'treatment_episode',
      targetId: episodeId,
      // The label names a treatment, so it stays out of the audit trail.
      metadata: { patientId: patient.id },
    });

    return (await loadEpisode(client, principal.clinicId, episodeId))!;
  });
}

export async function recordResponse(
  principal: Principal,
  episodeId: string,
  raw: unknown,
): Promise<{ episode: TreatmentEpisode; response: TreatmentResponse }> {
  requirePermission(principal, Permission.TREATMENT_EPISODE_WRITE);

  const parsed = RecordResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid treatment response', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    // Lock the episode so its status cannot change under a concurrent stop.
    const { rows: locked } = await client.query<{ id: string; patient_id: string; status: EpisodeStatus; started_on: string | Date }>(
      `SELECT id, patient_id, status, started_on FROM treatment_episode
        WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [episodeId, principal.clinicId],
    );
    const episodeRow = locked[0];
    if (!episodeRow) throw new NotFoundError('Treatment episode');

    if (input.observedOn < asDate(episodeRow.started_on)!) {
      throw new ValidationError('A response cannot be observed before the treatment started');
    }
    if (input.encounterId) {
      await assertEncounterBelongsToPatient(
        principal.clinicId,
        input.encounterId,
        episodeRow.patient_id,
      );
    }

    const { rows } = await client.query<ResponseRow>(
      `INSERT INTO treatment_response
         (clinic_id, episode_id, patient_id, encounter_id, response, observed_on, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, episode_id, encounter_id, response, observed_on, notes, recorded_by, created_at`,
      [
        principal.clinicId,
        episodeRow.id,
        episodeRow.patient_id,
        input.encounterId ?? null,
        input.response,
        input.observedOn,
        input.notes ?? null,
        principal.userId,
      ],
    );
    const response = mapResponse(rows[0]!);

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.TREATMENT_RESPONSE_RECORDED,
      subjectType: 'treatment_episode',
      subjectId: episodeRow.id,
      actorId: principal.userId,
      // The response value is a controlled vocabulary, not free text.
      payload: { patientId: episodeRow.patient_id, response: response.response },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'treatment_episode.response',
      outcome: 'success',
      targetType: 'treatment_episode',
      targetId: episodeRow.id,
      metadata: { patientId: episodeRow.patient_id, response: response.response },
    });

    return {
      episode: (await loadEpisode(client, principal.clinicId, episodeRow.id))!,
      response,
    };
  });
}

export async function endEpisode(
  principal: Principal,
  episodeId: string,
  raw: unknown,
): Promise<TreatmentEpisode> {
  requirePermission(principal, Permission.TREATMENT_EPISODE_WRITE);

  const parsed = EndEpisodeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid episode closure', parsed.error.flatten());
  }
  const input = parsed.data;

  return withTransaction(async (client) => {
    const { rows: locked } = await client.query<{
      id: string;
      patient_id: string;
      status: EpisodeStatus;
      started_on: string | Date;
    }>(
      `SELECT id, patient_id, status, started_on FROM treatment_episode
        WHERE id = $1 AND clinic_id = $2 FOR UPDATE`,
      [episodeId, principal.clinicId],
    );
    const episodeRow = locked[0];
    if (!episodeRow) throw new NotFoundError('Treatment episode');
    if (episodeRow.status !== 'active') {
      throw new ConflictError(`Episode is already ${episodeRow.status}`);
    }
    if (input.endedOn < asDate(episodeRow.started_on)!) {
      throw new ValidationError('An episode cannot end before it started');
    }

    await client.query(
      `UPDATE treatment_episode
          SET status = $3, ended_on = $4, discontinuation_reason = $5, updated_at = now()
        WHERE id = $1 AND clinic_id = $2`,
      [
        episodeRow.id,
        principal.clinicId,
        input.status,
        input.endedOn,
        input.discontinuationReason ?? null,
      ],
    );

    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.TREATMENT_EPISODE_ENDED,
      subjectType: 'treatment_episode',
      subjectId: episodeRow.id,
      actorId: principal.userId,
      payload: {
        patientId: episodeRow.patient_id,
        status: input.status,
        discontinuationReason: input.discontinuationReason ?? null,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'treatment_episode.end',
      outcome: 'success',
      targetType: 'treatment_episode',
      targetId: episodeRow.id,
      metadata: {
        patientId: episodeRow.patient_id,
        status: input.status,
        discontinuationReason: input.discontinuationReason ?? null,
      },
    });

    return (await loadEpisode(client, principal.clinicId, episodeRow.id))!;
  });
}

export async function listEpisodes(
  principal: Principal,
  patientId: string,
  rawQuery: unknown,
): Promise<TreatmentEpisode[]> {
  requirePermission(principal, Permission.TREATMENT_EPISODE_READ);

  const parsed = ListEpisodesSchema.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    throw new ValidationError('Invalid episode query', parsed.error.flatten());
  }
  const patient = await getPatientById(principal.clinicId, patientId);
  if (!patient) throw new NotFoundError('Patient');

  const { rows } = await getPool().query<EpisodeRow>(
    `${EPISODE_SELECT}
      WHERE te.clinic_id = $1 AND te.patient_id = $2
        AND ($3::text IS NULL OR te.status = $3)
      ORDER BY te.started_on DESC, te.created_at DESC
      LIMIT $4`,
    [principal.clinicId, patient.id, parsed.data.status ?? null, parsed.data.limit],
  );
  return rows.map(mapEpisode);
}

export async function getEpisode(
  principal: Principal,
  episodeId: string,
): Promise<{ episode: TreatmentEpisode; responses: TreatmentResponse[] }> {
  requirePermission(principal, Permission.TREATMENT_EPISODE_READ);

  const episode = await loadEpisode(getPool(), principal.clinicId, episodeId);
  if (!episode) throw new NotFoundError('Treatment episode');

  const { rows } = await getPool().query<ResponseRow>(
    `SELECT id, episode_id, encounter_id, response, observed_on, notes, recorded_by, created_at
       FROM treatment_response
      WHERE clinic_id = $1 AND episode_id = $2
      ORDER BY observed_on ASC, created_at ASC`,
    [principal.clinicId, episode.id],
  );
  return { episode, responses: rows.map(mapResponse) };
}
