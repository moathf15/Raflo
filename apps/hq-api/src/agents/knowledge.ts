import type { Db } from '../db/client';
import { getSetting } from '../lib/settings';

export interface KnowledgeHit {
  id: string;
  title: string;
  body: string;
  kind: string;
  scope: string;
  confidential: boolean;
}

/** Words of a query as an OR full-text query ("a | b | c"). Letters and digits only, in any script. */
export function toTsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 30);
  return words.length ? [...new Set(words)].join(' | ') : null;
}

/**
 * Knowledge an agent is allowed to see, ranked by relevance to `query`: company-wide entries, plus the entries of
 * its project, department and its own. Confidential entries are excluded unless the owner allowed sending them
 * to the AI provider.
 */
export async function searchKnowledge(db: Db, opts: { query: string; employeeId?: string | null; departmentId?: string | null; projectId?: string | null; limit?: number }): Promise<KnowledgeHit[]> {
  const tsq = toTsQuery(opts.query);
  if (!tsq) return [];
  const policy = await getSetting(db, 'policy');
  return db.query<KnowledgeHit>(
    `SELECT id, title, body, kind, scope, confidential FROM hq_knowledge
     WHERE tsv @@ to_tsquery('simple', $1)
       AND ($2::boolean OR NOT confidential)
       AND (scope = 'company'
            OR (scope = 'project' AND project_id = $3)
            OR (scope = 'department' AND department_id = $4)
            OR (scope = 'employee' AND employee_id = $5))
     ORDER BY ts_rank(tsv, to_tsquery('simple', $1)) DESC, updated_at DESC
     LIMIT $6`,
    [tsq, policy.confidentialToProvider, opts.projectId ?? null, opts.departmentId ?? null, opts.employeeId ?? null, opts.limit ?? 5]
  );
}

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} characters]` : s);
