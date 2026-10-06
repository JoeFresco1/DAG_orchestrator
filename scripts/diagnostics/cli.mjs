import { diagnoseBeforeWork, rejectedWorkAttemptIds } from './core.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const packet = JSON.parse(input);
const rejectedAttempts = rejectedWorkAttemptIds(packet.events, packet.taskId);
const options = { ...packet, rejectedAttempts };
if (packet.dryRun) {
  console.log(JSON.stringify({ runId: packet.runId, taskId: packet.taskId, rejectedAttempts,
    eligible: rejectedAttempts.length >= packet.policy.diagnostics.afterRejections, scope: packet.unit,
    model: packet.policy.diagnostics.model, reasoning: packet.policy.diagnostics.reasoning, recordRoot: packet.recordRoot }));
} else {
  try { console.log(JSON.stringify(await diagnoseBeforeWork(options))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
