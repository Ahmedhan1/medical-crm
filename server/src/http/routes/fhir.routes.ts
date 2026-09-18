import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAppError, ValidationError } from '../../domain/errors.js';
import { principalOf, requireAuth } from '../plugins/auth.js';
import * as fhir from '../../modules/clinical/fhir/rest.service.js';

/**
 * FHIR R4 REST routes (Agent 3). Read-only, governed interoperability.
 * Responses use `application/fhir+json`; errors are FHIR OperationOutcome.
 * All authorization + tenant scope + audit live in the service.
 */
const FHIR_JSON = 'application/fhir+json';
const PatientRef = z.object({ patient: z.string().uuid() });

function issueCode(status: number): string {
  switch (status) {
    case 400: return 'invalid';
    case 401: return 'login';
    case 403: return 'forbidden';
    case 404: return 'not-found';
    case 429: return 'throttled';
    default: return 'exception';
  }
}

export async function fhirRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated error handler: FHIR endpoints answer with OperationOutcome
  // (including the 401 thrown by requireAuth), never the plain API envelope.
  app.setErrorHandler((err, req, reply) => {
    const status = isAppError(err) ? err.status : (err as { statusCode?: number }).statusCode ?? 500;
    const diagnostics = status >= 500 ? 'An unexpected error occurred' : (err as Error).message;
    if (status >= 500) req.log.error({ err }, 'fhir error');
    return reply.code(status).header('content-type', FHIR_JSON)
      .send(fhir.operationOutcome('error', issueCode(status), diagnostics));
  });

  app.addHook('preHandler', requireAuth);
  const send = (reply: import('fastify').FastifyReply, body: unknown): unknown =>
    reply.header('content-type', FHIR_JSON).send(body);

  // Capability statement (server metadata).
  app.get('/fhir/metadata', async (_req, reply) => send(reply, fhir.fhirCapabilityStatement()));

  // Patient read + search + $everything.
  app.get('/fhir/Patient/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return send(reply, await fhir.fhirReadPatient(principalOf(req), id));
  });
  app.get('/fhir/Patient/:id/$everything', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return send(reply, await fhir.fhirPatientEverything(principalOf(req), id));
  });
  app.get('/fhir/Patient', async (req, reply) => {
    const q = z.object({ identifier: z.string().trim().max(120).optional(), name: z.string().trim().max(120).optional() }).parse(req.query);
    return send(reply, await fhir.fhirSearchPatients(principalOf(req), q));
  });

  // Patient-compartment resource searches (?patient=<uuid>).
  const compartment: Record<string, fhir.PatientCompartmentResource> = {
    '/fhir/AllergyIntolerance': 'AllergyIntolerance',
    '/fhir/Observation': 'Observation',
    '/fhir/MedicationRequest': 'MedicationRequest',
    '/fhir/Procedure': 'Procedure',
    '/fhir/CarePlan': 'CarePlan',
    '/fhir/ServiceRequest': 'ServiceRequest',
  };
  for (const [path, resourceType] of Object.entries(compartment)) {
    app.get(path, async (req, reply) => {
      const parsed = PatientRef.safeParse(req.query);
      if (!parsed.success) throw new ValidationError('A patient reference is required (?patient=<uuid>)');
      return send(reply, await fhir.fhirSearchByPatient(principalOf(req), resourceType, parsed.data.patient));
    });
  }

  // Organization (the clinic).
  app.get('/fhir/Organization/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return send(reply, await fhir.fhirReadOrganization(principalOf(req), id));
  });
}
