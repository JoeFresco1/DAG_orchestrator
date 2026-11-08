import { compileFlowPlan } from './graph.js';
import type { FlowPlan } from './contracts.js';
import { findHarness } from '../harnesses.js';

export interface ReviewSpec {
  path: string;
  content: string;
}

export function budgetedPlan(input: FlowPlan, spec: string, limit: number, planning: number, reviewSpecs: ReviewSpec[] = []) {
  if (!Array.isArray(input.nodes) || !input.nodes.length || !input.settings?.finalChecks?.length || !input.settings.waveChecks?.length)
    throw Error('Plan must provide nodes, wave checks and final acceptance');
  const nodes = structuredClone(input.nodes);
  if (nodes.some(node => node.experience === 'review')) throw Error('Review nodes are scheduled from --review-spec files');
  const qa = nodes.filter(node => node.experience === 'qa');
  if (qa.length !== 1) throw Error('Plan needs one integrated QA task');
  const qaNode = qa[0];
  const implementationNodes = nodes.filter(node => node !== qaNode);
  const ui = nodes.filter(node => node.experience === 'implement');
  const designs = nodes.filter(node => node.experience === 'design');
  if ((ui.length || designs.length) && designs.length !== 1) throw Error('UI work needs one design owner');
  for (const node of ui) {
    node.depends_on = [...new Set([...node.depends_on, designs[0].id])];
    node.relies_on = [...new Set([...node.relies_on, ...designs[0].creates])];
  }
  for (const [index, review] of reviewSpecs.entries()) {
    const id = `quality_review_${index + 1}`;
    const report = `docs/build/reviews/${id}.md`;
    nodes.push({
      id,
      experience: 'review',
      goal: `Review the integrated product against ${review.path}. Record observations, evidence, failed checks and concrete repair requests in ${report}.`,
      depends_on: implementationNodes.map(node => node.id),
      touches: [report],
      creates: [report],
      relies_on: [],
      references: [review.path],
      verify: `node -e "if(!require('fs').readFileSync('${report}','utf8').trim())process.exit(1);console.log('Review report present')"`,
    });
    qaNode.relies_on.push(report);
    qaNode.goal += ` Resolve findings in ${report}, rerun its applicable checks and record the result.`;
  }
  qaNode.touches = [...new Set([...qaNode.touches,
    ...implementationNodes.flatMap(node => node.touches)])];
  qaNode.depends_on = nodes.filter(node => node !== qaNode).map(node => node.id);
  const report = 'docs/build/qa.md';
  qaNode.creates = [...new Set([...qaNode.creates, report])];
  qaNode.touches = [...new Set([...qaNode.touches, report])];
  qaNode.goal += ` Record the journeys exercised, observed results, unresolved issues, and preview instructions in ${report}.`;
  const reportCheck = `node -e "if(!require('fs').readFileSync('${report}','utf8').trim())process.exit(1);console.log('QA report present')"`;
  const checks = [...(input.settings.finalChecks ?? []), reportCheck];
  if (designs.length) {
    const screenshots = ['docs/build/desktop.png', 'docs/build/mobile.png'];
    qaNode.creates.push(...screenshots);
    qaNode.touches.push(...screenshots);
    qaNode.goal += ` Capture the integrated primary journey in the browser at desktop and mobile sizes. Save actual screenshots at ${screenshots.join(' and ')}.`;
    for (const image of screenshots) {
      checks.push(`node -e "const b=require('fs').readFileSync('${image}');if(b.length<33||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')process.exit(1);console.log('QA screenshot present')"`);
    }
  }
  const qaCents = Math.max(1, Math.floor((limit - planning) / 6));
  const dispatchCents = Math.floor((limit - planning - qaCents) / (nodes.length + 1));
  if (dispatchCents < 1) throw Error('Remaining allowance cannot cover this plan');
  const cmd = findHarness('claude')!.cmd;
  const settings = input.settings;
  const { run } = compileFlowPlan({
    version: input.version,
    title: input.title,
    cmd,
    nodes: nodes.map(node => ({ ...node, cmd })),
    settings: {
      waveChecks: settings.waveChecks,
      finalChecks: checks,
      requiredEvidence: settings.requiredEvidence,
      checkPrerequisites: settings.checkPrerequisites,
      productSpec: spec,
      repairCommand: cmd,
      conflictCommand: cmd,
      spend: { limitCents: limit, dispatchCents, qaCents },
    },
  });
  run.flowState = { version: 3, checkpoints: [], issues: [], repairRound: 0, reservedCents: planning };
  return run;
}
