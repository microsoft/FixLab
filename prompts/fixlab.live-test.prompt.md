---
mode: agent
description: Validate the expected behavior in the running application.
---

Start only the applications required by the effective diff, using the commands,
ports, environments, and health URLs in the FixLab profile. Track every process
created and never stop an unrelated process. Run the repository-defined
Playwright journey on the developer or registered-runner machine. Capture
sanitized screenshots, API assertions, logs, cleanup, and the exact observable
result.

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
