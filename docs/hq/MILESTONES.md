# Milestones: acceptance criteria and review reports

Status legend: **Done** = implemented and covered by automated tests. **Partial** = works, with the stated gap.
**Not verified live** = implemented against the real API but not exercised with real credentials in this
environment (no Anthropic/OpenAI key or GitHub token was available while building).

Test references: `apps/hq-api/test/hq.test.ts` (integration, 29 tests) and `tests/e2e/hq.e2e.cjs` (browser).

## Milestone 1 — Headquarters foundation · Done

| Acceptance criterion | Evidence |
| --- | --- |
| Isolated app that keeps Raflo working | New workspaces `apps/hq-api`, `apps/hq`; `hq_*` tables; existing tests and typecheck unchanged and passing |
| Owner authentication | Setup code + scrypt password, server-side sessions (HttpOnly, SameSite=Strict), CSRF header + origin check, login throttling — tests *owner authentication and security* |
| 20 employees with identity, department, title, avatar, personality, skills, responsibilities, tools, manager | `db/org.ts` seed; test *organisation is seeded with 20 idle employees and no fabricated activity* |
| Office map with departments, meeting rooms, project room, lounge, operations | `office/` SVG map; e2e step *office shows 20 employees* |
| Employee profile with actions | `EmployeeProfile.tsx`; e2e opens it by mouse and by keyboard |
| Create / configure / archive employees | `POST/PATCH/DELETE /employees`; Employees page |
| Persistent storage across restarts | test *company data survives a restart* |

Review: the map is the interface to real state — positions (desk, meeting room, lounge for inactive employees) and
animations are derived from `hq_employees.status` set by the executing code. Gap: the map layout has fixed
rooms; departments that grow beyond their room width wrap desks to a second row.

## Milestone 2 — Real AI employees · Done (provider calls not verified live)

| Acceptance criterion | Evidence |
| --- | --- |
| Provider abstraction, Anthropic + OpenAI, configurable model/max tokens/effort/temperature | `providers/`; adapters reach both real APIs and map auth errors (checked with invalid keys) |
| No pretending without credentials | test *without a provider a task is blocked with a clear reason* |
| Keys encrypted, never returned | test *provider API keys are encrypted at rest and never returned* |
| Task execution, deliverables, usage and cost | test *an assigned task runs, produces a deliverable and records usage and cost* |
| Independent QA verification | test *QA independently reviews: changes requested, then the revision is approved* |
| Objective → plan → approval → dependency-ordered execution → synthesis | test *an objective is planned by the Chief of Staff…* |
| Owner decisions | test *an employee can ask the owner for a decision* |
| Budget, step and token limits; retries; resume after crash | tests *daily budget…*, *step limit*, *interrupted task resumes after a restart* |
| Memory and retrieval, confidential data protection | test *confidential knowledge is not sent to the provider unless allowed* |

Review: loops are bounded at every level (steps, tokens, time, attempts, revisions, delegation depth; messages
never trigger runs). Not verified live: the exact Anthropic request (effort, caching, refusal fallback) has not
been sent with a valid key here — run *Test connection* after adding a key.

## Milestone 3 — Meetings · Done

| Acceptance criterion | Evidence |
| --- | --- |
| Room → participants, title, objective, agenda, type (9), expected output | `NewMeetingPage`; e2e |
| Agents contribute in turns, respond to each other, disagree, ask; moderator | test *participants contribute in turns…* asserts later speakers saw earlier ones and a second round happened after a direct address |
| Owner participates live | same test and e2e (owner message appears and reaches later turns) |
| Live transcript, speaking indicator, agenda progress, decisions, questions, action items | `MeetingRoomPage` over SSE |
| Minutes (summary, points, decisions, disagreements, open questions, action items, owners, deadlines) persisted and reopenable | same test; meeting history page |
| Every event corresponds to a real execution | every speech row carries its `run_id` (asserted) |

## Milestone 4 — GitHub integration · Done (not verified live against github.com)

| Acceptance criterion | Evidence |
| --- | --- |
| Connect (OAuth / GitHub App user flow, or fine-grained token, verified before storing, encrypted) | test *connect with a verified token…* |
| Authorise repositories; agents read only those | test *agents can only read repositories the owner authorised* |
| Branches, commits, issues, PRs, files, CI checks, activity | GitHub page; read-endpoint smoke test |
| Assign issues to employees; PR review reports | test *GitHub issues are created only after approval, and issues can be assigned* |
| Code changes only as proposals, diff preview, approval → `hq/*` branch, PR, merge gated | test *a code change is only a proposal until approved…*; e2e diff + refusal |
| Never write default/protected branches | test *HQ never writes the default or a protected branch* |
| Repository content treated as untrusted | test *repository content reaches the agent wrapped as untrusted data* |

Review / blockers: tests run against a fake GitHub API that mirrors the REST endpoints used. Agents cannot run
the code or its tests (no sandbox is wired in), so QA verifies by reading code and diffs, and says so; CI
results come from GitHub check runs. Deploying is not implemented (no deployment target is defined for Raflo's
API); it would be another approval-gated action.

## Milestone 5 — Company operations · Done

Internal channels (announcements, departments, projects, direct), agent-to-agent messages, direct
conversations with real replies, notifications and toasts, knowledge base CRUD with scopes and confidentiality,
daily/weekly briefings from stored facts, performance metrics weighted toward quality (acceptance, review pass
rate, owner ratings, failures, cost) and owner rating of deliverables. Tests: *direct conversation produces a
real reply*, *briefings store facts…*, *performance is computed from stored outcomes*, read-endpoint smoke test.

## Milestone 6 — Polish and production readiness · Partial

Done: responsive layout (e2e asserts no horizontal scroll at 390 px), Arabic with RTL (logical CSS, centred SVG
labels; e2e asserts `dir=rtl`), keyboard navigation of the map, reduced-motion support, CSP, rate limits, audit
log, deployment documentation, automated tests.

Partial: Arabic covers navigation, statuses, rooms, office, profiles, meeting types, priorities and task
statuses; several deeper page labels and form hints are still English only. Employee names and AI output follow
the language they are written in.
