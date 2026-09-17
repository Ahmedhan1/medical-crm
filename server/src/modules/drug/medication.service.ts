import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { emitEvent, EventType } from '../../domain/events.js';
import { audit, auditTx } from '../governance/audit.js';
import { Permission } from '../governance/permissions.js';
import { requirePermission, type Principal } from '../governance/rbac.js';
import {
  assertTransition,
  verificationExpiryFrom,
  VerificationState,
} from '../hcp/verification.js';
import { JurisdictionSchema, ProvenanceSchema, VerificationStatus } from '../pharma/provenance.js';
import * as repo from './medication.repo.js';
import { getProvider, listProviders } from './providers.js';

/**
 * Drug / medication master service.
 *
 * Data-source discipline (§7 of the workstream brief):
 *  - Every write names a registered provider, and the provider's declared
 *    `licenseBasis` is stored on the row — an unregistered provider is rejected,
 *    so proprietary data cannot be ingested by accident.
 *  - Regulatory facts (authority, identifier, status, approval date) belong to a
 *    product *in a jurisdiction*, never to the molecule.
 *  - Nothing is born verified; `medication:write` creates, and verification is a
 *    separate, evidenced act.
 *
 * This service asserts no medical facts of its own: it stores what a source
 * says, with the source attached.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const CreateMedicationSchema = z.object({
  genericName: z.string().trim().min(2).max(200),
  atcCode: z
    .string()
    .trim()
    .regex(/^[A-Z]\d{2}[A-Z]{2}\d{2}$/, 'atcCode must be a 7-character WHO ATC code')
    .optional(),
  conceptType: z.enum(['molecule', 'combination']).default('molecule'),
  therapeuticArea: z.string().trim().max(160).optional(),
  providerKey: z.string().trim().min(2).max(60).default('manual_entry'),
  provenance: ProvenanceSchema,
  ingredients: z
    .array(
      z.object({
        ingredientName: z.string().trim().min(2).max(200),
        strengthValue: z.number().positive().optional(),
        strengthUnit: z.string().trim().max(20).optional(),
        isActiveIngredient: z.boolean().default(true),
      }),
    )
    .max(20)
    .default([]),
});

export const CreateProductSchema = z.object({
  brandName: z.string().trim().min(1).max(200),
  manufacturerName: z.string().trim().min(2).max(200).optional(),
  dosageForm: z.string().trim().min(2).max(80),
  route: z.string().trim().min(2).max(80),
  strengthText: z.string().trim().max(80).optional(),
  packageDescription: z.string().trim().max(200).optional(),
  packageSize: z.number().int().positive().max(100_000).optional(),
  packageUnit: z.string().trim().max(40).optional(),
  jurisdiction: JurisdictionSchema,
  regulatoryAuthority: z.string().trim().max(80).optional(),
  regulatoryIdentifier: z.string().trim().max(80).optional(),
  regulatoryStatus: z
    .enum(['approved', 'pending', 'withdrawn', 'suspended', 'unknown'])
    .default('unknown'),
  approvalDate: DATE.optional(),
  withdrawalDate: DATE.optional(),
  providerKey: z.string().trim().min(2).max(60).default('manual_entry'),
  source: z.string().trim().min(2).max(120),
  sourceVersion: z.string().trim().max(120).optional(),
  sourceRef: z.string().trim().max(500).optional(),
});

/**
 * Deliberately the same field names as the HCP and HCO decision schemas. One
 * vocabulary for all three masters means a steward does not have to remember
 * which entity spells the decision differently.
 *
 * `expired` is absent on purpose: expiry is derived from the clock and written
 * by the sweep, never asserted by a caller.
 */
export const VerifyMedicationSchema = z.object({
  verificationStatus: z.enum([
    'pending_review',
    'verified',
    'rejected',
    'suspended',
    'disputed',
    'retired',
  ]),
  evidenceSource: z.string().trim().min(2).max(200),
  /** Required for `rejected` and `suspended`; an unexplained refusal is not reviewable. */
  note: z.string().trim().min(2).max(1000).optional(),
  /** Shelf life of this attestation. Omit for the default of one year. */
  validForDays: z.number().int().min(1).max(3650).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`Invalid ${what}`, parsed.error.flatten());
  return parsed.data;
}

/** Resolve a provider key to its licence basis, refusing unregistered sources. */
function licenseBasisFor(providerKey: string, jurisdiction: string): string {
  const provider = getProvider(providerKey);
  if (!provider) {
    throw new ValidationError(
      `Unknown medication data provider "${providerKey}". Data may only be ingested from a ` +
        'registered provider with a declared licence basis.',
      { registeredProviders: listProviders().map((p) => p.key) },
    );
  }
  if (provider.jurisdictions.length > 0) {
    const country = jurisdiction.slice(0, 2);
    if (!provider.jurisdictions.includes(country)) {
      throw new ValidationError(
        `Provider "${providerKey}" does not cover jurisdiction "${jurisdiction}"`,
        { covers: provider.jurisdictions },
      );
    }
  }
  return provider.licenseBasis;
}

export function medicationProviders(principal: Principal) {
  requirePermission(principal, Permission.MEDICATION_READ);
  return listProviders();
}

export async function createMedication(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.MEDICATION_WRITE);
  const input = parse(CreateMedicationSchema, raw, 'medication');
  const licenseBasis = licenseBasisFor(input.providerKey, input.provenance.jurisdiction);

  return withTransaction(async (client) => {
    let medication: repo.Medication;
    try {
      medication = await repo.insertMedication(client, {
        clinicId: principal.clinicId,
        genericName: input.genericName,
        atcCode: input.atcCode ?? null,
        conceptType: input.conceptType,
        therapeuticArea: input.therapeuticArea ?? null,
        source: input.provenance.source,
        sourceVersion: input.provenance.sourceVersion ?? null,
        sourceRef: input.provenance.sourceRef ?? null,
        licenseBasis,
        jurisdiction: input.provenance.jurisdiction,
        confidence: input.provenance.confidence ?? null,
        createdBy: principal.userId,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(
          'This generic already exists for this jurisdiction; add a product to it instead',
        );
      }
      throw err;
    }

    const ingredients = [];
    for (const ingredient of input.ingredients) {
      ingredients.push(
        await repo.insertIngredient(client, {
          clinicId: principal.clinicId,
          medicationId: medication.id,
          ingredientName: ingredient.ingredientName,
          strengthValue: ingredient.strengthValue ?? null,
          strengthUnit: ingredient.strengthUnit ?? null,
          isActiveIngredient: ingredient.isActiveIngredient,
          source: input.provenance.source,
          sourceVersion: input.provenance.sourceVersion ?? null,
        }),
      );
    }

    await repo.insertMedicationRevision(client, {
      clinicId: principal.clinicId,
      medicationId: medication.id,
      recordVersion: medication.recordVersion,
      changeType: 'create',
      changedFields: [],
      snapshot: { ...medication, ingredients },
      source: medication.source,
      sourceVersion: medication.sourceVersion,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.MEDICATION_CREATED,
      subjectType: 'medication',
      subjectId: medication.id,
      actorId: principal.userId,
      payload: {
        jurisdiction: medication.jurisdiction,
        source: medication.source,
        licenseBasis,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'medication.create',
      targetType: 'medication',
      targetId: medication.id,
      metadata: { source: medication.source, licenseBasis, providerKey: input.providerKey },
    });
    return { ...medication, ingredients };
  });
}

export async function addProduct(principal: Principal, medicationId: string, raw: unknown) {
  requirePermission(principal, Permission.MEDICATION_WRITE);
  const input = parse(CreateProductSchema, raw, 'medication product');
  const licenseBasis = licenseBasisFor(input.providerKey, input.jurisdiction);
  if (input.regulatoryStatus === 'approved' && !input.regulatoryIdentifier) {
    throw new ValidationError(
      'An approved product must carry the regulatory identifier it was approved under',
    );
  }

  return withTransaction(async (client) => {
    const medication = await repo.getMedicationById(principal.clinicId, medicationId, client);
    if (!medication) throw new NotFoundError('Medication');

    let manufacturerId: string | null = null;
    if (input.manufacturerName) {
      const existing = await repo.findManufacturerByName(
        client,
        principal.clinicId,
        input.manufacturerName,
      );
      manufacturerId =
        existing?.id ??
        (
          await repo.insertManufacturer(client, {
            clinicId: principal.clinicId,
            name: input.manufacturerName,
            country: input.jurisdiction.slice(0, 2),
            source: input.source,
            sourceVersion: input.sourceVersion ?? null,
            jurisdiction: input.jurisdiction,
            createdBy: principal.userId,
          })
        ).id;
    }

    try {
      const product = await repo.insertProduct(client, {
        clinicId: principal.clinicId,
        medicationId,
        brandName: input.brandName,
        manufacturerId,
        dosageForm: input.dosageForm,
        route: input.route,
        strengthText: input.strengthText ?? null,
        packageDescription: input.packageDescription ?? null,
        packageSize: input.packageSize ?? null,
        packageUnit: input.packageUnit ?? null,
        jurisdiction: input.jurisdiction,
        regulatoryAuthority: input.regulatoryAuthority ?? null,
        regulatoryIdentifier: input.regulatoryIdentifier ?? null,
        regulatoryStatus: input.regulatoryStatus,
        approvalDate: input.approvalDate ?? null,
        withdrawalDate: input.withdrawalDate ?? null,
        source: input.source,
        sourceVersion: input.sourceVersion ?? null,
        sourceRef: input.sourceRef ?? null,
        licenseBasis,
        createdBy: principal.userId,
      });

      await emitEvent(client, {
        clinicId: principal.clinicId,
        type: EventType.MEDICATION_PRODUCT_CREATED,
        subjectType: 'medication',
        subjectId: medicationId,
        actorId: principal.userId,
        payload: {
          productId: product.id,
          jurisdiction: product.jurisdiction,
          regulatoryStatus: product.regulatoryStatus,
        },
      });
      await auditTx(client, {
        clinicId: principal.clinicId,
        actorId: principal.userId,
        action: 'medication.product.create',
        targetType: 'medication',
        targetId: medicationId,
        metadata: { productId: product.id, licenseBasis },
      });
      return product;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(
          'A product with this regulatory identifier already exists in this jurisdiction',
        );
      }
      throw err;
    }
  });
}

/**
 * Decide the verification state of a medication record.
 *
 * Gated by `medication:verify`, NOT by `medication:write`: before this, anyone
 * who could record a medication could also attest that it was true, which is
 * the separation the HCP and HCO masters have had since 0306.
 *
 * The transition itself goes through the SAME rule set as the other two masters
 * (`hcp/verification.ts`), so `unverified → verified` in one step — previously
 * legal here and nowhere else — is now refused.
 */
export async function verifyMedication(principal: Principal, id: string, raw: unknown) {
  requirePermission(principal, Permission.MEDICATION_VERIFY);
  const input = parse(VerifyMedicationSchema, raw, 'verification');

  return withTransaction(async (client) => {
    const before = await repo.getMedicationForUpdate(client, principal.clinicId, id);
    if (!before) throw new NotFoundError('Medication');
    // Decide against the EFFECTIVE status, so a lapsed attestation cannot be
    // re-verified without passing back through review.
    assertTransition(
      before.verificationStatus as VerificationState,
      input.verificationStatus as VerificationState,
      input.note ?? null,
    );
    const verifying = input.verificationStatus === VerificationStatus.VERIFIED;
    const after = await repo.updateMedicationVerification(client, principal.clinicId, id, {
      verificationStatus: input.verificationStatus,
      lastVerifiedAt: verifying ? new Date().toISOString() : null,
      confidence: input.confidence ?? null,
      verifiedBy: verifying ? principal.userId : null,
      expiresAt: verifying ? verificationExpiryFrom(input.validForDays) : null,
      note: input.note ?? null,
    });
    await repo.insertMedicationRevision(client, {
      clinicId: principal.clinicId,
      medicationId: id,
      recordVersion: after.recordVersion,
      changeType: 'verify',
      changedFields: ['verificationStatus'],
      snapshot: after,
      source: input.evidenceSource,
      sourceVersion: null,
      changedBy: principal.userId,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.MEDICATION_UPDATED,
      subjectType: 'medication',
      subjectId: id,
      actorId: principal.userId,
      payload: { verificationStatus: after.verificationStatus },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'medication.verify',
      targetType: 'medication',
      targetId: id,
      metadata: {
        from: before.verificationStatus,
        to: after.verificationStatus,
        evidenceSource: input.evidenceSource,
      },
    });
    return after;
  });
}

/**
 * Persist lapsed medication attestations.
 *
 * Reads already DERIVE expiry, so this only makes the stored value agree with
 * what callers are already shown — the same bookkeeping role the HCP and HCO
 * sweeps play, and for the same reason: correctness must not depend on a
 * background job having run.
 */
export async function sweepMedicationVerifications(
  principal: Principal,
  limit = 500,
): Promise<{ expired: number }> {
  requirePermission(principal, Permission.MEDICATION_VERIFY);
  const bounded = Math.min(Math.max(limit, 1), 1000);

  const expired = await withTransaction(async (client) => {
    const due = await repo.expiredMedicationVerifications(client, principal.clinicId, bounded);
    for (const id of due) {
      const after = await repo.updateMedicationVerification(client, principal.clinicId, id, {
        verificationStatus: VerificationStatus.EXPIRED,
        lastVerifiedAt: null,
        confidence: null,
        verifiedBy: null,
        expiresAt: null,
        note: null,
      });
      await repo.insertMedicationRevision(client, {
        clinicId: principal.clinicId,
        medicationId: id,
        recordVersion: after.recordVersion,
        changeType: 'verification_expired',
        changedFields: ['verificationStatus'],
        snapshot: after,
        source: after.source,
        sourceVersion: null,
        // No actor: the system observed a lapse; nobody decided it.
        changedBy: null,
      });
    }
    return due.length;
  });

  await audit({
    clinicId: principal.clinicId,
    actorId: principal.userId,
    action: 'medication.verification.sweep',
    targetType: 'medication',
    targetId: null,
    metadata: { expired },
  });
  return { expired };
}

export async function searchMedications(
  principal: Principal,
  params: { q?: string; jurisdiction?: string; atcCode?: string; limit?: number; offset?: number },
) {
  requirePermission(principal, Permission.MEDICATION_READ);
  return repo.searchMedications(principal.clinicId, {
    q: params.q?.trim() || null,
    jurisdiction: params.jurisdiction ?? null,
    atcCode: params.atcCode ?? null,
    limit: Math.min(Math.max(params.limit ?? 25, 1), 100),
    offset: Math.max(params.offset ?? 0, 0),
  });
}

/** Full medication concept: ingredients plus the products registered for it. */
export async function getMedication(
  principal: Principal,
  id: string,
  jurisdiction?: string,
) {
  requirePermission(principal, Permission.MEDICATION_READ);
  const medication = await repo.getMedicationById(principal.clinicId, id);
  if (!medication) throw new NotFoundError('Medication');
  const [ingredients, products] = await Promise.all([
    repo.listIngredients(principal.clinicId, id),
    repo.listProducts(principal.clinicId, id, jurisdiction ?? null),
  ]);
  return { ...medication, ingredients, products };
}

/**
 * Bulk import from a registered provider. The run is recorded before any row is
 * written and closed with counts, so an import is always traceable — including
 * a failed one.
 */
export const ImportSchema = z.object({
  providerKey: z.string().trim().min(2).max(60),
  providerVersion: z.string().trim().max(120).optional(),
  sourceRef: z.string().trim().max(500).optional(),
  jurisdiction: JurisdictionSchema,
  records: z
    .array(
      z.object({
        genericName: z.string().trim().min(2).max(200),
        atcCode: z.string().trim().max(10).optional(),
        therapeuticArea: z.string().trim().max(160).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export async function importMedications(principal: Principal, raw: unknown) {
  requirePermission(principal, Permission.MEDICATION_WRITE);
  const input = parse(ImportSchema, raw, 'import');
  const licenseBasis = licenseBasisFor(input.providerKey, input.jurisdiction);

  return withTransaction(async (client) => {
    const run = await repo.startImportRun(client, {
      clinicId: principal.clinicId,
      providerKey: input.providerKey,
      providerVersion: input.providerVersion ?? null,
      sourceRef: input.sourceRef ?? null,
      licenseBasis,
      jurisdiction: input.jurisdiction,
      startedBy: principal.userId,
    });

    let created = 0;
    let skipped = 0;
    for (const record of input.records) {
      // A savepoint keeps one duplicate from aborting the whole import.
      await client.query('SAVEPOINT import_record');
      try {
        const medication = await repo.insertMedication(client, {
          clinicId: principal.clinicId,
          genericName: record.genericName,
          atcCode: record.atcCode ?? null,
          conceptType: 'molecule',
          therapeuticArea: record.therapeuticArea ?? null,
          source: input.providerKey,
          sourceVersion: input.providerVersion ?? null,
          sourceRef: input.sourceRef ?? null,
          licenseBasis,
          jurisdiction: input.jurisdiction,
          confidence: null,
          createdBy: principal.userId,
        });
        await repo.insertMedicationRevision(client, {
          clinicId: principal.clinicId,
          medicationId: medication.id,
          recordVersion: medication.recordVersion,
          changeType: 'import',
          changedFields: [],
          snapshot: medication,
          source: input.providerKey,
          sourceVersion: input.providerVersion ?? null,
          changedBy: principal.userId,
        });
        await client.query('RELEASE SAVEPOINT import_record');
        created += 1;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT import_record');
        if ((err as { code?: string }).code === '23505') {
          skipped += 1;
          continue;
        }
        await repo.finishImportRun(client, run.id, {
          status: 'failed',
          recordsCreated: created,
          recordsUpdated: 0,
          recordsSkipped: skipped,
          errorMessage: (err as Error).message,
        });
        throw err;
      }
    }

    await repo.finishImportRun(client, run.id, {
      status: 'completed',
      recordsCreated: created,
      recordsUpdated: 0,
      recordsSkipped: skipped,
      errorMessage: null,
    });
    await emitEvent(client, {
      clinicId: principal.clinicId,
      type: EventType.MEDICATION_IMPORT_COMPLETED,
      subjectType: 'medication_import_run',
      subjectId: run.id,
      actorId: principal.userId,
      payload: {
        providerKey: input.providerKey,
        licenseBasis,
        recordsCreated: created,
        recordsSkipped: skipped,
      },
    });
    await auditTx(client, {
      clinicId: principal.clinicId,
      actorId: principal.userId,
      action: 'medication.import',
      targetType: 'medication_import_run',
      targetId: run.id,
      metadata: { providerKey: input.providerKey, created, skipped, licenseBasis },
    });
    return { runId: run.id, recordsCreated: created, recordsSkipped: skipped, licenseBasis };
  });
}

export async function listImportRuns(principal: Principal, limit = 20) {
  requirePermission(principal, Permission.MEDICATION_READ);
  return repo.listImportRuns(principal.clinicId, Math.min(Math.max(limit, 1), 100));
}
