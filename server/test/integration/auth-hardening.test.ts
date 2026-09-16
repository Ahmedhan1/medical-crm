import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server.js';
import { makeClinic, makeUser, resetDb } from '../helpers/db.js';
import { RoleKey } from '../../src/modules/governance/permissions.js';
import { resetLoginThrottle } from '../../src/modules/auth/throttle.js';

let app: FastifyInstance;
let clinicId: string;

beforeEach(async () => {
  await resetDb();
  resetLoginThrottle();
  ({ clinicId } = await makeClinic());
  await makeUser(clinicId, 'reception', RoleKey.RECEPTION);
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

function login(password: string, username = 'reception') {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { clinicId, username, password },
  });
}

describe('auth hardening — account lockout (Task 1)', () => {
  it('locks the account after repeated failures and blocks even a correct password', async () => {
    // Default LOGIN_MAX_ATTEMPTS = 5 → first 5 wrong attempts are 401, then locked.
    for (let i = 0; i < 5; i++) {
      const r = await login('wrong-password');
      expect(r.statusCode).toBe(401);
    }
    const locked = await login('wrong-password');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('too_many_requests');
    expect(locked.headers['retry-after']).toBeDefined();

    // Even the CORRECT password is refused while locked (fail-closed).
    const correctButLocked = await login('password12345');
    expect(correctButLocked.statusCode).toBe(429);
  });

  it('does not leak whether the account exists (generic lockout message)', async () => {
    for (let i = 0; i < 6; i++) await login('x', 'ghost-user');
    const r = await login('x', 'ghost-user');
    expect(r.statusCode).toBe(429);
    expect(r.json().error.message).not.toMatch(/exist|unknown|no such/i);
  });

  it('locking one account does not affect another', async () => {
    await makeUser(clinicId, 'doctor', RoleKey.DOCTOR);
    for (let i = 0; i < 6; i++) await login('wrong', 'reception');
    expect((await login('wrong', 'reception')).statusCode).toBe(429);
    // A different account still authenticates normally.
    expect((await login('password12345', 'doctor')).statusCode).toBe(200);
  });
});
