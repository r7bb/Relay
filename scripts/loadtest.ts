/**
 * Load harness.
 *
 *   bun run loadtest
 *   bun run loadtest -- --connections 64 --subscribers 100 --duration 20
 *
 * Measures two things the README makes claims about: what the REST API does
 * under concurrency, and how long a write takes to reach every other client
 * through Postgres `LISTEN/NOTIFY`.
 *
 * The plan called for k6. k6 is a Go binary and there is no way to install one
 * on this machine, so this is written against the same runtime as the app.
 * That is a real downgrade in one specific way -- k6 runs the load generator
 * outside the runtime under test -- and the mitigations are noted below.
 *
 * How it tries to be honest:
 *
 *   - The API and gateway are spawned as *separate processes*, with request
 *     logging off. Driving an in-process server from the same event loop as
 *     the clients would measure the two contending for one thread.
 *   - The API phase is closed-loop (a fixed number of connections, each
 *     waiting for its response), so its numbers describe latency at that
 *     concurrency and cannot show queue collapse. The fan-out phase is
 *     open-loop -- events are offered on a fixed schedule whether or not the
 *     previous one finished -- because coordinated omission would otherwise
 *     hide exactly the backlog it exists to find.
 *   - A warmup period is discarded, so JIT and pool setup are not counted.
 *   - The harness measures its own event-loop lag during the run and reports
 *     it. The subscribers live in this process, so their scheduling delay is
 *     inside the delivery numbers; the lag figure is what lets a reader tell
 *     whether they are measuring the gateway or the harness.
 *   - Everything is created in a throwaway workspace and deleted afterwards.
 *
 * What it is not: a production benchmark. One machine, loopback networking,
 * a local Postgres, and a laptop CPU that thermally throttles. The numbers are
 * useful for comparing changes to this codebase against each other, and for
 * showing the shape of the system. They are not a capacity plan.
 */
import { createSession, hashPassword, SESSION_COOKIE } from '@relay/auth';
import {
  createDatabase,
  type Database,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from '@relay/database';
import { formatMs, type ServerMessage, type Summary, slugify, summarize } from '@relay/shared';
import { eq, inArray, sql } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://relay:relay@localhost:5433/relay';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function option(name: string, fallback: number): number {
  const flagIndex = process.argv.indexOf(`--${name}`);
  const raw =
    flagIndex !== -1
      ? process.argv[flagIndex + 1]
      : process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} expects a number, got "${raw}"`);
  return value;
}

const options = {
  /** Concurrent API callers. Closed-loop, so this is the concurrency, not a rate. */
  connections: option('connections', 32),
  /** Seconds of measured traffic per phase. */
  duration: option('duration', 10),
  /** Seconds of traffic discarded before measuring. */
  warmup: option('warmup', 3),
  /** Share of API operations that are writes. */
  writePercent: option('write-percent', 20),
  /**
   * Issue creation takes a row lock on the project to reserve the next issue
   * number, so writers in one project serialize. Spreading them shows the
   * uncontended path; `--projects 1` shows the contended one.
   */
  projects: option('projects', 4),
  /** WebSocket clients watching the workspace during the fan-out phase. */
  subscribers: option('subscribers', 50),
  /** Events per second offered during the fan-out phase. */
  rate: option('rate', 20),
  apiPort: option('api-port', 4100),
  wsPort: option('ws-port', 4101),
};

/** Dedicated ports, so a running dev stack is neither disturbed nor measured. */
const API_URL = `http://127.0.0.1:${options.apiPort}`;
const WS_URL = `ws://127.0.0.1:${options.wsPort}/ws`;

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function portIsFree(port: number): boolean {
  try {
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, name: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        await response.text();
        return;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }

  throw new Error(`${name} did not become healthy within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Actor = { userId: string; token: string; cookie: string };

type Fixture = {
  workspaceId: string;
  projectIds: string[];
  actors: Actor[];
};

/**
 * Build the workspace under test.
 *
 * Accounts and sessions are written straight to the database rather than
 * created through `/auth/register`. Registration is deliberately expensive --
 * Argon2id, by design -- and rate limited per address, so driving it here
 * would measure the password hash and then get throttled. Setup is not the
 * thing under test.
 */
async function setupFixture(db: Database, count: number): Promise<Fixture> {
  const runId = crypto.randomUUID().slice(0, 8);
  const name = `Load Test ${runId}`;

  // One hash reused for every account: the cost is per-password, not per-user,
  // and no one signs in to these.
  const passwordHash = await hashPassword(`load-${runId}`);

  const created = await db
    .insert(users)
    .values(
      Array.from({ length: count }, (_, i) => ({
        email: `loadtest-${runId}-${i}@relay.invalid`,
        name: `Load ${i}`,
        passwordHash,
      })),
    )
    .returning({ id: users.id });

  const ownerId = created[0]!.id;

  const [workspace] = await db
    .insert(workspaces)
    .values({ name, slug: slugify(name), createdBy: ownerId })
    .returning({ id: workspaces.id });

  await db.insert(workspaceMembers).values(
    created.map((user, i) => ({
      workspaceId: workspace!.id,
      userId: user.id,
      role: i === 0 ? ('OWNER' as const) : ('MEMBER' as const),
    })),
  );

  const createdProjects = await db
    .insert(projects)
    .values(
      Array.from({ length: options.projects }, (_, i) => ({
        workspaceId: workspace!.id,
        key: `LT${i}`,
        name: `Load project ${i}`,
        createdBy: ownerId,
      })),
    )
    .returning({ id: projects.id });

  const actors: Actor[] = [];
  for (const user of created) {
    const { token } = await createSession(db, user.id, 'loadtest');
    actors.push({ userId: user.id, token, cookie: `${SESSION_COOKIE}=${token}` });
  }

  return {
    workspaceId: workspace!.id,
    projectIds: createdProjects.map((p) => p.id),
    actors,
  };
}

/** Workspaces cascade to projects and issues; accounts go after, being referenced. */
async function teardownFixture(db: Database, fixture: Fixture) {
  await db.delete(workspaces).where(eq(workspaces.id, fixture.workspaceId));
  await db.delete(users).where(
    inArray(
      users.id,
      fixture.actors.map((a) => a.userId),
    ),
  );
}

// ---------------------------------------------------------------------------
// Event-loop lag
// ---------------------------------------------------------------------------

/**
 * How late this process is running its own timers.
 *
 * The subscribers are in this process, so if the harness is saturated its
 * delay shows up as gateway latency. Reporting the lag is what makes the
 * delivery numbers interpretable rather than merely precise.
 */
function startLagMonitor(intervalMs = 20) {
  const samples: number[] = [];
  let previous = performance.now();

  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - previous - intervalMs));
    previous = now;
  }, intervalMs);

  return { samples, stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Phase 1 - REST API under concurrency
// ---------------------------------------------------------------------------

type ApiResult = {
  read: number[];
  write: number[];
  errors: number;
  elapsedSeconds: number;
  /** Harness scheduling delay, to tell a saturated server from a saturated client. */
  lag: number[];
};

async function phaseApi(fixture: Fixture): Promise<ApiResult> {
  const read: number[] = [];
  const write: number[] = [];
  let errors = 0;
  let operation = 0;

  async function once(actor: Actor, projectId: string, collect: boolean) {
    // Deterministic interleaving rather than random, so two runs offer the
    // same mix and are comparable.
    const isWrite = operation++ % 100 < options.writePercent;
    const started = performance.now();

    let ok = false;
    if (isWrite) {
      const response = await fetch(
        `${API_URL}/workspaces/${fixture.workspaceId}/projects/${projectId}/issues`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: actor.cookie },
          body: JSON.stringify({ id: crypto.randomUUID(), title: `Load issue ${operation}` }),
        },
      );
      ok = response.ok;
      await response.text();
    } else {
      const response = await fetch(
        `${API_URL}/workspaces/${fixture.workspaceId}/projects/${projectId}/issues?limit=25`,
        { headers: { cookie: actor.cookie } },
      );
      ok = response.ok;
      await response.text();
    }

    const elapsed = performance.now() - started;

    if (!ok) {
      if (collect) errors++;
      return;
    }
    if (collect) (isWrite ? write : read).push(elapsed);
  }

  /** One closed-loop caller: never more than one request in flight. */
  async function worker(index: number, until: number, collect: boolean) {
    const actor = fixture.actors[index % fixture.actors.length]!;
    const projectId = fixture.projectIds[index % fixture.projectIds.length]!;

    while (performance.now() < until) {
      await once(actor, projectId, collect);
    }
  }

  const spawn = (until: number, collect: boolean) =>
    Promise.all(Array.from({ length: options.connections }, (_, i) => worker(i, until, collect)));

  await spawn(performance.now() + options.warmup * 1000, false);

  const lag = startLagMonitor();
  const startedAt = performance.now();
  await spawn(startedAt + options.duration * 1000, true);
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  lag.stop();

  return { read, write, errors, elapsedSeconds, lag: lag.samples };
}

// ---------------------------------------------------------------------------
// Phase 2 - Realtime fan-out
// ---------------------------------------------------------------------------

type FanoutResult = {
  ack: number[];
  first: number[];
  last: number[];
  published: number;
  expectedReceipts: number;
  actualReceipts: number;
  skipped: number;
  failed: number;
  subscribers: number;
  lag: number[];
};

/** Open one authenticated socket and resolve once it is subscribed. */
function connectSubscriber(
  actor: Actor,
  workspaceId: string,
  onEvent: (issueId: string) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL, { headers: { cookie: actor.cookie } });
    const timer = setTimeout(() => reject(new Error('subscribe timed out')), 15_000);

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('socket error'));
    });

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', workspaceId }));
    });

    socket.addEventListener('message', (message) => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(String(message.data)) as ServerMessage;
      } catch {
        return;
      }

      if (parsed.type === 'ready') {
        clearTimeout(timer);
        resolve(socket);
        return;
      }

      if (parsed.type === 'event' && parsed.event.type === 'issue.created') {
        onEvent(parsed.event.issueId);
      }
    });
  });
}

async function phaseFanout(fixture: Fixture): Promise<FanoutResult> {
  const subscriberCount = Math.min(options.subscribers, fixture.actors.length);

  /** Issue id -> when it was offered, and when each subscriber saw it. */
  const inFlight = new Map<string, { startedAt: number; receipts: number[] }>();

  const sockets = await Promise.all(
    Array.from({ length: subscriberCount }, (_, i) =>
      connectSubscriber(fixture.actors[i]!, fixture.workspaceId, (issueId) => {
        const record = inFlight.get(issueId);
        if (record) record.receipts.push(performance.now() - record.startedAt);
      }),
    ),
  );

  // Presence gossip from every socket joining at once is still settling;
  // measuring through it would attribute connect cost to fan-out.
  await Bun.sleep(500);

  const writer = fixture.actors[0]!;
  const projectId = fixture.projectIds[0]!;

  const ack: number[] = [];
  let published = 0;
  let skipped = 0;
  let failed = 0;

  /**
   * Cap concurrent writes. Open-loop means offering events on schedule
   * regardless of completion, but unbounded pile-up would end as a memory
   * problem rather than a measurement; skipped offers are counted and
   * reported instead of quietly lowering the offered rate.
   */
  const maxInFlight = Math.max(8, options.rate);
  let outstanding = 0;

  async function offer() {
    if (outstanding >= maxInFlight) {
      skipped++;
      return;
    }

    const issueId = crypto.randomUUID();
    const startedAt = performance.now();
    inFlight.set(issueId, { startedAt, receipts: [] });
    outstanding++;
    published++;

    try {
      const response = await fetch(
        `${API_URL}/workspaces/${fixture.workspaceId}/projects/${projectId}/issues`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: writer.cookie },
          body: JSON.stringify({ id: issueId, title: 'Fan-out probe' }),
        },
      );
      await response.text();

      if (response.ok) ack.push(performance.now() - startedAt);
      else failed++;
    } catch {
      failed++;
    } finally {
      outstanding--;
    }
  }

  const lag = startLagMonitor();

  const interval = setInterval(() => void offer(), Math.max(1, 1000 / options.rate));
  await Bun.sleep(options.duration * 1000);
  clearInterval(interval);

  // Let the tail arrive before counting anything as lost.
  await Bun.sleep(2000);
  lag.stop();

  for (const socket of sockets) socket.close();

  const first: number[] = [];
  const last: number[] = [];
  let actualReceipts = 0;

  for (const record of inFlight.values()) {
    actualReceipts += record.receipts.length;
    if (record.receipts.length === 0) continue;

    first.push(Math.min(...record.receipts));
    // Only a complete set means "everyone has it"; a partial max would
    // flatter the number by ignoring whoever had not received it yet.
    if (record.receipts.length === subscriberCount) last.push(Math.max(...record.receipts));
  }

  return {
    ack,
    first,
    last,
    published,
    expectedReceipts: published * subscriberCount,
    actualReceipts,
    skipped,
    failed,
    subscribers: subscriberCount,
    lag: lag.samples,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const COLUMNS = ['count', 'min', 'p50', 'p95', 'p99', 'max'] as const;

function header(label: string, width: number) {
  console.log(`  ${label.padEnd(width)}${COLUMNS.map((c) => c.padStart(9)).join('')}`);
}

function row(label: string, width: number, summary: Summary | null) {
  if (!summary) {
    console.log(`  ${label.padEnd(width)}${'no samples'.padStart(9)}`);
    return;
  }

  const cells = [
    String(summary.count),
    formatMs(summary.min),
    formatMs(summary.p50),
    formatMs(summary.p95),
    formatMs(summary.p99),
    formatMs(summary.max),
  ];

  console.log(`  ${label.padEnd(width)}${cells.map((c) => c.padStart(9)).join('')}`);
}

function reportApi(result: ApiResult) {
  const total = result.read.length + result.write.length;

  console.log(`\nPhase 1 · REST API under concurrency`);
  console.log(
    `  ${options.connections} connections · ${options.projects} project(s) · ` +
      `${options.writePercent}% writes · ${options.duration}s measured, ${options.warmup}s warmup discarded`,
  );
  console.log('');

  header('operation (ms)', 18);
  row('read  (list issues)', 18, summarize(result.read));
  row('write (create issue)', 18, summarize(result.write));

  console.log('');
  console.log(
    `  throughput  ${(total / result.elapsedSeconds).toFixed(0)} req/s over ` +
      `${result.elapsedSeconds.toFixed(1)}s · ${result.errors} error(s)`,
  );

  const lag = summarize(result.lag);
  if (lag) {
    console.log(
      `  harness event-loop lag  p50 ${formatMs(lag.p50)}ms · p99 ${formatMs(lag.p99)}ms ` +
        `(if this is large the client is the bottleneck, not the server)`,
    );
  }
}

function reportFanout(result: FanoutResult) {
  const completeness =
    result.expectedReceipts === 0 ? 0 : (result.actualReceipts / result.expectedReceipts) * 100;

  console.log(`\nPhase 2 · Realtime fan-out (write → every other client)`);
  console.log(
    `  ${result.subscribers} subscribed sockets · ${options.rate} events/s offered · ${options.duration}s`,
  );
  console.log('');

  header('stage (ms)', 18);
  row('write ack (HTTP)', 18, summarize(result.ack));
  row('first subscriber', 18, summarize(result.first));
  row('all subscribers', 18, summarize(result.last));

  console.log('');
  console.log(
    `  delivered   ${result.actualReceipts}/${result.expectedReceipts} ` +
      `(${completeness.toFixed(2)}%) across ${result.published} events`,
  );
  if (result.skipped > 0)
    console.log(`  skipped     ${result.skipped} offers (writer at capacity)`);
  if (result.failed > 0) console.log(`  failed      ${result.failed} writes`);

  const lag = summarize(result.lag);
  if (lag) {
    console.log(
      `  harness event-loop lag  p50 ${formatMs(lag.p50)}ms · p99 ${formatMs(lag.p99)}ms ` +
        `(subscribers share this process, so this is inside the delivery numbers)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

for (const port of [options.apiPort, options.wsPort]) {
  if (!portIsFree(port)) {
    console.error(`Port ${port} is in use. Pass --api-port / --ws-port to move the harness.`);
    process.exit(1);
  }
}

const { db, close } = createDatabase(DATABASE_URL, { max: 20 });

try {
  await db.execute(sql`select 1`);
} catch {
  console.error(`Cannot reach Postgres at ${DATABASE_URL}. Run "bun run db:start" first.`);
  await close();
  process.exit(1);
}

const childEnv = {
  ...process.env,
  DATABASE_URL,
  API_PORT: String(options.apiPort),
  REALTIME_PORT: String(options.wsPort),
  // The gateway rejects a mismatched Origin; the harness sends none at all,
  // which is allowed, but this keeps the setting explicit.
  WEB_ORIGIN: 'http://localhost:3000',
  API_LOG: '0',
};

const api = Bun.spawn(['bun', 'apps/api/src/main.ts'], {
  env: childEnv,
  stdout: 'ignore',
  stderr: 'inherit',
});

const gateway = Bun.spawn(['bun', 'apps/realtime/src/main.ts'], {
  env: childEnv,
  stdout: 'ignore',
  stderr: 'inherit',
});

let fixture: Fixture | null = null;

async function shutdown() {
  if (fixture) await teardownFixture(db, fixture).catch(() => {});
  api.kill();
  gateway.kill();
  await Promise.all([api.exited, gateway.exited]);
  await close();
}

process.once('SIGINT', async () => {
  await shutdown();
  process.exit(130);
});

try {
  await waitForHealth(`${API_URL}/health`, 'API');
  await waitForHealth(`http://127.0.0.1:${options.wsPort}/health`, 'Gateway');

  // Enough accounts for every subscriber to be a distinct session, which is
  // what the gateway would see in production.
  const accounts = Math.max(options.connections, options.subscribers, 1);
  fixture = await setupFixture(db, accounts);

  console.log('Relay load test');
  console.log(`  api         ${API_URL} (request logging off)`);
  console.log(`  gateway     ${WS_URL}`);
  console.log(`  database    ${DATABASE_URL.replace(/\/\/[^@]*@/, '//')}`);
  console.log(
    `  machine     ${process.platform} ${process.arch} · ${navigator.hardwareConcurrency} cores · Bun ${Bun.version}`,
  );

  reportApi(await phaseApi(fixture));
  reportFanout(await phaseFanout(fixture));

  console.log('\nSingle machine, loopback networking, local Postgres. Useful for comparing');
  console.log('changes to this codebase against each other; not a capacity plan.\n');
} finally {
  await shutdown();
}
