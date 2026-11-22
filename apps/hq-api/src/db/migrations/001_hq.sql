-- RAFLO AI HQ schema. Isolated from the Raflo product tables: every table is prefixed hq_.

CREATE TABLE hq_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL DEFAULT 'Owner',
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES hq_owners(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_login_failures (
  id bigserial PRIMARY KEY,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_login_failures (key, created_at);

CREATE TABLE hq_departments (
  id text PRIMARY KEY,
  name_en text NOT NULL,
  name_ar text NOT NULL,
  color text NOT NULL,
  sort int NOT NULL DEFAULT 0
);

CREATE TABLE hq_employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  title text NOT NULL,
  title_ar text NOT NULL DEFAULT '',
  department_id text NOT NULL REFERENCES hq_departments(id),
  manager_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  avatar jsonb NOT NULL DEFAULT '{}',
  personality text NOT NULL DEFAULT '',
  skills jsonb NOT NULL DEFAULT '[]',
  responsibilities jsonb NOT NULL DEFAULT '[]',
  tools jsonb NOT NULL DEFAULT '[]',
  instructions text NOT NULL DEFAULT '',
  role_memory text NOT NULL DEFAULT '',
  provider_id uuid,
  model_override text,
  active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'idle',
  status_detail text,
  status_since timestamptz NOT NULL DEFAULT now(),
  current_task_id uuid,
  current_meeting_id uuid,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE hq_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  repo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES hq_projects(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES hq_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'plan', 'synthesis')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  acceptance_criteria text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog', 'assigned', 'in_progress', 'under_review', 'blocked', 'waiting_approval', 'completed', 'rejected', 'cancelled')),
  -- What the worker should do next with this task: run it, review it, plan it. NULL = nothing queued.
  queue text CHECK (queue IN ('execute', 'review', 'plan')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  reviewer_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  created_by text NOT NULL DEFAULT 'owner',
  deadline timestamptz,
  depth int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  revision int NOT NULL DEFAULT 0,
  lease_until timestamptz,
  blocked_reason text,
  owner_question text,
  github_issue jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_tasks (status);
CREATE INDEX ON hq_tasks (queue) WHERE queue IS NOT NULL;
CREATE INDEX ON hq_tasks (assignee_id);
CREATE INDEX ON hq_tasks (parent_id);

CREATE TABLE hq_task_deps (
  task_id uuid NOT NULL REFERENCES hq_tasks(id) ON DELETE CASCADE,
  depends_on_id uuid NOT NULL REFERENCES hq_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE hq_task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES hq_tasks(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('owner', 'employee', 'system')),
  author_id text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_task_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES hq_tasks(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime text NOT NULL DEFAULT 'text/plain',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('task', 'review', 'plan', 'meeting_turn', 'minutes', 'chat', 'briefing')),
  task_id uuid REFERENCES hq_tasks(id) ON DELETE SET NULL,
  meeting_id uuid,
  employee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  provider text,
  model text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_read_tokens int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(12, 6),
  model_calls int NOT NULL DEFAULT 0,
  log jsonb NOT NULL DEFAULT '[]',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON hq_runs (started_at);
CREATE INDEX ON hq_runs (employee_id);
CREATE INDEX ON hq_runs (task_id);

CREATE TABLE hq_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES hq_tasks(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  run_id uuid REFERENCES hq_runs(id) ON DELETE SET NULL,
  version int NOT NULL DEFAULT 1,
  summary text NOT NULL,
  content text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'accepted', 'changes_requested', 'rejected')),
  owner_rating int CHECK (owner_rating BETWEEN 1 AND 5),
  owner_feedback text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES hq_tasks(id) ON DELETE CASCADE,
  deliverable_id uuid REFERENCES hq_deliverables(id) ON DELETE CASCADE,
  reviewer_type text NOT NULL CHECK (reviewer_type IN ('employee', 'owner')),
  reviewer_id text,
  verdict text NOT NULL CHECK (verdict IN ('approved', 'changes_requested', 'rejected')),
  summary text NOT NULL DEFAULT '',
  findings jsonb NOT NULL DEFAULT '[]',
  run_id uuid REFERENCES hq_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room text NOT NULL,
  title text NOT NULL,
  objective text NOT NULL,
  agenda jsonb NOT NULL DEFAULT '[]',
  type text NOT NULL,
  expected_output text NOT NULL DEFAULT '',
  project_id uuid REFERENCES hq_projects(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'wrapping_up', 'completed', 'failed', 'cancelled')),
  moderator_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  max_rounds int NOT NULL DEFAULT 2,
  progress jsonb NOT NULL DEFAULT '{"item":0,"round":0,"spoken":[]}',
  end_requested boolean NOT NULL DEFAULT false,
  minutes jsonb,
  error text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE hq_meeting_participants (
  meeting_id uuid NOT NULL REFERENCES hq_meetings(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES hq_employees(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, employee_id)
);

CREATE TABLE hq_meeting_events (
  id bigserial PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES hq_meetings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('system', 'topic', 'speech', 'owner', 'item_summary')),
  employee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  agenda_index int,
  content text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  run_id uuid REFERENCES hq_runs(id) ON DELETE SET NULL,
  consumed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_meeting_events (meeting_id, id);

CREATE TABLE hq_meeting_action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES hq_meetings(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  assignee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  deadline date,
  task_id uuid REFERENCES hq_tasks(id) ON DELETE SET NULL
);

CREATE TABLE hq_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('announcements', 'department', 'project', 'direct')),
  name text NOT NULL,
  department_id text REFERENCES hq_departments(id) ON DELETE CASCADE,
  project_id uuid REFERENCES hq_projects(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES hq_employees(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON hq_channels (employee_id) WHERE kind = 'direct';
CREATE UNIQUE INDEX ON hq_channels (department_id) WHERE kind = 'department';
CREATE UNIQUE INDEX ON hq_channels (project_id) WHERE kind = 'project';

CREATE TABLE hq_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES hq_channels(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('owner', 'employee', 'system')),
  author_id text,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  run_id uuid REFERENCES hq_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_messages (channel_id, created_at);

-- Owner messages in a direct channel waiting for the employee's reply.
CREATE TABLE hq_chat_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES hq_channels(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES hq_employees(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES hq_messages(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'company' CHECK (scope IN ('company', 'project', 'department', 'employee')),
  project_id uuid REFERENCES hq_projects(id) ON DELETE CASCADE,
  department_id text REFERENCES hq_departments(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES hq_employees(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'other',
  title text NOT NULL,
  body text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]',
  confidential boolean NOT NULL DEFAULT false,
  source jsonb NOT NULL DEFAULT '{}',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_knowledge USING gin (tsv);

CREATE TABLE hq_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('plan', 'github_issue', 'code_change', 'pull_request', 'merge', 'external_publish', 'owner_decision')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
  employee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  task_id uuid REFERENCES hq_tasks(id) ON DELETE CASCADE,
  decided_by uuid REFERENCES hq_owners(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_approvals (status);

CREATE TABLE hq_change_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES hq_tasks(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES hq_employees(id) ON DELETE SET NULL,
  repo text NOT NULL,
  base_branch text NOT NULL,
  base_sha text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  files jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'rejected', 'branch_created', 'pr_opened', 'merged', 'failed')),
  branch text,
  commit_sha text,
  pr_number int,
  pr_url text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('anthropic', 'openai')),
  label text NOT NULL,
  model text NOT NULL,
  api_key_enc text NOT NULL,
  base_url text,
  temperature numeric,
  max_tokens int NOT NULL DEFAULT 16000,
  effort text CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max')),
  is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_check jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_integrations (
  kind text PRIMARY KEY,
  token_enc text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_oauth_states (
  state text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES hq_owners(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_repos (
  full_name text PRIMARY KEY,
  default_branch text NOT NULL,
  private boolean NOT NULL DEFAULT false,
  allowed boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('daily_briefing', 'weekly_briefing')),
  title text NOT NULL,
  facts jsonb NOT NULL,
  content jsonb,
  run_id uuid REFERENCES hq_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hq_audit_log (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('owner', 'employee', 'system')),
  actor_id text,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON hq_audit_log (created_at);
