import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildServer, requestLogSerializer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

/**
 * CCR-002 global regression: the PRODUCTION server logger must never write a
 * query string (which can carry a patient name/phone/MRN) into application logs.
 * This exercises the real `buildServer` logger config, not a stand-in.
 */
let app: FastifyInstance;

afterAll(async () => {
  if (app) await app.close();
});

describe('PHI logging firewall (CCR-002)', () => {
  it('serializer strips the query string but keeps the path', () => {
    const out = requestLogSerializer({
      method: 'GET',
      url: '/patients/search?q=Ahmed%20Hassan&phone=+201000000001',
      hostname: 'clinic-box',
    } as never);
    expect(out.url).toBe('/patients/search');
    expect(JSON.stringify(out)).not.toMatch(/ahmed/i);
    expect(JSON.stringify(out)).not.toContain('201000000001');
  });

  it('the real server never logs a searched name, but still logs the request', async () => {
    await resetDb();
    const { clinicId } = await makeClinic();
    const reception = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });

    app = buildServer({ loggerStream: stream });
    await app.ready();

    // Hit a normally-logged route (info level) with a sensitive query string.
    // This proves the GLOBAL serializer strips the query for every route, not
    // just the one route Agent 2 mitigated by lowering its log level.
    const pid = '00000000-0000-0000-0000-000000000000';
    await app.inject({
      method: 'GET',
      url: `/patients/${pid}?q=AhmedHassan&phone=201000000001`,
      headers: { authorization: `Bearer ${reception.token}` },
    });

    const output = lines.join('');
    // The request WAS logged (path present) so this cannot pass by logging nothing.
    expect(output).toContain(`/patients/${pid}`);
    // ...but the query values (a name, a phone) must be absent.
    expect(output).not.toMatch(/AhmedHassan/i);
    expect(output).not.toContain('201000000001');
    // ...and the bearer token/authorization header must be redacted.
    expect(output).not.toContain(reception.token);
  });
});
