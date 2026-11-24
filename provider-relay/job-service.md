# Provider Relay Fal job MVP

The existing `/api/providers/fal/submit/*` and `/api/providers/fal/requests/*` endpoints remain unchanged. The optional job API is enabled only when the relay process has `AOWEISI_JOB_STORE` set; this avoids changing deployments that have not allocated a writable state directory.

```sh
AOWEISI_JOB_STORE=/var/lib/aoweisi-model-gateway/provider-relay-jobs.json \
  node server.mjs --origin https://example.test
```

The server mounts these routes:

```http
POST /api/providers/fal/jobs/flux-fill
Authorization: Bearer <caller-key>
Idempotency-Key: stable-client-key
Content-Type: application/json

{"image_url":"data:image/png;base64,...","mask_url":"data:image/png;base64,...","prompt":"..."}
```

The response is `202` with `{ "job_id", "status": "queued" }`. Poll with:

```http
GET /api/providers/fal/jobs/flux-fill/<job_id>
Authorization: Bearer <caller-key>
```

Cancel with `POST` to the same URL and `X-Job-Action: cancel`. A repeated idempotency key returns the same `job_id`; a different body returns `409`.

Only metadata, the request fingerprint, and the upstream provider job ID are persisted. Credentials and image payloads are process-local. A restart marks jobs with a provider ID as `recoverable`; the first authenticated status request resumes polling. Jobs interrupted before the provider returned an ID become `uncertain` and are never resubmitted automatically. Submit is never retried; transient status polling errors use bounded exponential backoff.


## Persistence failures after acceptance (2026-11)

- A known provider job ID always means query-only recovery; no path resubmits a paid request.
- `JsonJobStore` writes are serialized but independent: one failed write no longer blocks later writes.
- If the snapshot cannot be written after the provider accepted a job, the job stays `running`/`recoverable` in memory with
  `error.code = "persist_failed_after_accept"`, and `{ jobId, providerJobId }` is appended (fsync) to `<store>.accepted.jsonl`
  (mode 0600; sealed with the queue key when one is configured). A background retry rewrites the snapshot; journal entries are
  removed only after a successful snapshot that contains that job with that ID. Appends, snapshots and compaction share one
  serialized chain.
- On load the journal is applied before the restart rules, so such jobs become `recoverable` instead of `uncertain`. Entries that
  are malformed, unsealed (when a key is configured), longer than 4 KiB, for unknown/finished jobs, or beyond the 1 MiB read bound
  are ignored (an oversized journal is never compacted). Two different IDs for one job quarantine it as `uncertain`
  (`journal_conflict`) without querying either; a journal ID that differs from the snapshot keeps the snapshot ID (`journalConflict`).
- While storage is unhealthy, new jobs get `503 job_store_unavailable` and waiting durable jobs are not dispatched; a durable job
  whose submission marker could not be saved returns to the waiting queue without being submitted. Query-only polling continues.
- Limitation: if both the snapshot and the journal fail, the ID exists only in memory (`error.durability = "memory_only"`); a restart
  before storage recovers loses it and the job is `uncertain` (still never resubmitted).
- Concurrent creates with the same idempotency key admit exactly one job (the key is re-checked after the last await).
