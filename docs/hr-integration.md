# CL Buddy → HR leave system integration

**Status:** built and tested, **switched off**. The base URL is a placeholder
(`https://hr-api.example.com/v1`) until the HR system's API is ready. The calls
below are our **proposed contract**. If the vendor's API differs, only
`apps/api/src/modules/integrations/hr/hr-client.ts` needs to change.

## What gets sent

Every leave change in CL Buddy is pushed to the HR system:

| CL Buddy change | Event | Call |
|---|---|---|
| Employee submits a request | `leave.request_submitted` | `POST /leave-requests` → returns `{ "id": "<hr id>" }` |
| Employee withdraws a pending request | `leave.request_withdrawn` | `POST /leave-requests/{hr id}/withdraw` |
| HR approves in CL Buddy | `leave.request_approved` | `POST /leave-requests/{hr id}/decision` |
| HR rejects in CL Buddy | `leave.request_rejected` | `POST /leave-requests/{hr id}/decision` |
| Approved leave is cancelled | `leave.cancelled` | `POST /leave-requests/{hr id}/cancel` |
| HR records leave directly (or imports it) | `leave.recorded` | `POST /leave-records` → returns `{ "id": "<hr id>" }` |

The `id` returned by a create call is stored with the leave and used in the URL of every later call for it.

## Request format

Headers on every call:

```
POST https://hr-api.example.com/v1/leave-requests
Authorization: Bearer <HR_API_TOKEN>
Content-Type: application/json
Idempotency-Key: 6f1c2f0e-6a2b-4a7e-9d0b-2f7a1d9c8e11
```

**Submitted request**

```json
{
  "clbuddy_leave_id": "0b6a3a2e-1c55-4d1e-9a65-1c1f5f0c6c11",
  "employee_email": "sam@codinglegends.io",
  "leave_type": "annual",
  "start_date": "2026-12-28",
  "end_date": "2026-12-29",
  "days": 2,
  "note": "Family trip",
  "status": "pending",
  "submitted_at": "2026-11-24T10:15:00.000Z"
}
```

Expected response: `201 { "id": "LR-10293" }` (any 2xx with an `id`).

**Decision**: `POST /leave-requests/LR-10293/decision`

```json
{ "decision": "approved", "note": "Enjoy!", "decided_by": "hr@codinglegends.io", "decided_at": "2026-11-24T11:02:00.000Z" }
```

**Withdraw / cancel**: `{ "withdrawn_at": "…" }` / `{ "cancelled_at": "…" }`.

**Recorded leave**: same fields as a submitted request, `status: "approved"`, `recorded_at` instead of `submitted_at`.

Field notes:
- `leave_type` is one of `annual`, `sick`, `parental`, `unpaid`, `other`.
- `days` counts working days (weekends and company holidays excluded) and may be `.5`.
- Dates are `YYYY-MM-DD`; timestamps are ISO 8601 UTC.

## Delivery guarantees

- **Never lost.** Each event is written in the same database transaction as the leave change (an outbox), then delivered by a background sender every `HR_SYNC_INTERVAL_MS`.
- **Safe to retry.** The `Idempotency-Key` is unique per event and identical on every retry. The HR API should treat a repeated key as the same request, ideally returning the original response.
- **In order per leave.** A decision is never sent before its request has been delivered.
- **Retries:**
  - **Retried with exponential back-off** (30 s, 1 min, 2 min … up to 1 h, `HR_SYNC_MAX_ATTEMPTS` times): network errors, timeouts (`HR_API_TIMEOUT_MS`), 408, 429 and 5xx.
  - **Failed immediately, not retried:** other 4xx responses.
- **Visible.** Admins see sent/waiting/failed counts and failures (with **Retry** and **Send now**) in **Organization → Integrations**.
- **Multiple API instances are safe.** Events are claimed with `FOR UPDATE SKIP LOCKED`.

## Switching it on

```bash
HR_SYNC_ENABLED=true
HR_API_BASE_URL=https://<real host>/<version>
HR_API_TOKEN=<token from the vendor>
```

Only leave created or changed **after** switching on is sent. Earlier leave isn't back-filled; follow-up events for it are skipped and logged. A one-off back-fill can be added if needed.

## Questions to settle with the vendor

1. **Authentication.** Bearer token? OAuth client credentials? IP allow-listing or mutual TLS?
2. **Endpoints and payload.** Their real paths and field names. Do they identify employees by email or by an employee id (we'd then need a mapping)?
3. **Idempotency.** Do they honour `Idempotency-Key`?
4. **Where approvals happen.** If approvals should happen **in the HR system** rather than in CL Buddy, they need to call **us** back (a signed webhook) with decisions. That's a small addition on our side once we know their callback format.
5. **Reading balances.** Should balances also come **from** the HR system? CL Buddy reads leave through a `LeaveDataSource` interface, so an HR-system-backed source can replace the local tables.
6. **Rate limits and sandbox.** Their rate limits and a test environment we can run against before going live.
