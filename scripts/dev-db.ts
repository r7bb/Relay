/**
 * Local Postgres without Docker.
 *
 * `embedded-postgres` ships real Postgres binaries via npm, which makes the
 * repo runnable on a machine with no container runtime and no admin rights.
 * We use its binaries but drive the lifecycle with `initdb`/`pg_ctl` directly:
 * the library spawns `postgres` as a direct child, so the server dies with the
 * script, whereas `pg_ctl` daemonises it the way a dev database should behave.
 *
 * `docker-compose.yml` remains the documented path for anyone who does have
 * Docker -- both listen on 5433 with the same credentials, so `DATABASE_URL`
 * is identical either way.
 *
 *   bun run db:start    provision (first run) and start
 *   bun run db:stop     stop, keeping data
 *   bun run db:reset    destroy the data directory and re-provision
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { pgBin } from './pg-paths.ts';

const DATA_DIR = resolve(import.meta.dir, '..', '.pgdata');
const LOG_FILE = join(DATA_DIR, 'server.log');
const PORT = 5433;
const USER = 'relay';
const PASSWORD = 'relay';
const DATABASE = 'relay';

function bin(name: string): string {
  const path = pgBin(name);
  if (!path) {
    throw new Error(
      `Could not locate "${name}". Run \`bun install\` to fetch the Postgres binaries.`,
    );
  }
  return path;
}

async function run(name: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([bin(name), ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  if (code !== 0) {
    throw new Error(`${name} exited with ${code}: ${stderr.trim()}`);
  }
}

/** Cheap liveness probe so start/stop are idempotent. */
function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const settle = (value: boolean) => {
      socket.destroy();
      done(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

async function provision() {
  console.log('Provisioning Postgres data directory...');

  // initdb refuses a password on the command line, so it has to go via a file.
  const dir = await mkdtemp(join(tmpdir(), 'relay-pw-'));
  const pwFile = join(dir, 'pw');

  try {
    await writeFile(pwFile, PASSWORD, { mode: 0o600 });
    await run('initdb', [
      '-D',
      DATA_DIR,
      '-U',
      USER,
      `--pwfile=${pwFile}`,
      '--auth-host=scram-sha-256',
      '--auth-local=trust',
      '--encoding=UTF8',
      '--no-sync',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The npm package ships only `initdb`, `pg_ctl` and `postgres` -- no `createdb`
 * or `psql` -- so the application database is created over the wire against the
 * bootstrap `postgres` database that initdb leaves behind.
 */
async function createDatabase() {
  const sql = postgres({
    host: '127.0.0.1',
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: 'postgres',
    prepare: false,
    onnotice: () => {},
  });

  try {
    // Identifiers can't be parameterised; DATABASE is a constant defined above.
    await sql.unsafe(`CREATE DATABASE "${DATABASE}"`);
  } finally {
    await sql.end();
  }
}

async function start() {
  if (await isListening(PORT)) {
    console.log(`Postgres already listening on port ${PORT}.`);
    return;
  }

  const fresh = !existsSync(DATA_DIR);
  if (fresh) await provision();

  // -w waits for the server to accept connections before returning.
  await run('pg_ctl', ['start', '-D', DATA_DIR, '-l', LOG_FILE, '-w', '-o', `-p ${PORT}`]);

  if (fresh) await createDatabase();

  console.log(`Postgres listening on postgres://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`);
}

async function stop() {
  if (!(await isListening(PORT))) {
    console.log('Postgres is not running.');
    return;
  }

  await run('pg_ctl', ['stop', '-D', DATA_DIR, '-m', 'fast', '-w']);
  console.log('Postgres stopped.');
}

async function reset() {
  await stop();
  await rm(DATA_DIR, { recursive: true, force: true });
  await start();
}

const commands: Record<string, () => Promise<void>> = { start, stop, reset };
const command = process.argv[2] ?? 'start';
const action = commands[command];

if (!action) {
  console.error(
    `Unknown command "${command}". Expected one of: ${Object.keys(commands).join(', ')}`,
  );
  process.exit(1);
}

await action();
