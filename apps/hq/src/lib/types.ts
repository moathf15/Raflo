export interface AvatarSpec {
  skin: string;
  hair: string;
  style: 'short' | 'long' | 'bun' | 'curly' | 'hijab' | 'bald' | 'shemagh';
  outfit: string;
}

export interface Employee {
  id: string;
  slug: string;
  name: string;
  title: string;
  title_ar: string;
  department_id: string;
  manager_id: string | null;
  avatar: AvatarSpec;
  personality: string;
  skills: string[];
  responsibilities: string[];
  tools: string[];
  instructions: string;
  role_memory: string;
  provider_id: string | null;
  model_override: string | null;
  active: boolean;
  status: string;
  status_detail: string | null;
  status_since: string;
  current_task_id: string | null;
  current_meeting_id: string | null;
  current_task_title?: string | null;
  current_meeting_title?: string | null;
  current_meeting_room?: string | null;
  sort: number;
  archived_at: string | null;
}

export interface Department {
  id: string;
  name_en: string;
  name_ar: string;
  color: string;
  sort: number;
}

export interface Task {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  kind: 'work' | 'plan' | 'synthesis';
  title: string;
  description: string;
  acceptance_criteria: string;
  status: string;
  queue: string | null;
  priority: string;
  assignee_id: string | null;
  reviewer_id: string | null;
  assignee_name: string | null;
  assignee_avatar: AvatarSpec | null;
  reviewer_name: string | null;
  project_name: string | null;
  deadline: string | null;
  attempts: number;
  revision: number;
  blocked_reason: string | null;
  owner_question: string | null;
  open_deps: number;
  depends_on: string[] | null;
  github_issue: { repo: string; number: number; url?: string } | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  repo: string | null;
  tasks?: number;
  completed?: number;
  blocked?: number;
}

/** Display status: an inactive employee is on break; "completed" shows for two minutes after the event. */
export function displayStatus(e: Pick<Employee, 'status' | 'status_since' | 'active'>): string {
  if (!e.active) return 'on_break';
  if (e.status === 'completed' && Date.now() - new Date(e.status_since).getTime() > 120_000) return 'idle';
  return e.status;
}
