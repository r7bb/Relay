# Relay

A local-first collaborative workspace — workspaces, projects and issues, with
role-based access control, live updates over WebSockets, and a board that keeps
working with the network switched off.

![Relay board](docs/screenshots/04-board.png)

Everything below is running code. The screenshots are captured from the app by
a script, not mocked up.

---

## Quick start

You need [Bun](https://bun.sh) 1.4+. **No Docker, no Postgres install, no admin
rights** — the dev database runs from Postgres binaries fetched through npm.

### 1. Install and configure

```bash
bun install
cp .env.example .env
```

### 2. Start the database and load demo data

```bash
bun run db:start     # provisions + starts Postgres on :5433
bun run db:push      # applies the schema
bun run db:seed      # 5 users, 2 projects, 10 issues
```

### 3. Run the three services

Each in its own terminal:

```bash
bun run dev:api        # REST API        → http://localhost:4000
bun run dev:realtime   # WebSocket gateway → ws://localhost:4001/ws
bun run dev:web        # Next.js client  → http://localhost:3000
```

### 4. Sign in

Open <http://localhost:3000>. Every demo account uses the password
`relay-demo-password`.

![Sign in](docs/screenshots/01-login.png)

| Email             | Role   | What they can do                                  |
| ----------------- | ------ | ------------------------------------------------- |
| `rohit@relay.dev` | OWNER  | Everything, including deleting the workspace      |
| `sarah@relay.dev` | OWNER  | Everything                                        |
| `alex@relay.dev`  | ADMIN  | Manage people and projects, but not delete the workspace |
| `john@relay.dev`  | MEMBER | Create and edit issues; cannot manage people      |
| `mia@relay.dev`   | GUEST  | Read and comment only                             |

### 5. You're in

![Workspaces](docs/screenshots/02-workspaces.png)

Click **Engineering**, then a project, to reach the board.

---

## See the interesting parts

### Live collaboration

Open the same workspace in two different browsers (or a normal window and a
private one) and sign in as two different people. The presence bar shows who
else is here, and a green ring means they are looking at the same board.

![Presence](docs/screenshots/03-workspace-presence.png)

Create an issue in one browser. It appears in the other **without a reload** —
measured at ~2ms locally.

![Realtime issue](docs/screenshots/05-realtime-issue.png)

Change its status in one browser and the card moves on the other.

![Realtime move](docs/screenshots/06-realtime-moved.png)

### Authorization you can see

Sign in as `mia@relay.dev` (GUEST) and open the same board. Same data, but the
add-issue field and every status dropdown are gone — and the API rejects the
request with `403` even if you send it by hand with `curl`.

![Guest board](docs/screenshots/07-guest-board.png)

### Working offline

Open a board, then cut the network (DevTools → Network → Offline, or turn off
Wi-Fi). The board keeps working — it renders from IndexedDB rather than fetching.

![Offline banner](docs/screenshots/08-offline-banner.png)

Create issues with no connection. They appear immediately, outlined in amber and
marked **Unsynced**, and the header counts what is waiting.

![Unsynced issues](docs/screenshots/09-offline-unsynced.png)

Reconnect and the queue drains by itself. The placeholder keys become real
`REL-7` / `REL-8`, the amber outlines clear, and anyone else on the board sees
the issues appear.

![After reconnect](docs/screenshots/11-after-reconnect.png)

**Scope, honestly:** this is offline for the board's *data*. The mutation queue
and the issue store live in IndexedDB and survive a reload — there is
[a test](tests/sync.test.ts) that constructs a fresh engine over the same
storage and flushes the queue it finds. What is *not* done is offline delivery
of the app itself: a cold page load with no network fails, because there is no
service worker caching the app shell, and routes other than the board still
fetch normally. That is the next piece of work, not a claim being made here.

---

## Commands

| Command                 | What it does                                  |
| ----------------------- | --------------------------------------------- |
| `bun run db:start`      | Provision and start the local Postgres        |
| `bun run db:stop`       | Stop it, keeping data                         |
| `bun run db:reset`      | Destroy the data directory and re-provision   |
| `bun run db:push`       | Sync the schema (development)                 |
| `bun run db:seed`       | Load demo data                                |
| `bun run grant:owner`   | Make an account OWNER of every workspace      |
| `bun run dev:api`       | REST API on :4000                             |
| `bun run dev:realtime`  | WebSocket gateway on :4001                    |
| `bun run dev:web`       | Next.js client on :3000                       |
| `bun test`              | Full suite against a real Postgres            |
| `bun run typecheck`     | Typecheck every package                       |
| `bun run lint`          | Biome lint + format check                     |
| `bun run lint:fix`      | Apply safe lint and format fixes              |

Bootstrap yourself into a fresh database:

```bash
bun run grant:owner you@example.com "Your Name" your-password
```

If you *do* have Docker, `docker compose up -d` starts the same Postgres on the
same port; skip `db:start` in that case.

---

## Architecture

```
        ┌──────────────┐
        │   Next.js    │  React 19 · TanStack Query
        │    :3000     │  presence · offline board
        └──┬────────┬──┘
           │  reads/writes go to IndexedDB first
        ┌──▼───────────┐
        │  sync engine │  durable mutation queue
        └──┬────────┬──┘
   REST +  │        │  WebSocket
   cookie  │        │  (same cookie)
        ┌──▼───┐ ┌──▼──────────┐
        │ API  │ │  Realtime   │
        │:4000 │ │  gateway    │
        │Fastify│ │   :4001    │
        └──┬───┘ └──┬──────────┘
           │        │  LISTEN
     write │        │  relay_events
           └───┬────┘
        ┌──────▼───────┐
        │  PostgreSQL  │  :5433
        │              │  NOTIFY on commit
        └──────────────┘
```

```
apps/
  api/          Fastify: routes, guards, mutations
  realtime/     Bun WebSocket gateway: fan-out + presence
  web/          Next.js client
packages/
  shared/       Permission matrix, domain enums, wire contracts
  database/     Drizzle schema, migrations, event bus
  auth/         Argon2 hashing, sessions
  sync/         Offline store, mutation queue, reconciliation
scripts/        Dev database lifecycle, seeding, admin bootstrap
tests/          Integration tests against real Postgres
docs/           Screenshots
```

`packages/shared` is imported by all three apps, so changing an event shape or a
request contract is a compile error everywhere rather than a runtime surprise.

---

## Engineering notes

The product surface is deliberately ordinary. These are the parts that weren't.

### Non-members get 404, not 403

The obvious rejection for someone else's workspace is `403 Forbidden`. That
answer confirms the workspace exists, turning the endpoint into an oracle:
iterate over ids and the 403/404 split maps out the tenant space.

[`requireMembership`](apps/api/src/plugins/authz.ts) returns **404** when there
is no membership row, and 403 only when a member lacks a specific permission —
at which point they already know the workspace exists.

### Authorization is a matrix, not scattered conditionals

Every check resolves to `can(role, permission)` against a table in
[`rbac.ts`](packages/shared/src/rbac.ts). Roles are built by extension, and a
test asserts they stay cumulative, so no role can ever do something its senior
cannot. Rules needing more than the actor's role live beside their data: an
admin cannot promote to owner, nobody can change their own role, and the last
owner cannot be demoted, removed, or leave.

The gateway and the API share one
[`findMembership`](packages/database/src/queries.ts) — two copies of an
authorization query is how they drift apart.

### Realtime runs on Postgres NOTIFY, not Redis

The plan called for Redis pub/sub. Postgres does it here, for one principled
reason and one practical one.

**`NOTIFY` is transactional.** A notification emitted inside a transaction is
delivered only if that transaction commits. Publishing to Redis from inside a
database transaction has no such guarantee — the message can go out and then the
write can roll back, leaving every client refetching stale data. Getting that
right against Redis needs an outbox table and a relay process; here it is free.
There is [a test](tests/realtime.test.ts) asserting a rejected write emits no
event.

**Practically**, it is one fewer service, and this machine has no Redis.

The cost is real: notifications are fire-and-forget with no persistence, the
payload caps at 8000 bytes, and each listener holds an idle connection. At high
fan-out Redis is the right replacement — but only
[two functions](packages/database/src/events.ts) would change.

### Events carry ids, never row contents

A payload would have to be filtered per recipient — an event about an issue must
not leak fields to someone whose role cannot read them — and would go stale
between publish and delivery. Sending an id and letting the client refetch
through the normal authorized endpoint keeps **one** authorization path instead
of two, and makes a missed event during reconnect self-healing.

### Presence is in memory, gossiped between instances

Presence changes on every navigation and heartbeat, and none of it is worth
durability. Writing it to Postgres would turn a read-mostly database into a
write-heavy one for data that is meaningless in thirty seconds.

So it lives in memory per gateway instance, and instances exchange deltas over
the same NOTIFY channel. A gateway that dies would leave ghosts, so every entry
carries a `lastSeenAt` refreshed by the client heartbeat and
[a sweeper](apps/realtime/src/presence.ts) drops stale ones. Redis with per-key
TTLs would remove the sweep.

### The gateway is a separate process

Long-lived sockets and short request/response traffic scale differently — one is
bounded by memory and file descriptors, the other by CPU — and separating them
means deploying the API does not drop every open connection.

### Issue numbering is a row lock, not a read-then-write

Human-readable keys (`REL-104`) need a per-project counter. Reading the maximum
and adding one races. Instead each create runs
`UPDATE projects SET issue_counter = issue_counter + 1 ... RETURNING` inside the
insert transaction, taking a row-level lock. A test fires 25 simultaneous
creates and asserts the results are exactly `1..25` — contiguous, proving
nothing collided *and* nothing was skipped.

### The local store is the source of truth for the UI

The board reads from IndexedDB and writes to it, then reconciles. Nothing in the
render path awaits the network, which is what makes it work offline rather than
merely degrade gracefully.

The inversion that makes this safe: **the local store is authoritative for the
UI, the server is authoritative for the world.** Reconciliation overwrites local
rows with server state — except rows with unflushed mutations, which keep their
local values, because discarding them would silently destroy work the user can
see on screen. There is
[a test](tests/sync.test.ts) for exactly that.

The engine talks to a
[`StorageAdapter`](packages/sync/src/storage.ts) and a `SyncTransport` rather
than to IndexedDB and `fetch`, so the interesting logic — queue ordering, retry
policy, convergence — is unit-testable with no browser and no server.

### Offline writes need exactly-once delivery, not at-least-once

A queued mutation that is replayed after an ambiguous failure — request sent,
response lost — must not apply twice. "Create issue" retried naively produces
two issues.

Two mechanisms together give exactly-once:

**The client names the row.** An offline create generates its own uuid, so the
issue can be rendered, referenced and edited before the server has heard of it.
A replayed insert then collides on the primary key instead of producing a second
row.

**The server keeps an idempotency ledger.** Each mutation carries a stable key;
[`withIdempotency`](apps/api/src/plugins/idempotency.ts) claims it with an
atomic `INSERT ... ON CONFLICT DO NOTHING`, and a replay returns the stored
response instead of re-running the handler. Reusing a key with a *different*
body is a 409 rather than a silent replay, because that is a client bug worth
surfacing. A failed attempt releases its key, so a transient error does not
poison it permanently.

### A poison message must not wedge the queue

The queue flushes in order and stops at the first transient failure — a create
that has not landed must not be overtaken by an edit against it.

But a 4xx means the server understood and refused, and retrying forever would
block every later mutation behind it. Those are dropped and the local change
rolled back. 408 and 429 are explicitly treated as transient, since they mean
"later", not "no".

### Sessions are opaque, not JWTs

Session lookup costs one indexed read per request. In exchange, signing out
actually invalidates the session. Only the SHA-256 of the token is stored, so a
database leak doesn't hand out usable cookies — and the same session logic
authenticates the WebSocket upgrade.

Plain SHA-256 rather than Argon2 is deliberate: the token is already 256 bits of
CSPRNG output, so there is nothing to brute-force. Passwords, which *are*
low-entropy, use Argon2id.

### Login doesn't leak which emails are registered

A failed login verifies a throwaway Argon2 digest when no user matches, so the
response takes the same time either way and both failures return an identical
body.

---

## Testing

**87 tests** against a real Postgres rather than mocks. The behaviour under test
— unique constraints, cascades, row locks, transactional `NOTIFY` — is behaviour
the database provides, so a fake would only prove the fake works.

```bash
bun test
```

| Suite                   | Covers                                                          |
| ----------------------- | --------------------------------------------------------------- |
| `rbac.test.ts`          | Permission matrix, role cumulativity, rank ordering              |
| `auth.test.ts`          | Registration, login, session revocation, enumeration resistance  |
| `authorization.test.ts` | Cross-tenant access, role boundaries, escalation, last owner     |
| `issues.test.ts`        | Numbering under concurrency, assignment, cascades                |
| `realtime.test.ts`      | Socket auth, fan-out, cross-workspace isolation, presence        |
| `sync.test.ts`          | Offline queue, retry, poison messages, convergence               |
| `idempotency.test.ts`   | Exactly-once mutations, key misuse, client-generated ids         |

The ones worth reading are adversarial: pasting another tenant's project id into
a URL you *do* have access to, an admin trying to promote itself past its
ceiling, a socket subscribing to a workspace it doesn't belong to, and the
25-way concurrent create.

---

## Status

**Done**

- Multi-tenant workspaces, four-role RBAC, audit trail
- Session auth (Argon2id, opaque server-side sessions)
- Projects and issues with per-project keys, comments
- Realtime updates and presence over WebSockets
- Offline-first board: IndexedDB store, durable mutation queue, exactly-once sync
- Next.js client with optimistic updates
- 87 tests, CI, linting, typechecking

**Next**

- Service worker so the app shell loads with no network
- CRDT documents (Yjs) for collaborative text
- Background workers, notifications, search, file uploads
- Load testing and OpenTelemetry

Collaborative text is the one remaining piece that genuinely needs CRDTs. Issue
fields converge fine under last-write-wins per field — two people editing
different fields of the same issue both keep their change — but concurrent edits
to the *same* paragraph do not, which is what Yjs is for.

---

## Notes on the local toolchain

The dev database uses
[`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres), which
ships real Postgres binaries through npm, so the repo runs with no container
runtime and no admin rights. Two wrinkles are handled in `scripts/`:

- The npm tarball loses the shared-library version symlinks the binaries link
  against, so `initdb` fails with a dyld error.
  [`fix-pg-dylibs.ts`](scripts/fix-pg-dylibs.ts) recreates them from
  `postinstall`.
- The package ships only `initdb`, `pg_ctl` and `postgres` — no `createdb` — and
  its JS wrapper spawns Postgres as a direct child, so the server dies with the
  script. [`dev-db.ts`](scripts/dev-db.ts) drives `pg_ctl` directly for a
  properly detached server and creates the database over the wire.

CI uses a plain Postgres service container instead, since it already has one.
