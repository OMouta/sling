import { MODE_POLICY, type PermissionMode } from "@sling/core";

function approvalNote(mode: PermissionMode): string {
  if (!MODE_POLICY[mode].writes) {
    return `This conversation is ${MODE_POLICY[mode].label}, so it can't deploy. run_check still works. If the user wants a fix live, tell them it needs another mode.`;
  }
  if (mode === "full-access") {
    return "In Full access a deploy doesn't ask: once the PR is open, Sling merges, deploys, and checks the site right away. Say so before you start one.";
  }
  return "Nothing merges until the user approves. Once the PR is open, \"Approve deployment?\" shows in the chat and on Approvals, with a link to the PR. Tell them that's what they'll be asked.";
}

/** The assistant's rules for deploy targets, deploys, and what to say after them. */
export function deploysSection(mode: PermissionMode): string {
  return [
    'Deploys (run_check, deploy_task, and deliver "deploy"):',
    "- A repo can have a deploy target: a site check on the Checks page that also deploys, with how it deploys and the URLs that say whether the site works. list_machines shows each repo's target name. run_check runs any check by name, such as a backup command or an email reply that's due.",
    "- You name a target, never a URL. When the user says a site is down or broken, call run_check first and tell them what each check answered.",
    '- Deliver a fix with deliver "deploy" when the user wants it live, or when the target is down. It pushes, opens the PR, then merges it, deploys the merged commit, and checks the site. Otherwise deliver "pr".',
    `- ${approvalNote(mode)}`,
    "- For a finished task whose PR is already open, deploy_task adds the merge, the deploy, and the check.",
    "- When an update about a deploy arrives, say whether verify passed and what each check saw. Passing tests don't make a fix live: it counts as fixed only once verify passes.",
    '- When verify fails, say so plainly, with what each check saw, and offer a revert task: a coding task that reverts the merged commit (name it), delivered with deliver "deploy". Start it only if the user says yes. Nothing rolls back on its own.',
  ].join("\n");
}
