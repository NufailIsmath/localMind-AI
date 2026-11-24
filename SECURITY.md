# Security

This document describes CL Buddy's threat model, the controls that address it, how they're tested, and the results of the most recent security assessment.

## Threat model

CL Buddy is a multi-user assistant over shared company documents. The main adversaries:

| Adversary | Goal |
|---|---|
| A curious or malicious **member** | Read documents above their clearance or not shared with them; escalate to admin |
| A **document author** planting text (indirect prompt injection) | Make *other users'* assistant leak data, call privileged tools, or mislead them |
| A **network attacker** | Abuse the API: injection, token forgery, enumeration, DoS |

Two assumptions drive the design:
1. **The model is untrusted.** Anything it reads may contain instructions, and we assume a worst-case, fully obedient model. Security can't depend on the model refusing.
2. **Documents are untrusted input**, including their file names and contents (PDF/DOCX parsers process attacker-supplied bytes).

## Controls

| Area | Control | Where |
|---|---|---|
| Authorisation | One access policy (owner / org / groups / individual grants, all capped by clearance), enforced inside the Qdrant search *and* re-checked in PostgreSQL. Identity comes from the request, never from the model. | `modules/access/access.policy.ts`, `rag/retrieval.service.ts` |
| Tool boundary | Allow-listed, **read-only** tools; Zod-validated arguments; role checks at listing and execution; timeouts; internal errors masked | `modules/tools/` |
| Prompt injection | Untrusted-data instructions in the system prompt; JSON-encoded tool results; heuristic **injection detector** that labels suspicious passages to the model, shows a warning on the citation and audits it | `rag/injection-detector.ts` |
| Output handling | Answers are rendered by a minimal Markdown renderer: no HTML, no images, no `[text](url)` links, and URLs are **inert text** (not clickable). This closes zero-click and one-click exfiltration. Plus a strict **Content-Security-Policy**. | `web/src/components/Markdown.tsx`, `web/next.config.ts` |
| Classification | Rules + model suggest a label after upload. Rules are a floor a prompt-injected model can't lower, suggestions only ever *raise* a label, and nothing is auto-applied. | `rag/classification.service.ts` |
| Disclosure of restricted content | "That's confidential" notices reveal only classification + audience; never private files; at most one above-clearance notice; per-user hourly cap; `ACCESS_DENIAL_MODE=silent` to disable | `modules/access/access.service.ts` |
| SQL injection | Prisma query builder everywhere; the only raw SQL is two constant statements; a test fails if `*RawUnsafe` appears in `src/` | — |
| Auth | scrypt hashing; HS256 JWT with ≥32-char secret and expiry; user/role/clearance reloaded per request; uniform login errors with timing equalisation; rate limits | `modules/auth/` |
| Account enumeration | Sign-up defaults to **first-user** mode (closes after the first admin; admins add people). Duplicate sign-ups get a vague message. | `config/env.ts` |
| Uploads | Size limit; extension + magic-byte check; zip-bomb guard for DOCX; 5,000-chunk cap; linear-time chunking; UUID storage names (0600); filenames stripped of paths, control and bidi/zero-width characters | `rag/` |
| Parsers | pdf.js 6.4 via unpdf (serverless build without `eval`; not affected by CVE-2024-4367); mammoth for DOCX; `npm audit`: 0 vulnerabilities | — |
| Transport | CORS allow-list; Helmet security headers; 1 MB JSON body limit; Bearer tokens (no cookies, so no CSRF); infra ports bound to 127.0.0.1 | `app.ts`, `infrastructure/` |
| Info leakage | Generic 500s; anonymous `/api/health` returns up/down only | `modules/health/` |
| Audit | Sharing, access, grants, requests, group/user changes, injection detections, notice-limit hits | `AuditEvent` table, admin panel |

## How it's tested

- `apps/api/test/integration/security.test.ts`:
  - **Prompt-injection containment:** the mock model is switched into an obedient "compromised" mode that executes `[[call:…]]` / `[[say:…]]` directives planted in shared documents. The tests verify that escalation to admin tools is denied, that forged `userId`/`clearance`/`groupIds` arguments are ignored (the secret never reaches the model's input), that document enumeration is limited, and that detection is audited.
  - **SQL-injection payloads** on every input type.
  - **Other attack classes:** mass assignment, path traversal and bidi filenames, CORS, security headers, body limits, expired tokens, sign-up enumeration.
- `access-control.test.ts`: a 5-person × 5-document matrix, checked through Qdrant alone and through the full path. It is mutation-tested: breaking either layer fails the suite.
- `restricted-notices.test.ts`, `classification-suggestions.test.ts`: leakage, forgery and rate-limit cases.
- `apps/web/e2e/security.spec.ts`: stored-XSS payloads in filenames, document text and model output render as text, with no injected elements, no clickable links and no alert dialogs.

## Assessment log

**Round 1 (code review).** Found and fixed:

| Finding | Fix |
|---|---|
| DOCX zip bomb crashed the server, and kept crashing it on restart | Zip guard; interrupted documents marked FAILED on restart |
| Quadratic-time chunking froze the API | Linear-time chunking |
| Deleted documents stayed searchable after a delete/index race | Delete reordered so no vectors are orphaned |
| A re-index request could be dropped | Re-index requests are queued, never dropped |
| Concurrent first sign-ups could create two admins | Sign-ups serialised with a lock |
| Missing index on `ToolExecution.messageId` | Index added |
| NUL bytes in a message caused a 500 | NULs stripped before saving |
| Internal hostnames appeared in client-facing errors | Errors made generic; details logged server-side |

**Round 2 (live penetration test).** No SQL injection, IDOR, JWT forgery, mass assignment, stored XSS, path traversal, parser CVE or SSRF found. Fixed:

| Severity | Finding | Fix |
|---|---|---|
| Medium | Injected answers could carry an exfiltration URL that the UI auto-linked (one click leaks data the victim can read) | URLs rendered as inert text; CSP added |
| Low | Sign-up revealed whether an email was registered | First-user sign-up by default, admin "Add person", vague duplicate message |
| Low | Repeated questions could map which restricted topics exist | Per-user hourly notice cap (audited); one above-clearance notice per answer; silent mode documented |
| Low | Unauthenticated health endpoint exposed model names | Details now require a token |

Also hardened proactively: the prompt-injection detector, bidi/zero-width filename stripping, and browser `%22` filename decoding.

## Known limitations

- **Prompt injection can't be fully prevented, only contained.** An injected model can still produce misleading *text* for the user who triggered it. It can't read beyond that user's access, call privileged tools, or render active content. Treat answers drawn from flagged sources with suspicion (the UI warns).
- **Revocation doesn't erase past answers.** Answers given before access was revoked remain in that user's chat history.
- **JWTs live in `localStorage`.** XSS is mitigated by React escaping, the renderer design and CSP, but an httpOnly-cookie session would be stronger.
- **Stateless JWTs can't be revoked before expiry.** Deleting the user, or changing their role/clearance, takes effect immediately because the profile is reloaded per request; token theft would need a shorter `JWT_EXPIRES_IN` or a denylist.
- **Rate limits and the notice cap are per process** (in memory). Use a shared store if you run several API instances.
- **Classification suggestions are heuristics.** A document that evades both the rules and the model gets no suggestion; the uploader's label stands.

## Reporting

This is a portfolio project. Please open a GitHub issue (without exploit details) or contact the maintainer privately.
