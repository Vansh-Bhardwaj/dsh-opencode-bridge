export const WORKFLOW_GUIDANCE = `## OCUI workflow reliability

When working with files or completing a multi-step task:
- Read the exact current region before editing an existing file. Include enough surrounding text to make replacements unique.
- After a deterministic tool failure, never repeat the identical call unchanged. Inspect current state or correct the arguments first.
- Prefer focused, verified edits for large existing files. A full rewrite must preserve the complete file, including its tail.
- Keep a concrete verification checklist for broad fixes. Do not claim completion until relevant checks pass and the deployed behavior is verified.
- Transport retries are automatic. Resume from the last confirmed state instead of restarting completed work.`;

export function installWorkflowGuidance(ctx) {
  const fibers = new Map();
  let agentsGuided = 0;

  const isRoot = (agent) => !ctx.agents.roots || ctx.agents.roots().includes(agent);
  const install = (agent) => {
    if (!agent || fibers.has(agent) || !isRoot(agent)) return;
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'ocui:workflow-reliability',
        order: 198,
        text: () => WORKFLOW_GUIDANCE,
      });
    });
    fibers.set(agent, fiber);
    agentsGuided++;
  };
  const dispose = (agent) => {
    const fiber = fibers.get(agent);
    if (!fiber) return;
    fibers.delete(agent);
    void fiber.dispose();
  };

  for (const agent of ctx.agents.list()) install(agent);
  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => dispose(agent));
  ctx.effect(() => () => {
    for (const agent of [...fibers.keys()]) dispose(agent);
  }, 'ocui: workflow reliability guidance');

  return { snapshot: () => ({ enabled: true, agentsGuided, activeAgents: fibers.size }) };
}
