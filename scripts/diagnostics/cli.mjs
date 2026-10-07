import { diagnoseBeforeWork, rejectedWorkAttemptIds } from './core.mjs';
import { recoveryTrigger } from './recovery.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input);
const rejectedAttempts = rejectedWorkAttemptIds(packet.events, packet.taskId);
const trigger = packet.failure ? recoveryTrigger(packet.failure, packet.events, packet.taskId, packet.policy.diagnostics.afterRejections) : null;
const options = { ...packet, rejectedAttempts, ...(trigger ? {terminalFailure:trigger.terminalFailure}: {}) };
if (packet.dryRun) {
  console.log(JSON.stringify({ runId: packet.runId, taskId: packet.taskId, rejectedAttempts,
    eligible: Boolean(trigger) || rejectedAttempts.length >= packet.policy.diagnostics.afterRejections, trigger: trigger?.reason ?? null, scope: packet.unit,
    model: packet.policy.diagnostics.model, reasoning: packet.policy.diagnostics.reasoning, recordRoot: packet.recordRoot }));
} else {
  try { console.log(JSON.stringify(await diagnoseBeforeWork(options))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
