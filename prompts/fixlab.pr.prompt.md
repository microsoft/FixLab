---
mode: agent
description: Prepare an evidence-backed pull-request or no-change outcome.
---

Reuse an existing pull request when one was supplied. When publication is
authorized and a real repository change exists, create or refresh a draft PR
after the scoped change and smallest focused regression checks pass; remaining
independent validation may continue while that draft is open. Keep the PR
description current with the symptom, confirmed root cause, focused change,
completed and running checks, browser evidence, skipped gates, and remaining
risks. Never mark the PR ready or complete the PR stage until every required
local gate passes or repository policy records an explicitly accepted outcome.

Default draft handoff: for efficient fix-and-validate jobs with draft publication,
finish focused regression, required local gates and diff review, then create or
update the authorized draft PR and verify provider isDraft=true. Before optional
application startup, browser/API authentication or live testing, share the PR URL
and ask whether live testing is possible on the developer's machine and request PR
review. Wait for the user's explicit choice; do not infer consent from ticket
assignment, available authentication or a running portal. If live testing is
unavailable or declined, keep the same PR draft and record live checks as pending
or skipped, never passed. If accepted, validate the matching checkout and update
that same PR with actual results. Explicit strict/ready, validation-only,
manual/all-UI, unit-test-only and per-job validation choices remain authoritative;
required gates and merge policy are never waived.

PR team approval: after authorized PR creation or update, read
pullRequests.reviewTeams from the reviewed repository profile. For GitHub use
configured @org/team handles; for Azure DevOps resolve configured team identity
GUIDs to native mentions. Verify each team in the exact PR provider/repository;
never guess recipients. Read existing PR comments and post one approval-request
comment with verified mentions, PR link and actual validation status, marked
<!-- fixlab:team-review -->. Reuse only the authenticated author's matching
comment; do not duplicate notifications on retries or updates. Verify comment
readback before claiming success. No configured teams means no comment.
Missing permission, unresolved identity or uncertain acknowledgement: report
unconfirmed and reconcile, never blindly retry or block an existing PR.
Preserve draft status and all readiness/merge gates; never approve or merge.
Validation-only jobs must not post.

User-friendly updates: explain the issue and its impact in everyday language,
what changed, and what was actually checked. State plainly when checks failed,
could not run or were skipped, and say what the user needs to do next. Avoid
unexplained jargon, stage IDs, stack traces and command dumps. Include a verified
clickable PR link containing the fix; if no PR exists, use a verified commit link
when available. Never invent links or imply an untested change is verified. For
review requests, identify the PR's explicitly assigned reviewers rather than
guessing; Teams delivery requires an approved configured connection and verified
recipient identities.

Work-item validation evidence: in authorized code jobs only, only after approved
live browser validation actually runs scenario assertions for the original Azure
DevOps work item, use existing authorized Azure DevOps tools to attach an available
genuine, reviewed non-sensitive screenshot and comment the actual result and PR
link. Verify the exact work-item identity and scenario; verify the attachment
relation before claiming publication. Never upload intake images, stale artifacts,
login screens, browser state or invented screenshots. If validation cannot run, is
skipped or is API/unit-only, do not upload screenshots. Missing capture: comment the
actual result and reason without an image. Missing upload permission or an ambiguous
result: report the exact limitation locally; never bypass access controls or blindly
retry. Missing screenshots or evidence publication must not block the draft PR or
change validation outcomes; required validation/merge gates remain authoritative.

Reusable PR learning: within the existing pr stage, only when source edits and
PR publication are authorized, inspect task-relevant existing repository skills
for verified, non-obvious, reusable knowledge from this change. Prefer to update
a matching skill; otherwise create `.github/skills/<topic>/SKILL.md` with YAML name
and description; the name must match the lowercase-hyphenated topic directory.
Capture when to use it, the verified solution, repository file/test references,
exact working directories and validation commands, and pitfalls. Skills are for
future developers and relevant agent tasks, not a diary of the current run.
Include the skill in the same reviewed PR before committing/pushing; self-review
its instructions and run applicable documentation/skill checks. In the concise
PR body, link the added/updated skill or state no new reusable learning when none
qualifies; do not create empty, speculative or duplicate skills. Use no separate
roadmap stage. Read-only jobs must not write skills, commit or publish. Respect
repository instruction governance and existing approval boundaries. Do not add
allowed-tools or broaden permissions. Never include credentials, personal/customer
data, private endpoints or raw transcripts.

Keep the description short, normally at most 120 words unless required template
fields or material risks need more. Preserve required headings, a brief
problem/change summary, compact actual validation outcomes and material
risks/blockers. Keep failed, skipped, pending and not-run checks explicit.
Link evidence instead of pasting logs, command transcripts or stage narration.
Exclude token/cache counts, AI-credit totals and model-cost summaries from PR
descriptions.

Only when the saved publication policy explicitly requests ready-for-review:
after required local validation and approval gates pass or have an explicitly
accepted outcome, publish the authorized PR by marking it ready for review.
Do not wait for remote PR CI or build completion before publication; publication
can trigger those checks. Verify the PR is no longer draft before reporting the
PR stage passed. Report remote checks as pending, not passed, and leave merge
policies intact. Use `gh pr ready <number>` for GitHub or
`az repos pr update --id <id> --draft false` for Azure DevOps, then read back
`isDraft` from the provider to confirm it is false. If publication or state
verification fails, report the PR stage blocked or failed, not passed.
