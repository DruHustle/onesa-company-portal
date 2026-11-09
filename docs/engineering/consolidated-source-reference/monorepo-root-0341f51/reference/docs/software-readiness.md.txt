# Software review and hardware readiness

This review records source work and local verification on 2026-11-04. A passing
software test is not a physical commissioning result. Robot remains an
authenticated simulator with physical-operation permission inactive; Drone
remains simulation-only, with real flight interfaces disabled.

## Confirmed defects corrected

| Area | Defect and resulting behavior |
| --- | --- |
| Consolidated verification | Nested workflows did not execute from the new repository root. Generated root workflows now retain the four products' complete verification and require an aggregate result. |
| Verification boundaries | Historical root paths and unexpected `.yaml` workflows could escape new migration checks. Regressions now cover both; staged content is scanned separately from working files. |
| Robot cancellation | Stop followed by Reset could allow an approval waiting on identity validation to resume a cancelled simulation. Approval now stays bound to its original stop epoch and fails after either boundary changes. |
| Drone request handling | Stalled or trickled request bodies lacked a total receive deadline. Requests now have a five-second total receive deadline and a 16 KiB limit, with bounded length parsing and common refusal headers. |
| Email configuration | Product examples used inconsistent sender subdomains. Portal and AI now default to their documented `@onesa.eu` notification addresses, validate one sender and preserve valid explicitly configured values. |
| Inbox observation | A sixty-second freshness check during a ninety-second wait could reject valid late arrivals. Admission is checked once and polling retains its fixed deadline with provider-aware pacing. |
| Inference interoperability | The existing portable client could accept unsupported Onesa model IDs or invalid transport credentials and discard actual backend/request provenance. Both the original client and Drone's vendored copy now validate these boundaries and retain optional provenance. |
| Source provenance | Consolidated image and Drone manifest records could identify the legacy repository incorrectly. Verification records now bind the actual repository, revision and product tree. Commissioned owner bridges can separately verify consolidated source, exact CI and actual artifact bytes; the result grants no release authority. Final readbacks reject changed branches, newer reruns and inconsistent API snapshots. |
| Browser qualification | The hosted Firefox gallery fixture failed before model requests when the runner could not create a real WebGL context. Linux CI now explicitly selects Mesa software rendering, and the fixture requires an actual WebGL2 pixel readback before the existing rendering assertions. |
| Operations mail retries | A pending event could change its sender, recipients or body while reusing its provider idempotency key. The monitor now durably saves the exact request before sending, retries those bytes, and holds credential changes or uncertain historical requests for reconciliation. Optional product routing is restricted to its existing Portal, AI and Robot API targets. |
| Kubernetes installation | Preserved read-only preparation helpers did not install a cluster. A separate first-install workflow now checks the intended OCI host, pinned artifacts, private networking and retained Portainer storage, while using the existing maintenance interlock and preserving application state on failure. |

The reviewed pending Portal private-CA and scoped inbox-observer changes are
preserved in this checkout. This does not imply that every old branch or review
has been merged; see [repository migration](repository-migration.md).

## Local evidence

The following results are local observations, not permanent guarantees or hosted
release receipts. The source CI remains the executable definition of required
checks.

| Scope | Result and limits |
| --- | --- |
| Root verification | 43 regression tests pass; workflow drift, actionlint, formatting and full-history publication/security checks pass. The original Portal/Robot repository documentation gates are retained. |
| Robot backend | Final full suite: 338 passed, plus lint, types and generated-contract agreement. |
| Drone backend | Full PostgreSQL suite: 251 passed before the later portable-client change; all 29 affected portability tests passed after that change. |
| AI backend | 534 passed; 267 database-dependent tests skipped because local PostgreSQL with pgvector was unavailable. Required CI database tests remain enabled. |
| Portal backend | Full disposable-database run: 214 tests passed; the scanner test process could not create its required Unix socket in this environment. The added private-CA and mail checks passed separately. |
| Frontends | Portal, AI, Robot and Drone lint/type/build checks passed. Robot had 92 passing unit tests; Drone had 13. |
| Release/tooling | Product policy/security and substantial offline release suites passed. Some host/root-specific cases require their documented environment. These results do not qualify live recovery, identity, mail or deployment. |
| Kubernetes preparation and first install | 59 focused tests pass, including artifact replacement, durable interruption handling, existing maintenance and revoked-hold rejection. Both systemd unit definitions passed configuration validation. No actual host installation is established. |
| Operations mail | 28 envelope/persistence and 30 notification-scope tests pass. The broader 237-test Oracle run passed 236 tests; one unchanged recovery fixture could not create its required Unix socket. No real email was sent by these tests. |

The environment denies Unix-domain sockets. Portal's local scanner/recovery
fixtures and browser engines therefore cannot complete here. A separate pinned
Chromium download also returned invalid archives. No browser application journey
was claimed from those launch failures. Docker runtime/container/ROS gates need
their supported runner. No timeout, security threshold, hardware permission or
required check was weakened to manufacture a passing result.

## Remaining acceptance work

1. Run the new workflows on the exact pushed source. Resolve every failing
   selected job, then protect the promotion branches with the observed required
   check and existing review policy. Source validation alone cannot qualify a
   new CI execution environment.
2. Qualify the actual hosted identity, database, inbox receipt and recovery
   flows through each product's existing release process. The mail-domain
   status and runtime migration requirements are in
   [email domain policy](email-domain.md).
3. Preserve the open AI documentation serving qualification and broader
   interoperability acceptance. The existing bounded text adapter is present;
   capability negotiation, streaming, scoped service identity, additional MCP
   capabilities and external-client qualification are not established by this
   patch. Existing source issues must be retained during repository retirement.
4. Before physical operation, select the actual devices and supported drivers,
   review the interface and risk requirements, and complete the product's
   physical commissioning and stop/recovery acceptance with authorized hardware
   operators. Simulator tests do not supply those observations. Keep the
   physical-operation and real-flight gates disabled until their independent
   acceptance criteria are met.
5. Finish preservation and migration of old repository branches, pull requests,
   private release evidence, hosting bindings and rollback access before the
   authorized repository deletion. Imported main history alone is insufficient.

This review does not certify that the entire product is defect-free, that all
requested future capabilities exist, or that physical hardware is ready to run.
It supplies reproducible fixes and explicit acceptance boundaries so the next
hardware work begins from a reviewable source state.
