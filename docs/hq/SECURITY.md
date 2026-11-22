# HQ security model

## Owner access
- First owner: created with a one-time setup code printed in the API log (or `npm run create-owner -w @riflo/hq-api -- you@domain` with `HQ_OWNER_PASSWORD`). Passwords: scrypt.
- Sessions: 32-byte random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production); only its SHA-256 is stored; revoked on sign-out; TTL `HQ_SESSION_TTL_HOURS`.
- CSRF: every write needs the `X-HQ-CSRF` header (cross-site forms cannot send it) and, when present, an allowed `Origin`.
- Roles: `owner` (all actions) and `viewer` (read only). Login throttled per IP+email (5 failures / 15 min); global rate limit.

## Credentials
- AI provider keys and the GitHub token are encrypted with AES-256-GCM (`HQ_ENCRYPTION_KEY`, required in production). The API never returns them (keys are shown masked).
- The GitHub token is verified with GitHub before it is stored. Use a fine-grained token or GitHub App limited to the Raflo repository.

## Agent boundaries
- Each employee has explicit tool permissions (`knowledge.read`, `knowledge.write`, `comms.send`, `github.read`, `github.propose`, `github.issue`, `external.publish`). Tools not granted are not offered to the model and are refused if called.
- Company policy (Settings → Permissions) applies on top: repository reading, `hq/*` branch writes (off by default), pull requests, merging (off by default), confidential knowledge to providers (off by default), protected branches.
- Every side effect is an approval: code changes (diff preview), GitHub issues, pull requests (explicit click), merges (type the PR number), external publishing (no integration exists; approved content is handed to the owner). Plans wait for approval by default.
- Never autonomous: deleting repository data, deploying, sending email or publishing. HQ has no tools for these. The security engineer has read-only tools only; no tool can reach external systems other than GitHub's API for authorised repositories.
- Agents cannot address the network, the file system or a shell.

## Untrusted input
Repository files, issues, pull requests and attachments are wrapped in `<untrusted source="…">` tags; the role
prompt states that such content is data and never instructions. Agent output is rendered by a Markdown renderer
that builds React elements (no `innerHTML`); links are limited to http(s).

## Runaway protection
Per-run step, token and time limits; daily and monthly budgets checked before every model call; retry and
revision limits; plan size and delegation depth limits; messages between agents never trigger runs; meetings
have bounded rounds and participants.

## Audit
`hq_audit_log` records owner sign-ins, setting and permission changes, employee changes, approvals and their
execution (branch, PR, merge, issue), knowledge changes and agent side effects. Visible under *Audit log*.

## Known limits
- Cost is estimated from token counts and the pricing table; a model without a price counts as $0 toward budgets (the dashboard warns).
- A single owner account model; multi-user roles beyond owner/viewer are not implemented.
