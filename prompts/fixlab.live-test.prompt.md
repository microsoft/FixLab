---
mode: agent
description: Validate the expected behavior in the running application.
---

Start only the applications required by the effective diff, using the commands,
ports, environments, and health URLs in the FixLab profile. Track every process
created and never stop an unrelated process. Run the repository-defined
Playwright journey on the developer or registered-runner machine. Capture
policy-compliant screenshots, sanitized API assertions/logs, cleanup, and the
exact observable result.

Scenario-first validation: execute the requested feature journey with
expected-versus-observed assertions, not a setup check, sign-in or screenshot alone.
Write/reuse one parameterized deterministic Playwright script as a discoverable .spec
file in a job-owned folder under configured testDir; honor testMatch/project; repair its syntax/selectors.
Verify --list before execution; report file path, runner command and assertion results.
Try permitted live reads first; if unavailable or no safe records, use approved
synthetic/intercepted data only under profile/mutation policy and label synthetic UI coverage separately.
Preserve live blockers; no fake HTML, sign-in or guard bypass.
Continue independent scenarios despite unrelated PR/build/setup blockers;
never use another checkout to prove an unpublished fix.
Finish independent scenarios before asking for dependent prerequisites.
API-only, unit-only and explicitly deferred checks keep their contracts.

For portal evidence, use `page.screenshot({ path, fullPage: true })`, not a
viewport-only or element screenshot. Default to unmasked full-page screenshots
of approved portal pages. Do not blanket-mask the page or ask again for default
screenshot capture. Close-ups supplement, not replace, full-page evidence.
If an existing journey captures only crops, add capture in a job-owned transient
wrapper; preserve the original test, shared configuration and guards. Normal
runtime permissions remain required.
Explicit repository privacy rules and genuinely sensitive content still require
protection; never capture credentials, sign-in/MFA screens or private/customer
data. Keep evidence local; external sharing needs separate approval.
API-only and unit-test-only runs require no browser screenshot.

By default, capture a numbered journey per scenario in repository-owned
test-results: entry/search, mode selection, input/import preview, and verified
result (01-search.png, 02-input.png, etc.), not just a final grid. Keep static
labels and approved test values readable; do not mask unrelated page regions
merely because capture is full-page. For imports, compute SHA-256 from the exact
bytes passed to the upload; retain only policy-approved inputs, filename/digest, and a labeled
safe preview of those same bytes. Compare expected versus observed values after
assertions. Never fabricate application screens; report incomplete evidence if
masking hides required values. Save/Submit and persistence remain unverified
unless separately authorized and asserted.

Verified read-only POST searches: Cover the full verified query scope for
approved DEV/PPE reads. Contracts/implementation must prove no business/workflow
mutation; names/verbs do not. Match the exact approved environment, origin and
path and supported payload, including redirects. Use existing authenticated
helpers and genuine returned records for GET/HEAD/OPTIONS and verified POSTs,
including intercepted-write jobs. Missing scope is a policy blocker, not
backend unavailability. Offer fixlab setup-queries REPOSITORY --environment ENV
--runtime RUNTIME as a separate plan-first setup operation: reviewed --yes
permits adapter/policy repairs and offline guard tests only, not product edits
or business calls. Read-only jobs must not edit configuration; changed helpers
need a fresh reviewed job. Do not silently substitute synthetic data, remove
guards or grant writes. Keep Save/Submit/Approve/autosave write-controlled;
identity-only proof query-disabled. Never override synthetic-only, API-only,
unit-only or production policy; synthetic evidence is not live integration.

For `browserAutomation.mode: "api"`, use `APIRequestContext` without a frontend,
browser binary, screenshot or video. Enforce the profile's approved origins,
read-only methods and redirects before sending requests; browser interception
does not protect API requests. Require fresh API authentication when configured.
Preserve only sanitized status/schema assertion results and `FIXLAB_TEST`
evidence. Missing access or startup blocks the live gate; never replace it with
synthetic API success or retain credentials or sensitive response bodies.
