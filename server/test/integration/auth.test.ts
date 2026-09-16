import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';

let app: FastifyInstance;
let clinicId: string;

beforeEach(async () => {
  await resetDb();
  ({ clinicId } = await makeClinic());
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

describe('auth', () => {
  it('logs in with valid credentials and returns permissions', async () => {
    await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { clinicId, username: 'reception', password: 'password12345' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.roles).toContain('RECEPTION');
    expect(body.user.permissions).toContain('patient:register');
  });

  it('rejects a wrong password with a generic 401', async () => {
    await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { clinicId, username: 'reception', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects unknown user without revealing which field was wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { clinicId, username: 'ghost', password: 'password12345' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid credentials');
  });

  it('requires a bearer token for protected routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('invalidates the session after logout', async () => {
    const { token } = await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/auth/logout', headers: auth });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth })).statusCode).toBe(401);
  });
});
