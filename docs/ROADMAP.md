# Roadmap

Where Relay is, what is left, and what is deliberately not being built.

Status as of the current commit: **117 tests, lint and typecheck clean, CI green.**

---

## Shipped

### 1 · Foundation

- Bun monorepo — `apps/{api,realtime,web}`, `packages/{shared,database,auth,sync}`
- Fastify REST API, Drizzle ORM, PostgreSQL 18
- Next.js 15 client, React 19, Tailwind
- Local Postgres from npm-shipped binaries — no Docker, no admin rights
- Session auth: Argon2id passwords, opaque revocable server-side sessions
- Login timing equalised so registered emails are not enumerable

### 2 · Tenancy and authorization

- Workspaces, projects, issues, comments, append-only audit trail
- Four-role RBAC through a declarative permission matrix
- Non-members get 404 rather than 403, so workspace ids are not enumerable
- Structural rules: no granting above your own rank, no self-role changes, last
  owner protected from demotion/removal/leaving
- Per-project issue keys (`REL-104`) numbered under a row lock

### 3 · Realtime

- Separate Bun WebSocket gateway, authenticated with the same session cookie
- Fan-out over Postgres `LISTEN/NOTIFY` — transactional, so a rolled-back write
  emits no event
- Events carry ids, never row contents: one authorization path, self-healing
  across reconnects
- Presence in memory per instance, gossiped between instances, TTL-swept

### 4 · Offline

- `packages/sync`: IndexedDB store, durable mutation queue, ordered flush,
  reconciliation that preserves unflushed local work
- Exactly-once mutations: client-generated ids plus a server idempotency ledger
- Poison-message handling — permanent refusals are dropped, 408/429 are not

### 5 · Collaborative documents

The one place that genuinely needs CRDTs. Issue fields converge fine under
last-write-wins per field; concurrent edits to the *same paragraph* do not.

- `documents` table with an append-only update log and periodic compaction
- Yjs sync over the existing WebSocket gateway, with in-memory document rooms
- Awareness — live cursors, relayed and never persisted
- Editor bound to a shared `Y.Text`
- Convergence tests: concurrent edits, out-of-order delivery, duplicate
  updates, five replicas gossiping pairwise, and two live sockets

---

## In progress

### 7 · Hardening *(partly done)*

- [x] Service worker so the app shell loads with no network. Network-first for
      navigations, cache-first for fingerprinted assets, never for API traffic
- [ ] Rate limiting on auth and mutation endpoints
- [ ] Session cleanup job for expired rows
- [ ] Docker verified end to end (compose file exists but has never run here —
      no container runtime on this machine)

---

## Remaining

### 6 · Background work

- [ ] Job queue. The plan called for BullMQ + Redis; Postgres `SKIP LOCKED`
      is the likely substitute, for the same reasons NOTIFY replaced Redis
      pub/sub — one fewer service, and the enqueue can join the transaction
      that caused it
- [ ] Notifications: `@mention` parsing, in-app inbox, email delivery
- [ ] File attachments via presigned URLs (needs an S3-compatible target)
- [ ] Search — Postgres full-text first, with a documented comparison against
      a dedicated engine rather than adopting one reflexively

### 8 · Operations

- [ ] OpenTelemetry traces and metrics
- [ ] k6 load test: WebSocket fan-out and sync throughput under concurrency,
      with real numbers in the README rather than invented ones
- [ ] Deployment

---

## Known gaps in what exists

Honest list of things that are built but thin.

- **No issue detail page.** Issues are only viewable as board cards; there is no
  route for a single issue.
- **Comments have no UI.** The API, permissions and realtime events are done and
  tested; nothing renders them.
- **Board uses a status dropdown, not drag-and-drop.**
- **Offline covers the board only.** The app shell is cached, but other routes
  still fetch their data and will show the offline fallback if visited cold.
- **The document editor is a plain textarea.** No formatting, and remote
  cursors are listed by name rather than drawn inline.
- **Members cannot be managed from the UI.** Invite, role change and removal are
  API-only.
- **No password reset or email verification** — both need the mailer from
  milestone 6.
- **Issue list pagination is offset-based.** Fine at this size, but it will skip
  and duplicate rows under concurrent inserts; cursor pagination is the fix.

---

## Deliberately not doing

- **Elasticsearch, Terraform, NestJS.** Each adds operational surface without
  adding signal beyond what Postgres full-text search, docker-compose and
  Fastify already demonstrate.
- **Redis**, unless something needs it that Postgres genuinely cannot do. The
  NOTIFY-versus-Redis tradeoff is more interesting to explain than the presence
  of Redis is to list.
- **An AI feature as the centrepiece.** A small retrieval-and-summarise endpoint
  over issues and documents is worth adding at the end; it is not the project.
