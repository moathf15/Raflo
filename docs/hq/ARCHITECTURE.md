# HQ architecture

```
apps/hq (React)  ──HTTP /hq/v1 + SSE──▶  apps/hq-api (Fastify)
                                          ├─ modules/        REST API (auth, org, tasks, meetings, comms, knowledge, github, settings, dashboard)
                                          ├─ orchestrator/   worker (leased queue), tasks (execute/review/plan), meetings, chat, briefings
                                          ├─ agents/         runner (bounded tool loop), tools (permissioned), context + retrieval, role prompts
                                          ├─ providers/      Provider interface; Anthropic and OpenAI adapters (official SDKs); registry
                                          ├─ github/         REST client (fetch), connection, repo authorisation, branch/PR operations
                                          └─ db/             PostgreSQL (prod) / PGlite (dev, tests); migrations; organisation seed
```

One process runs the API and the background worker by default (`HQ_WORKER=true`). Work is stored in the
database and claimed with leases, so several processes can run workers; set `HQ_WORKER=false` on API-only
instances to separate them.

## Data model (`src/db/migrations/001_hq.sql`)

| Area | Tables |
| --- | --- |
| Owner | `hq_owners`, `hq_sessions` (token hashes), `hq_login_failures` |
| Organisation | `hq_departments`, `hq_employees` (role, skills, responsibilities, tool permissions, instructions, role memory, provider/model, live status) |
| Work | `hq_projects`, `hq_tasks` (status + `queue` + lease), `hq_task_deps`, `hq_task_comments`, `hq_task_attachments`, `hq_deliverables`, `hq_reviews` |
| Execution | `hq_runs` (one per agent run: model, tokens, cost, step log, error) |
| Meetings | `hq_meetings` (agenda, progress, minutes), `hq_meeting_participants`, `hq_meeting_events` (transcript), `hq_meeting_action_items` |
| Communication | `hq_channels` (announcements, department, project, direct), `hq_messages`, `hq_chat_queue`, `hq_notifications` |
| Knowledge | `hq_knowledge` (scope company/project/department/employee, confidential flag, generated `tsvector`) |
| Control | `hq_approvals`, `hq_change_proposals`, `hq_settings` (limits, policy, pricing, company), `hq_providers` (encrypted keys), `hq_integrations` (encrypted GitHub token), `hq_repos`, `hq_reports`, `hq_audit_log` |

## Agent execution (`agents/runner.ts`)

A run is one bounded tool-use loop for one employee:

1. Resolve the employee's provider (their own, else the default). No provider → `RunError(no_provider)`; the task is blocked with that message.
2. Before every model call: daily and monthly budget check (from recorded `hq_runs.cost_usd`), per-run token cap, step cap, run timeout.
3. The system prompt is the employee's **role prompt** (identity, responsibilities, skills, manager, standing instructions, role memory, operating rules). It depends only on configuration, so it is byte-stable and cached by the provider. Task context goes in the user turn.
4. Tools are the intersection of the employee's permissions and the run kind (reviews, meetings and chats get no side-effect tools).
5. The run ends when the model calls the run's **result tool** (`submit_deliverable`, `submit_review`, `create_plan`, `contribute`, `summarize_item`, `record_minutes`, `submit_briefing`). Its input is validated with zod; invalid input is returned to the model as a tool error.
6. Every model call and tool call is appended to the run log; tokens and cost are persisted after every call. The employee's office status is set by the code path actually running (thinking while waiting for the model, the tool's status while a tool runs).

Provider abstraction (`providers/types.ts`): a provider-neutral message format; assistant turns keep the provider's raw content so Claude thinking blocks are passed back unchanged inside a tool loop. Anthropic: Messages API, adaptive thinking with configurable `effort`, prompt caching, server-side refusal fallback on models that support it, typed error mapping. OpenAI: Chat Completions with function tools, optional temperature, OpenAI-compatible base URL.

## Orchestration (`orchestrator/`)

- **Worker**: claims, in order, a meeting step, an owner conversation, then the highest-priority runnable task (`queue` set, dependencies completed, assignee free, project active) with a lease. Concurrency comes from Settings → Limits; an employee does one thing at a time. On start, runs left `running` by a crash are marked failed and their tasks become claimable again (resume).
- **Tasks**: `execute` → deliverable → `completed`, or `under_review` when a reviewer is set → reviewer verdict → `completed` or a revision (up to *max revisions*, then blocked for the owner). Outcomes `blocked` and `needs_owner_decision` stop the task with the reason or question. Retryable provider errors back off and retry up to *attempts per task*.
- **Objectives**: the Chief of Staff gets the roster and produces a plan (subtasks, assignees, reviewers, dependencies). Plans are validated (known employees, unique keys, no cycles, max size). By default the owner approves the plan; then subtasks and a final synthesis task (Chief of Staff, depending on all subtasks) are created. Plans cannot create plans beyond *delegation depth*. Agents cannot create tasks any other way.
- **Messages between agents** are posted to channels and included in the recipient's next context; they never trigger a run, so agents cannot loop on each other.
- **Meetings**: one persisted step per worker claim — topic, each participant's turn (seeing the transcript and the owner's interjections), another round only if someone has an open point, was addressed, or the owner spoke (bounded by *max rounds*), the moderator's item summary, and finally minutes with decisions, disagreements, open questions and action items. Owner messages land between turns. A restart resumes from the stored progress.
- **Briefings**: facts are queried from the database; the Chief of Staff writes the summary only from those facts.

## Retrieval and memory

Each task context includes: the task, its project and parent objective, the latest deliverables of its
dependencies, review findings and owner answers on revisions, attachments (as untrusted input), the top company
knowledge by full-text rank within the employee's allowed scopes, the employee's last completed work, and recent
messages addressed to them. Role memory and instructions are part of the role prompt. Completed deliverables and
meeting minutes are added to the knowledge base automatically.

## GitHub flow

Connect (OAuth / GitHub App user token, or fine-grained token) → authorise repositories → agents with
`github.read` can list, read and search code, issues and pull requests (wrapped as untrusted content) →
developers with `github.propose` submit complete file contents → the owner reviews a unified diff → approval
commits to a new `hq/<slug>-<id>` branch from the base head (if branch writes are enabled) → the owner opens a
draft PR → merging requires the merge policy and typing the PR number. Issues requested by agents are created
only after approval. Issues can be assigned to employees; PRs can be sent to an employee for a review report;
CI check runs are shown per PR.
