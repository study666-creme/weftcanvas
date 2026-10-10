# Generation Job Reliability Boundary

Generation is a server-owned workflow. React components may request work and
render public status, but they do not submit directly to a model endpoint,
poll provider tasks, charge a wallet, validate output, or decide retries.

## Implemented kernel

The current server-only kernel provides:

- a versioned public submission and job-status contract
- server-side re-quoting before reservation
- owner-scoped idempotency keys
- a strict, revisioned job state machine
- atomic store ports for reserve, capture, and release operations
- synchronous-result and asynchronous-task processing paths
- temporary polling failure recovery without changing job state
- result-reference handoff so large responses are not stored in job rows
- artifact kind, presence, and settlement validation before capture
- a guarded `submission_unknown` state for ambiguous request outcomes
- PostgreSQL migrations plus atomic job, reservation, wallet, and ledger writes
- database-level revision checks and immutable job-request enforcement
- reviewed text, image, and asynchronous video execution protocols
- manual redirect handling so credentials never follow a cross-origin redirect
- bounded, atomic, opaque result staging outside PostgreSQL
- forced full catalog refresh when an older snapshot has no private routes
- frozen per-job pricing snapshots for actual token settlement
- allowlisted HTTPS result downloads with per-hop redirect checks and bounded
  temporary files
- image decoding and video track validation through the shared media boundary
- idempotent generated-media persistence before wallet capture
- owner-scoped reference authorization before quote and wallet reservation
- PostgreSQL `SKIP LOCKED` leases, heartbeat renewal, retry schedules, and
  expired-lease recovery across worker restarts
- explicit, idempotent reconciliation records for `submission_unknown` without
  automatic resubmission
- a separately deployable worker that is never started by ordinary web/API
  development commands
- authenticated submit, list, snapshot, and SSE status routes
- PostgreSQL fixed-window submission/read limits plus transactionally enforced
  active-task limits under the account wallet lock
- monotonic public task versions and `Last-Event-ID` reconnect semantics

The browser can now create and observe jobs, but it never receives execution
routes or credentials and never polls model tasks directly. `POST` only reserves
and records work. A separately deployed worker leases and executes it.

## Browser integration

The desktop canvas now completes the public workflow:

- account session state is read once on entry and uses an HttpOnly same-origin
  cookie; ordinary canvas interactions do not repeat authentication checks
- each node loads only models matching its output modality
- controls are rendered from the current public capability schema rather than
  copied model-specific forms
- node content is bound to the catalog's public text input parameter
- compatible media on the node and its upstream graph is uploaded only when a
  confirmed submission needs it
- every submission displays and accepts a fresh server quote
- task snapshots arrive through SSE, with bounded polling only after stream
  failure
- refresh recovery lists owner/project tasks and resumes the newest task for
  each node
- each generation panel keeps a compact, refreshable recent-task list for its
  node without adding a separate project dashboard
- completed text or validated media artifacts update the originating node;
  additional artifacts become connected nodes exactly once

The canvas does not expose cancellation because the execution contract does not
currently guarantee it. A disconnected tab only stops observation.

## HTTP boundary

- `POST /api/v1/generation-jobs` re-quotes, revalidates references, reserves the
  wallet, and returns `202` with the durable task.
- `GET /api/v1/generation-jobs` recovers an account or project task list.
- `GET /api/v1/generation-jobs/:id` returns one owner-scoped snapshot.
- `GET /api/v1/generation-jobs/:id/events` streams public snapshots only when the
  task version changes. Terminal state is repeated once on reconnect so clients
  can close cleanly instead of entering an empty reconnect loop.
- `GET /api/v1/generation-jobs/reconcile?key=<idempotencyKey>` resolves one
  durable generation request by its existing idempotency identity. It is the
  authoritative read-only reconciliation for a persisted optimistic submission
  that the newest-100 list recovery cannot cover. It is authenticated,
  owner-scoped, bounded by the same idempotency-key grammar as submission, and
  rate-limited through the normal generation read guard. Both the native
  `GenerationJobStore` and the hosted `PromptHubGenerationStore` implement it by
  reusing their exact `findByIdempotency(ownerId, key)` lookup, never a capped
  list scan. It returns only the existing public job snapshot (`200`), or a
  `404` `GENERATION_JOB_NOT_FOUND` for an unambiguous miss. It never submits,
  retries, replays, mutates a job, resolves upstream access, or contacts a
  provider, and it discloses nothing cross-owner.

For a hosted job, `GET /api/v1/generation-jobs/:id` and the SSE initial event
return the durable local snapshot immediately and never synchronously wait on
access resolution, the `submission_unknown` recovery lookup, or an upstream task
read. The read-only reconciliation runs in the background with per-job
single-flight, a bounded timeout, and failure backoff/cooldown plus cleanup, so
a hanging, 429, 5xx, or offline upstream can neither block the response nor
permanently hold a connection or leak a rejection. Concurrent observers of the
same job share one in-flight reconciliation. Observation is always read-only and
never re-POSTs the paid envelope.

### Hosted terminal delivery

A completed/failed durable snapshot that the background reconciliation persists
is never missed because a read returned before the reconciliation settled.
When an observation read races an already-running reconciliation for the same
job, the read gives that in-flight read-only reconcile a strict bounded moment
(400 ms, never the full upstream timeout) and then re-reads the owner-scoped
store, so the terminal result is delivered on the same read instead of only on a
later SSE/poll read. A read that just started the reconciliation keeps the
immediate-response contract. The SSE status stream continues reading until a
terminal snapshot is emitted, so a stale initial event is always followed by the
terminal event on the same bounded stream (or obtained by the next bounded
poll).

An upstream that reports an image task `completed` without any usable artifact
URL (for example a malformed unified or Midjourney-style payload) is never
fabricated into a completed node with missing media: the job converges to an
explicit truthful `failed` with `GENERATION_RESULT_UNAVAILABLE`, which the node
surfaces as an actionable error instead of a permanent spinner. Video results
are fetched through the upstream task content route and do not require a URL in
the status snapshot.

### Browser observation liveness

The browser distinguishes transport failures from version/progress stagnation.
Consecutive SSE disconnects, poll fetch timeouts, 5xx, and 429 statuses share a
bounded transport budget (8); once spent, observation releases the
EventSource/fetch/timers and marks the node with the explicit temporarily
unavailable state ("暂时无法更新", non-spinning). A successful fetch of the same
nonterminal version is transport success but not job progress, so it resets only
the transport budget and must not reset the no-progress/exhaustion deadline
indefinitely. A snapshot whose version/status/progress signature never changes
accrues a conservative state-aware stagnation window (submitting/validating
6 min, queued/running 12 min) plus a delivery-count backstop; any advance resets
both, so legitimate long-running image/video jobs keep being observed.
`submission_unknown` is excluded entirely and keeps its existing read-only
recovery semantics with its own fast/slow polling cadence. When bounded
observation cannot advance, the node leaves the ordinary animation and shows the
explicit unavailable state; recovery is read-only and safe on project reopen
(the recovery list re-watches every non-final job) or through the existing retry
action, and never replays a generation POST or creates a second provider task.

### Exactly-once application

Completion is idempotent across duplicate SSE events, polling after SSE, refresh
recovery, multiple browser observers, and repeated list/get snapshots. The
originating node stops loading and receives its primary media once
(`applyGenerationJob` ignores a same-job snapshot whose version is not newer and
skips artifacts already present); every additional quoted artifact is enqueued
and connected exactly once. Artifact persistence is keyed by media id, wallet
refresh fires only on a genuine settlement boundary, and the same or higher
terminal version observed repeatedly never duplicates nodes, edges, toasts, or
media writes.

Submission and read windows are shared across API replicas in PostgreSQL. The
active-task cap is checked in the same transaction and owner wallet lock as the
credit reservation. SSE start frequency is shared; live connection caps are a
second process-level guard and should be paired with deployment connection
limits. A status stream ending never cancels generation.

## Public states

```text
reserved
  -> submitting
       -> queued -> running -> validating -> completed
       -> validating -> completed
       -> submission_unknown
       -> failed

queued/running/validating -> failed
submission_unknown -> queued/running/validating/failed after reconciliation
```

`completed` and `failed` are terminal. The product does not expose a stop
button because the currently selected generation routes do not guarantee task
cancellation. Leaving a page only disconnects observation; it must not alter
the job or reservation.

`submission_unknown` is not a financial terminal state, but it is terminal for
automatic browser observation and worker execution. The API emits that snapshot
once and closes the status stream. The browser stops SSE and polling, changes
the node from a loading state to a visible warning, and blocks another
submission from that node until reconciliation changes the task state. The
public task status is retained in the local project snapshot, so this lock also
survives an API outage or page restart. This prevents an ambiguous request from
becoming both an infinite sync loop and a duplicate paid task.

## Submission ambiguity

A network failure after a request is sent does not prove that generation was
rejected. Automatically submitting again could create duplicate work and cost.

The processor therefore:

1. commits `submitting` before the external request
2. records the returned task or result reference when available
3. moves an unresolved stale submission to `submission_unknown`
4. keeps its reservation and never resubmits automatically
5. accepts an explicit reconciliation result from a later log or task lookup

This favors a visible pending review over silent duplicate generation.

Observation recovery is strictly read-only. Every `GET`/SSE/poll/refresh/restart
of a persisted `submitting` or `submission_unknown` snapshot performs only the
bounded `clientRequestId` lookup (`/api/v1/video/requests/:clientRequestId` for
video, `/api/v1/generate/requests/:clientRequestId` for image) and, when the key
is found, reads the upstream task. It never re-POSTs the paid envelope, even
after a definitive miss, because the initial request may already have been
accepted upstream and a replay could create a second task and a second wallet
hold. A confirmed miss therefore keeps the node visibly pending until the
creator explicitly re-submits with a fresh key and a normal new debit.

The Prompt Hub video implementation must persist the submitted
`clientRequestId` on the wallet-owned task before calling New API, enforce one
row per user/request identity, and serve that row from
`GET /api/v1/video/requests/:clientRequestId`. A missing route implementation
must be treated as a deployment contract failure; repeated 404 lookup polling
is not a valid recovery state. Known pre-task routing rejections such as
`MODEL_UNAVAILABLE`, `ROUTING_UNAVAILABLE`, or `无可用渠道 (distributor)` are
definitive failures and do not enter this ambiguous recovery path.

A locally created hosted task (`phj_*`) is never shown as ordinary
`queued`/`running` work until both a validated durable upstream task id and an
interpretable upstream status exist. The API returns the local `submitting`
snapshot after a short response budget (default 500 ms) while the reference
transfer and the upstream POST are still in flight, so a slower upstream only
ever surfaces `submitting`. An upstream response without a durable task id, an
unsupported/unreadable status, a disconnected transport, or a POST timeout
becomes an observable `submission_unknown` (or an explicit `failed` for a
definitive outcome such as an upstream `timeout`/`expired` status); it is never
collapsed into a healthy queued/running appearance or a fabricated progress.

Every explicit reconciliation first writes a private, idempotent audit record
containing the actor, requested state, and bounded evidence. A fresh request for
a job that is no longer reconcilable is rejected. A pending audit can resume if
the job moved before the audit acknowledgement returned. The normal worker
queue excludes `submission_unknown` entirely.

## Post-refresh submission identity

When the browser starts a hosted submission it records a durable pending
identity for the target project node in browser local storage before the POST.
Only public bounded request metadata is stored: the opaque
`clientRequestId`/idempotency key and its local creation time. Credentials,
signed URLs, private media, raw uploads, and provider secrets never enter that
store. The store is bounded: the parser rejects malformed/non-object payloads,
empty/oversized keys, control-character scoped keys, excessive entry counts,
and non-finite/negative/future-impossible timestamps, and writes evict the
oldest identities once the map exceeds a fixed cap, so a stale record can never
grow without bound. A storage failure keeps the identity safely in memory for
the session.

If the browser is force-refreshed before the accepted job appears in the
recovery list (or before the POST response returns), the optimistic
`submitting` node is restored from the project snapshot. Recovery keeps such a
node locked as `submission_unknown` instead of releasing it to an actionable
error, because the server may already have accepted the request and a manual
retry would otherwise create a second logical request and a second debit. The
durable identity is preserved across the reload and is released only when:

- a genuinely new submission resolves it fresh: the node was not already inside
  the ambiguous window when that action started, so the stale identity is
  released and a fresh key is minted,
- a definitive, non-transient server failure is returned for that submission,
- the user explicitly abandons the ambiguous request from the existing status
  surface.

Observing a live server job for the node no longer releases the identity. The
public job snapshot carries no `clientRequestId`/idempotency key, so neither
node equality nor `createdAt` ordering can authoritatively correlate a same-node
job to the pending request; an unrelated older or newer active job could
otherwise unlock a newer ambiguous submission and allow a second paid task. The
browser therefore keeps the lock conservatively and documents this API
limitation until a fresh resolution or explicit abandonment.

While a durable pending identity exists and no fresh resolution or explicit
abandonment has released it, the node stays protected from a fresh submission
even if recovery restored a compatible visible result or an unrelated terminal
job onto the node. The panel keeps the node locked and exposes the existing
pending status ("可能已被受理，暂无法核对") with the explicit abandon action
instead of implying that the pending request was authoritatively resolved.

Recovery now resolves a durable identity through the exact read-only lookup
(`GET /api/v1/generation-jobs/reconcile?key=...`) rather than leaving the node
locked forever. A found job replaces the stale browser state with its true
live/completed/failed snapshot (and, when settled, releases the durable
identity); a settled job always releases the identity. A recent unresolved
identity inside one finite confirmation window (2 hours from `createdAt`) stays
protected and keeps the ordinary generating presentation. An unresolved
identity already older than the window is released immediately on recovery and
the node converges to an explicit actionable failure ("任务无法恢复，请重新
生成") with the normal retry action available. There is no permanent
`submission_unknown`, unknown, queued, running, validating, or locked spinner
once authoritative resolution or the finite window has settled the request.
Undo/redo snapshots are repaired together with the visible node through the
established project state helpers, so an undo/redo can never resurrect a
released identity or a permanent spinner. Recovery never issues a generation
POST and never silently mints a replacement identity.

An accepted job omitted by the newest-100 list is resolved directly by job id
(`GET /api/v1/generation-jobs/:id`); only a confirmed `404` terminalizes it.

For read-only verification of a locked `submission_unknown` task, the public
`GET /api/v1/wallet/ledger` view is available and is compatible with the
current points service ledger response: the Canvas adapter normalizes the
upstream list envelope server-side (both the historical `data.items` form and
the current bare `data` array), requires the critical financial fields
(`id`, `delta`, `balanceAfter`, `createdAt`), rejects oversized or malformed
lists, and drops unknown or private upstream fields. It never exposes the raw
upstream payload or private routes to the browser and never writes a second
balance.

## Worker leases

Runnable states are selected with `FOR UPDATE SKIP LOCKED`. A lease has a random
token, owner, expiry, heartbeat, total attempt count, consecutive error count,
and next-attempt timestamp. Only the current token may renew or release it.

An active task schedules its next poll without recording an error. Temporary
storage or network failures use bounded exponential backoff and leave the job
state unchanged. If a process dies, another worker may claim the job after the
lease expires. The job state machine still prevents a second submission: a
persisted `submitting` state becomes `submission_unknown` after its timeout
rather than being sent again.

## Storage transaction contract

The PostgreSQL adapter implements these operations atomically:

- `createWithReservation`: enforce `(owner_id, idempotency_key)` uniqueness,
  create the immutable job request, and reserve the quoted amount
- `save`: compare and increment `revision` for every non-financial transition
- `completeWithCapture`: persist validated artifacts and settle no more than the
  reserved amount in the same transaction
- `failWithRelease`: record the terminal error and release the hold once

Every operation must return the existing job on an idempotent replay and reject
stale revisions. An append-only ledger remains the financial source of truth.

## Media boundary

Provider response bodies, base64 images, and video bytes do not belong in the
job table. An execution adapter stages a result and returns an opaque reference.
The media adapter then validates signatures and decoding, writes the object to
durable storage, and returns public media metadata. Only after that succeeds may
the wallet capture the reservation.

## Execution adapter

The server adapter supports the reviewed catalog routes for text completion,
synchronous and task-based image generation, and asynchronous video
creation/status. Midjourney submits through `/v1/midjourney/generations` and
resumes only through `/v1/tasks/:taskId`. The route, fixed private model value,
parameter paths, and catalog versions are copied into the job at reservation
time and become immutable.

The currently published ids `Midjourney v8.2 高速` and `mj-v82` are valid UTF-8
public model ids. Canvas keeps each exact id in the quote and task while
projecting its provider-neutral `aspect_ratio` parameter to the public
Midjourney request field `size`; the Chinese characters do not change routing.
Both models require `prompt`, fix the provider submission count to `n: 1`, and
accept `size`, `raw`, and optional reference `image`/`images`. Only `mj-v82`
accepts `resolution` with `1K` or `2K`. A single request returns four images.

The adapter:

- rebuilds request JSON only from validated route parameters
- resolves reference media through a server-side media port
- rejects unsupported batch and streaming work before reservation
- never follows HTTP redirects with its authorization header
- treats a definitive client rejection as failed and refundable
- treats a dropped or ambiguous submission as `submission_unknown`
- leaves temporary polling failures unchanged for a later retry
- stages all task-based image outputs together; Midjourney preserves the grid
  cover first and the four individual images after it
- stages text, image descriptors, base64 payloads, or video task references in
  ignored server storage instead of a database row

The public API process never constructs execution adapters or reads a generation
key. `apps/worker` constructs them only when explicitly launched. Result
downloads require an explicit hostname allowlist; arbitrary provider-returned
URLs are never fetched. Reference ids carry the job owner through resolution,
and non-inline media uses a short-lived HMAC URL issued by the Canvas API.

## Next adapters

1. Add cleanup for expired reconciliation attempts and project-level media
   retention policies. Quarantined direct uploads already use a dedicated bucket
   lifecycle prefix; staged terminal results and stale local downloads are
   cleaned by the worker.
2. Add an admin-only operator surface for pending reconciliation records.
