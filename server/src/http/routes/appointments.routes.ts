import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import {
  bookAppointment,
  createAppointmentType,
  createResource,
  getAppointment,
  getAppointmentTypes,
  getPatientAppointments,
  getResources,
  getSchedule,
  rescheduleAppointment,
  setAppointmentStatus,
} from '../../modules/clinical/scheduling.service.js';
import { principalOf, requireAuth } from '../plugins/auth.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Appointments, the schedule, and its configuration (Agent 2 / Phase 2). */
export async function appointmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const idOf = (req: { params: unknown }): string => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) throw new ValidationError('Invalid id');
    return parsed.data.id;
  };

  app.post('/appointments', async (req, reply) => {
    const appointment = await bookAppointment(principalOf(req), req.body);
    return reply.code(201).send(appointment);
  });

  /** The day view. Filterable by window, practitioner, patient and status. */
  app.get('/appointments', async (req, reply) => {
    const appointments = await getSchedule(principalOf(req), req.query);
    return reply.send({ appointments });
  });

  app.get('/appointments/:id', async (req, reply) => {
    return reply.send(await getAppointment(principalOf(req), idOf(req)));
  });

  app.patch('/appointments/:id', async (req, reply) => {
    return reply.send(await rescheduleAppointment(principalOf(req), idOf(req), req.body));
  });

  /** Confirm, arrive, wait, cancel, no-show, left-without-being-seen. */
  app.post('/appointments/:id/status', async (req, reply) => {
    return reply.send(await setAppointmentStatus(principalOf(req), idOf(req), req.body));
  });

  app.get('/patients/:id/appointments', async (req, reply) => {
    const appointments = await getPatientAppointments(principalOf(req), idOf(req), req.query);
    return reply.send({ appointments });
  });

  // ---- Scheduling configuration ---------------------------------------------

  app.post('/schedule/resources', async (req, reply) => {
    const resource = await createResource(principalOf(req), req.body);
    return reply.code(201).send(resource);
  });

  app.get('/schedule/resources', async (req, reply) => {
    const { kind } = (req.query ?? {}) as { kind?: string };
    return reply.send({ resources: await getResources(principalOf(req), kind) });
  });

  app.post('/appointment-types', async (req, reply) => {
    const type = await createAppointmentType(principalOf(req), req.body);
    return reply.code(201).send(type);
  });

  app.get('/appointment-types', async (req, reply) => {
    return reply.send({ appointmentTypes: await getAppointmentTypes(principalOf(req)) });
  });
}
