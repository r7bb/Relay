# Roadmap

Where Relay is, what is left, and what is deliberately not being built.

Status as of the current commit: **209 tests, lint and typecheck clean, CI green.**

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

### Presentation and onboarding

- Six workspace themes on CSS variables, including a light palette, with WCAG
  contrast asserted per theme and a test that fails if anything bypasses the
  tokens
- Engagement nudges from a periodic scan, rate-limited by a weekly dedupe key
- Tips-style guide pages, one per nudge, ending in an action that does the thing

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
- [x] Rate limiting on credential and search endpoints, injectable so the
      limiter itself is tested rather than disabled
- [ ] Docker verified end to end (compose file exists but has never run here —
      no container runtime on this machine)

---

### 6 · Background work *(mostly done)*

- [x] Job queue on Postgres `SKIP LOCKED` — backoff, dead-letter, visibility
      timeout, and enqueue that joins the caller's transaction
- [x] `@mention` parsing and in-app notifications, delivered by a worker
- [x] Session cleanup as a self-rescheduling job
- [x] Notification inbox UI with unread counts and mark-read
- [ ] Email delivery (needs an SMTP target)
- [ ] File attachments via presigned URLs (needs an S3-compatible target)
- [x] Search — Postgres full-text over issues, comments and documents, on
      stored generated columns so the index cannot drift from the rows

---

## Remaining

### 8 · Operations

- [ ] OpenTelemetry traces and metrics
- [ ] k6 load test: WebSocket fan-out and sync throughput under concurrency,
      with real numbers in the README rather than invented ones
- [ ] Deployment

---

## Known gaps in what exists

Honest list of things that are built but thin.

- **Board uses a status dropdown, not drag-and-drop.**
- **Offline covers the board only.** The app shell is cached, but other routes
  still fetch their data and will show the offline fallback if visited cold.
- **The document editor is a plain textarea.** No formatting, and remote
  cursors are listed by name rather than drawn inline.
- **Issue descriptions are not editable.** The field exists, the API accepts it
  and search indexes it; the detail page shows status, priority and assignee
  only.
- **Search has no dedicated results page.** It is a dropdown capped at 20 hits
  with no pagination or filtering by kind.
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
