import { emitTask, taskComment, type Ctx } from '../context';
import { authorisedRepo, createBranchForProposal, requireConnection } from '../github/service';
import { HttpError } from '../lib/http';
import { materializePlan, PlanOutput } from '../orchestrator/tasks';

interface ApprovalRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  task_id: string | null;
  title: string;
}

/** What happens when the owner approves or rejects each kind of request. */
export const executeApproval = {
  async approve(ctx: Ctx, a: ApprovalRow, ownerId: string): Promise<{ executed: boolean; [k: string]: unknown }> {
    switch (a.kind) {
      case 'plan': {
        if (!a.task_id) throw new HttpError(400, 'no_task');
        const plan = PlanOutput.parse(a.payload.plan);
        await materializePlan(ctx, a.task_id, plan, { type: 'owner', id: ownerId });
        return { executed: true, subtasks: plan.subtasks.length };
      }
      case 'code_change': {
        const res = await createBranchForProposal(ctx, String(a.payload.proposalId), ownerId);
        if (a.task_id) await taskComment(ctx, a.task_id, { type: 'system' }, `Owner approved the code change. Committed to branch ${res.branch} (${res.commit.slice(0, 7)}).`);
        return { executed: true, ...res };
      }
      case 'github_issue': {
        const repo = await authorisedRepo(ctx, String(a.payload.repo));
        const { gh } = await requireConnection(ctx);
        const issue = await gh.createIssue(repo.full_name, {
          title: String(a.payload.title),
          body: `${String(a.payload.body)}\n\n---\n_Drafted by an AI employee in Raflo AI HQ and approved by the owner._`,
          labels: (a.payload.labels as string[]) ?? []
        });
        if (a.task_id) await taskComment(ctx, a.task_id, { type: 'system' }, `GitHub issue #${issue.number} created: ${issue.html_url}`);
        return { executed: true, number: issue.number, url: issue.html_url };
      }
      case 'external_publish':
        // No publishing integration exists; the approved content is handed to the owner.
        if (a.task_id) await taskComment(ctx, a.task_id, { type: 'system' }, 'Owner approved the content for publishing. HQ has no publishing integration: the owner publishes it manually.');
        return { executed: false, note: 'Approved. No publishing integration is configured; publish the content manually.' };
      default:
        return { executed: false };
    }
  },
  async reject(ctx: Ctx, a: ApprovalRow, ownerId: string, note: string) {
    if (a.kind === 'plan' && a.task_id) {
      await ctx.db.query(`UPDATE hq_tasks SET status = 'rejected', queue = NULL, owner_question = NULL, updated_at = now() WHERE id = $1`, [a.task_id]);
      await taskComment(ctx, a.task_id, { type: 'owner', id: ownerId }, `Plan rejected${note ? `: ${note}` : '.'}`);
      await emitTask(ctx, a.task_id);
    }
    if (a.kind === 'code_change') await ctx.db.query(`UPDATE hq_change_proposals SET status = 'rejected', updated_at = now() WHERE id = $1`, [a.payload.proposalId]);
    if (a.task_id && a.kind !== 'plan') await taskComment(ctx, a.task_id, { type: 'owner', id: ownerId }, `Owner rejected “${a.title}”${note ? `: ${note}` : '.'}`);
  }
};
