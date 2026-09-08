/**
 * Integration-test harness.
 *
 * Tests run against a real Postgres (`relay_test`), not a mock. The behaviour
 * under test here -- unique constraints, `ON DELETE CASCADE`, row locks around
 * the issue counter, transaction rollback -- is behaviour the database
 * provides, so a fake would only assert that the fake works.
 *
 * Requires the dev server to be up: `bun run db:start`.
 */
import { buildApp } from '@relay/api/app';
import { loadEnv } from '@relay/api/env';
import { createDatabase, type Database } from '@relay/database';
import { runMigrations } from '@relay/database/migrate';
import postgres from 'postgres';

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://relay:relay@localhost:5433/postgres';
const TEST_DB = 'relay_test';
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? `postgres://relay:relay@localhost:5433/${TEST_DB}`;

/** Every table that holds test state, in an order safe for `TRUNCATE CASCADE`. */
const TABLES = [
  'audit_events',
  'comments',
  'issues',
  'projects',
  'workspace_members',
  'workspaces',
  'sessions',
  'users',
];

type App = ReturnType<typeof buildApp>;

let handle: { app: App; db: Database; close: () => Promise<void> } | null = null;

async function ensureTestDatabase() {
  const admin = postgres(ADMIN_URL, { prepare: false, onnotice: () => {}, max: 1 });

  try {
    const [existing] = await admin`select 1 from pg_database where datname = ${TEST_DB}`;
    if (!existing) await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
}

/** Built once and shared; each test isolates itself with `resetDatabase`. */
export async function getHarness() {
  if (handle) return handle;

  await ensureTestDatabase();

  const { db, close } = createDatabase(TEST_URL, { max: 5 });
  await runMigrations(db);

  const env = loadEnv({
    DATABASE_URL: TEST_URL,
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const app = buildApp({ db, env });
  await app.ready();

  handle = { app, db, close };
  return handle;
}

export async function resetDatabase() {
  const { db } = await getHarness();
  // One statement so it is a single round trip and a single implicit
  // transaction; RESTART IDENTITY keeps sequences predictable across tests.
  await db.execute(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export async function closeHarness() {
  if (!handle) return;
  await handle.app.close();
  await handle.close();
  handle = null;
}

export type Actor = {
  id: string;
  email: string;
  name: string;
  /** Ready-to-send `cookie` header carrying this actor's session. */
  cookie: string;
};

let userCounter = 0;

/** Register a fresh user and return their identity plus session cookie. */
export async function createActor(name = `User ${++userCounter}`): Promise<Actor> {
  const { app } = await getHarness();
  const email = `user${userCounter}-${Date.now()}@relay.test`;

  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, name, password: 'correct-horse-battery-staple' },
  });

  if (response.statusCode !== 201) {
    throw new Error(`Failed to register actor: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('Register did not set a session cookie');

  const user = response.json().user as { id: string };

  return { id: user.id, email, name, cookie: raw.split(';')[0]! };
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  payload?: unknown;
  actor?: Actor;
  headers?: Record<string, string>;
};

/** Thin wrapper over `app.inject` that attaches the actor's cookie. */
export async function request(url: string, options: RequestOptions = {}) {
  const { app } = await getHarness();

  return app.inject({
    method: options.method ?? 'GET',
    url,
    payload: options.payload as never,
    headers: {
      ...(options.actor ? { cookie: options.actor.cookie } : {}),
      ...options.headers,
    },
  });
}

/** Create a workspace owned by `actor`. */
export async function createWorkspace(actor: Actor, name = 'Engineering') {
  const response = await request('/workspaces', { method: 'POST', payload: { name }, actor });
  if (response.statusCode !== 201) {
    throw new Error(`Failed to create workspace: ${response.statusCode} ${response.body}`);
  }
  return response.json().workspace as { id: string; slug: string; name: string };
}

/** Add `user` to `workspaceId` with the given role, acting as `actor`. */
export async function addMember(
  actor: Actor,
  workspaceId: string,
  user: Actor,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST',
) {
  const response = await request(`/workspaces/${workspaceId}/members`, {
    method: 'POST',
    payload: { email: user.email, role },
    actor,
  });

  if (response.statusCode !== 201) {
    throw new Error(`Failed to add member: ${response.statusCode} ${response.body}`);
  }
}

export async function createProject(actor: Actor, workspaceId: string, name = 'Web App') {
  const response = await request(`/workspaces/${workspaceId}/projects`, {
    method: 'POST',
    payload: { name },
    actor,
  });

  if (response.statusCode !== 201) {
    throw new Error(`Failed to create project: ${response.statusCode} ${response.body}`);
  }
  return response.json().project as { id: string; key: string };
}
