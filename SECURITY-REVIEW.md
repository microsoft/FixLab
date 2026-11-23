# PR125 security review

## Scope and outcome

This assessment covers the 13 outstanding bot review threads on
[PR125](https://github.com/microsoft/FixLab/pull/125), inspected at commit
`3505f93d784f0ef7492164667d659ce41d5e0120`.
It is not a repository-wide audit or a claim that the repository is secure.

The assessment found **1 HIGH, 4 MEDIUM, 3 LOW, and 5 false positives**.
The user initially selected documentation rather than implementation and
authorized resolution of non-high-priority threads without fixes. Resolution
records an explicit deferral or false-positive rationale; it does not mean
those behaviors were repaired. The user subsequently authorized repair of the
HIGH finding, described below; the original assessment remains historical.

## Findings

Equivalent CodeQL threads are grouped; the table accounts for all 13 threads.
For the false positives, MEDIUM is the scanner's rating, not a confirmed
vulnerability severity.

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | 🟠 HIGH | `dashboard/runtime-requests.js` | 11-51, 149-162 | Indexed Authorization assignments and header setters bypass credential screening and source-file trust checks | 9/10 |
| 2 | 🟡 MEDIUM | `dashboard/dev-browser.js` | 4-19 | Explicit DEV context options override the inherited job environment | 9/10 |
| 3 | 🟡 MEDIUM | `dashboard/dev-browser.js` | 23-28, 95 | Credential-sensitive debugging can expose authenticated request headers | 9/10 |
| 4 | 🟡 MEDIUM | `dashboard/dev-browser.js` | 46-55 | Frontend WebSocket exceptions permit unreviewed application channels | 9/10 |
| 5 | 🟡 MEDIUM | `dashboard/dev-browser.js` | 78-95 | Document and asset redirects can escape the approved origin | 9/10 |
| 6 | ⚪ LOW | `dashboard/shared-worktree.js` | 13-24, 53-74 | In-place profile writes can overwrite a pre-existing hard-linked backup | 10/10 |
| 7 | ⚪ LOW | `dashboard/shared-worktree.js` | 53-61 | Reuse onboarding lacks an execution lease and can interrupt an active job | 9/10 |
| 8 | ⚪ LOW | `dashboard/runtime-requests.js` | 54-56, 321-325 | Benign technical questions and replies are rejected; UX defect, not a demonstrated security exploit | 10/10 |
| 9 | 🟡 MEDIUM | `dashboard/issue-plans.js` | 264-272 | CodeQL 7/8/9: false positives for validated, JSON-serialized JavaScript literals | 10/10 |
| 10 | 🟡 MEDIUM | `test/dashboard-server.test.js` | 3361-3375 | CodeQL 12/13: false positives for JSON-serialized hardcoded test-matrix values | 10/10 |

## Evidence, prerequisites, and disposition

### HIGH: credential-screening bypass

Isolated probes using dummy Basic values confirmed that both indexed
Authorization assignments and header-setter calls expose the value in
permission details and allow approval and source-file trust. The actual
source-write policy also accepted both forms under existing job file trust.
With a real credential, a runtime-proposed edit can therefore place it into
publishable source. Gate-output redaction does not protect this approval path.

**Remediation follow-up:** the shared credential screen now recognizes indexed
Authorization assignments, header setters, and valid Basic payloads encoding
user/password pairs, including JSON-escaped representations. Both permission
display and source-file trust use this screen. Harmless authorization
namespaces/types and ordinary Basic-authentication prose remain reviewable.

Two focused regression tests failed before the repair and passed afterward.
They verify hidden details, denial of both approval and file trust, and actual
source-write policy denial for short and oversized edits. Existing test files
were extended; no new test dependency or permission was introduced. Full
validation and publication results are reported separately on PR125; this
summary does not claim a full-suite or live-application pass.

### MEDIUM: DEV browser boundaries

- Environment override requires an existing DEV write-enabled configuration.
  Inherited read-only and intercepted mutation restrictions remain enforced,
  and approved DEV origins still exclude other environments and production.
  Defer without a fix; do not override the selected job environment.
- Debug header exposure requires enabled sensitive debugging and authenticated
  traffic. Installed Playwright logs request and response headers. Structured
  gate redaction is counter-evidence but does not protect every direct runner.
  `PWDEBUG` alone was not established to leak headers. Defer without a fix;
  keep credential-sensitive debugging disabled.
- Unreviewed WebSocket operations require the approved frontend to expose an
  authenticated application or proxy socket. The installed implementation
  forwards messages automatically after connecting; external host/port sockets
  remain blocked. No production socket mapping was established. Defer without
  a fix; use only reviewed hot-reload sockets.
- Redirect escape requires a redirecting resource. Installed Chromium continues
  redirected requests without invoking user routing again. API requests
  separately disable redirects; automatic cross-origin credential theft was
  not established, and `assertHealthy()` returns `validationPassed: false`.
  Defer without a fix; use reviewed, nonredirecting resources.

These are operational constraints on accepted risk, not new enforced guards or
proof that a particular deployment meets them.

### LOW: local setup and question handling

Hard-link propagation requires a pre-existing, same-volume link and local writer
permissions. Both profile writers use the existing inode; symlink rejection
does not prevent this. No remote or elevated-write path was established, and no
filesystem-writing reproduction was performed. Defer without a fix; keep the
profile unlinked.

Reuse onboarding can change shared-mode or commit-binding metadata while a job
owns the checkout. Revision-bound DEV access detects configuration changes and
fails closed; the demonstrated risk is interruption or inconsistent execution,
not privilege escalation. Defer without a fix; perform onboarding only when
execution is quiescent.

Actual question/reply functions reject ordinary SDK-pinning and authorization
policy discussions. Rejected replies leave the request pending. Defer as an
acknowledged, unfixed UX issue; do not weaken credential-disclosure rejection.

### CodeQL: false-positive rationale

The browser compiler accepts primitive, bounded expected values, constructs
JavaScript literals through `JSON.stringify`, serializes selector components,
and allowlists methods. Six adversarial strings covering quotes, backslashes,
template tokens, HTML, and Unicode separators survived isolated compilation
and execution without injecting code.

The generated mutation-scope tests use only the hardcoded `intercepted` and
`none` matrix entries, then JSON-serialize them. Both generated variants
executed correctly in memory; no attacker-controlled source construction was
identified. Existing validation should remain unchanged.

All five alerts use `js/bad-code-sanitization`, scanner-rated MEDIUM, reported
against PR merge commit `c43f603991ae483e9326d837e9f18d922cedf760`. The conclusion
above comes from inspecting the pinned head, not the scanner rating alone.
Review-thread resolution does not independently dismiss a code-scanning alert.

## Validation limits

Evidence consists of source tracing and isolated in-memory probes. Playwright
behavior was checked against installed, lockfile-pinned version 1.63.0, rather
than upstream default-branch documentation. No full suite, live browser,
application, deployment, or production-data validation ran for this assessment.
The initial summary introduced no executable changes. The subsequent HIGH
remediation changes credential screening only and grants no new permissions.
