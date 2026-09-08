import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { SESSION_COOKIE } from '@relay/auth';
import { closeHarness, createActor, request, resetDatabase } from './harness.ts';

beforeEach(resetDatabase);
afterAll(closeHarness);

const PASSWORD = 'correct-horse-battery-staple';

describe('registration', () => {
  test('creates an account and starts a session', async () => {
    const response = await request('/auth/register', {
      method: 'POST',
      payload: { email: 'ada@relay.test', name: 'Ada', password: PASSWORD },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user.email).toBe('ada@relay.test');

    const cookie = response.headers['set-cookie'];
    expect(String(cookie)).toContain(SESSION_COOKIE);
    expect(String(cookie)).toContain('HttpOnly');
  });

  test('never returns the password hash', async () => {
    const response = await request('/auth/register', {
      method: 'POST',
      payload: { email: 'ada@relay.test', name: 'Ada', password: PASSWORD },
    });

    expect(response.body).not.toContain('argon2');
    expect(response.json().user.passwordHash).toBeUndefined();
  });

  test('rejects a duplicate email regardless of casing', async () => {
    await request('/auth/register', {
      method: 'POST',
      payload: { email: 'ada@relay.test', name: 'Ada', password: PASSWORD },
    });

    const response = await request('/auth/register', {
      method: 'POST',
      payload: { email: 'ADA@Relay.test', name: 'Impostor', password: PASSWORD },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('email_taken');
  });

  test('rejects a password below the length floor', async () => {
    const response = await request('/auth/register', {
      method: 'POST',
      payload: { email: 'ada@relay.test', name: 'Ada', password: 'short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_failed');
  });
});

describe('login', () => {
  test('accepts correct credentials', async () => {
    const actor = await createActor('Ada');

    const response = await request('/auth/login', {
      method: 'POST',
      payload: { email: actor.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(actor.id);
  });

  /**
   * Both failure modes must be indistinguishable, otherwise the endpoint
   * becomes a way to test whether an address has an account.
   */
  test('gives the same answer for a wrong password and an unknown account', async () => {
    const actor = await createActor('Ada');

    const wrongPassword = await request('/auth/login', {
      method: 'POST',
      payload: { email: actor.email, password: 'not-the-right-password' },
    });

    const unknownAccount = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'nobody@relay.test', password: 'not-the-right-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownAccount.json());
  });
});

describe('sessions', () => {
  test('/auth/me requires a session', async () => {
    const response = await request('/auth/me');

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthorized');
  });

  test('/auth/me returns the signed-in user', async () => {
    const actor = await createActor('Ada');
    const response = await request('/auth/me', { actor });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(actor.id);
  });

  test('a forged session token is rejected', async () => {
    const response = await request('/auth/me', {
      actor: { id: '', email: '', name: '', cookie: `${SESSION_COOKIE}=not-a-real-token` },
    });

    expect(response.statusCode).toBe(401);
  });

  test('logout revokes the session server-side, not just the cookie', async () => {
    const actor = await createActor('Ada');

    expect((await request('/auth/me', { actor })).statusCode).toBe(200);

    const loggedOut = await request('/auth/logout', { method: 'POST', actor });
    expect(loggedOut.statusCode).toBe(200);

    // Replaying the same cookie must now fail: the row is gone, so possession
    // of the token is no longer enough.
    expect((await request('/auth/me', { actor })).statusCode).toBe(401);
  });
});
