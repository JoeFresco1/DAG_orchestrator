import type { Reviewer } from '../review-policy.js';
import { assignReviewIntensity, type ReviewIntensityDecision } from './review-intensity.js';

export const REVIEW_STAGES = [
  'deterministic', 'local', 'dependency', 'subsystem', 'integration', 'security', 'e2e', 'independent',
] as const;

export type ReviewStage = typeof REVIEW_STAGES[number];

export interface ReviewRouterEvidence {
  unit: string;
  title: string;
  spec?: string;
  changedFiles: string[];
  changedSymbols?: string[];
  diffLines: number | null;
  workExitCode: number | null;
  /** Optional stable output from the repository graph/risk engine. */
  repositoryGraphHash?: string;
  graphSignals?: { fanIn?: number; fanOut?: number; dependents?: number; publicApi?: boolean; securitySensitive?: boolean; integrationBoundary?: boolean };
  riskScore?: number;
  riskReasons?: string[];
  deterministicFindings?: string[];
  /** New evidence since the preceding review pass. Each item is auditable in the saved plan. */
  contradictions?: string[];
  changedContracts?: string[];
  verifiedDefects?: string[];
  testCoverage?: number;
  priorVerifiedDefects?: number;
  priorFalsePositives?: number;
  priorReviewHistory?: { reviews: number; failures: number; lastVerdict?: string };
  subsystem?: string;
  maxAgentReviewers?: number;
}

export interface ReviewStageDecision {
  stage: ReviewStage;
  selected: boolean;
  reason: string;
}

export interface ReviewerRoute {
  name: string;
  stage: ReviewStage;
  when: string;
  verdictMode: string;
  why: string;
  selected: boolean;
  reason: string;
}

export interface ReviewPlan {
  schemaVersion: 1;
  unit: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  riskScore: number;
  riskReasons: string[];
  intensity: ReviewIntensityDecision;
  depth: 'deterministic' | 'targeted' | 'deep' | 'escalated';
  modelClass: 'none' | 'cheap' | 'strong';
  reviewRequired: boolean;
  deterministicSufficient: boolean;
  verificationRequired: boolean;
  independentReviewers: number;
  priority: number;
  budget: { maxAgentReviewers: number; usedAgentReviewers: number };
  stages: ReviewStageDecision[];
  reviewers: ReviewerRoute[];
}

const SECURITY = /auth|permission|credential|token|secret|crypto|security/i;
const INTEGRATION = /api|contract|schema|database|migration|queue|event|integration/i;
const GENERATED = /(?:^|\/)(?:generated|dist|vendor)(?:\/|$)/i;
const clamp = (n: number, min = 0, max = 100): number => Math.max(min, Math.min(max, n));

/** Pure, stable routing over captured evidence and authored reviewer commands. */
export function createReviewPlan(evidence: ReviewRouterEvidence, configured: Reviewer[]): ReviewPlan {
  const paths = [...new Set(evidence.changedFiles.map((path) => path.replace(/\\/g, '/')))].sort();
  const text = `${evidence.title}\n${evidence.spec ?? ''}\n${paths.join('\n')}\n${(evidence.changedSymbols ?? []).join('\n')}\n${evidence.subsystem ?? ''}`;
  const reasons: string[] = [];
  let score = 20; // Unknown coverage/history starts with moderate uncertainty.
  if (SECURITY.test(text)) { score += 35; reasons.push('authentication or security-sensitive path'); }
  if (INTEGRATION.test(text)) { score += 18; reasons.push('contract or integration boundary'); }
  if (evidence.diffLines !== null && evidence.diffLines > 500) { score += 15; reasons.push(`large change (${evidence.diffLines} diff lines)`); }
  else if (evidence.diffLines !== null && evidence.diffLines > 150) { score += 8; reasons.push(`substantial change (${evidence.diffLines} diff lines)`); }
  if (evidence.workExitCode !== null && evidence.workExitCode !== 0) { score += 25; reasons.push('deterministic work command failure'); }
  if ((evidence.deterministicFindings?.length ?? 0) > 0) { reasons.push('deterministic findings are present'); }
  if (evidence.testCoverage !== undefined && evidence.testCoverage < 0.6) { score += 15; reasons.push('low test coverage'); }
  if ((evidence.priorVerifiedDefects ?? 0) > 0) { score += 15; reasons.push('prior verified defects in this unit'); }
  if ((evidence.priorFalsePositives ?? 0) >= 3) { score -= 10; reasons.push('history contains repeated false positives'); }
  if ((evidence.graphSignals?.fanIn ?? 0) >= 10 || (evidence.graphSignals?.dependents ?? 0) >= 12) { score += 12; reasons.push('repository graph shows high dependency impact'); }
  if (evidence.graphSignals?.publicApi) { score += 10; reasons.push('repository graph identifies a public API'); }
  if (evidence.graphSignals?.securitySensitive) { score += 20; reasons.push('repository graph identifies a security-sensitive unit'); }
  if (evidence.graphSignals?.integrationBoundary) { score += 12; reasons.push('repository graph identifies an integration boundary'); }
  if ((evidence.priorReviewHistory?.failures ?? 0) > 0) { score += 8; reasons.push('prior review history includes a rejection'); }
  if (paths.length > 8) { score += 8; reasons.push('change spans many files'); }
  if (paths.length > 0 && paths.every((path) => GENERATED.test(path))) { score -= 20; reasons.push('generated-only changes'); }
  if (evidence.riskScore !== undefined) {
    score = clamp(evidence.riskScore <= 1 ? evidence.riskScore * 100 : evidence.riskScore);
    reasons.length = 0;
    reasons.push(...(evidence.riskReasons ?? ['risk score supplied by the repository risk engine']));
  }
  score = clamp(score);
  const intensity = assignReviewIntensity({
    riskScore: score,
    triggers: {
      'deterministic-finding': evidence.deterministicFindings?.length ?? 0,
      contradiction: evidence.contradictions?.length ?? 0,
      'changed-contract': evidence.changedContracts?.length ?? 0,
      'verified-defect': evidence.verifiedDefects?.length ?? 0,
    },
  });
  score = intensity.score;

  const risk: ReviewPlan['risk'] = score >= 90 ? 'critical' : score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low';
  reasons.push(...intensity.reasons);
  if (!reasons.length) reasons.push('no elevated risk signals; history and coverage are not available');
  const deterministic = configured.filter((reviewer) => reviewer.verdict === 'exit-code');
  const agents = configured.filter((reviewer) => reviewer.verdict !== 'exit-code');
  const deterministicSufficient = evidence.workExitCode === 0 &&
    (evidence.deterministicFindings?.length ?? 0) === 0 &&
    deterministic.length > 0 &&
    risk === 'low' &&
    !agents.some((reviewer) => (reviewer.when ?? '').split(';').some((clause) => clause.trim().toLowerCase() === 'on-reject'));
  const budget = Math.max(0, Math.floor(evidence.maxAgentReviewers ?? (risk === 'critical' ? 3 : 2)));

  const stageFor = (reviewer: Reviewer): ReviewStage => {
    if (reviewer.verdict === 'exit-code') return 'deterministic';
    const name = `${reviewer.name} ${reviewer.why ?? ''}`.toLowerCase();
    if (/security|auth/.test(name)) return 'security';
    if (/integration|contract|api/.test(name)) return 'integration';
    if (/e2e|end.to.end|browser/.test(name)) return 'e2e';
    if (/dependency|impact|graph/.test(name)) return 'dependency';
    if (/subsystem|architecture/.test(name)) return 'subsystem';
    if (/independent|verifier|second/.test(name)) return 'independent';
    return 'local';
  };
  const classified = agents.map((reviewer) => ({ reviewer, stage: stageFor(reviewer) }));
  const selectedNames = new Set<string>();
  const budgetSkipped = new Set<string>();
  const stageReasons = new Map<ReviewStage, string>();
  const selectStage = (stage: ReviewStage, why: string): void => {
    const candidate = classified.find(({ stage: candidateStage, reviewer }) => candidateStage === stage && !selectedNames.has(reviewer.name));
    if (candidate) { selectedNames.add(candidate.reviewer.name); stageReasons.set(stage, why); }
  };

  const stageWhy: Partial<Record<ReviewStage, string>> = {
    local: `risk intensity ${score} requires focused local review (${intensity.tier} tier)`,
    dependency: `risk intensity ${score} requires dependency impact review (${intensity.tier} tier)`,
    integration: `risk intensity ${score} requires contract and integration review (${intensity.tier} tier)`,
    subsystem: `risk intensity ${score} requires subsystem review (${intensity.tier} tier)`,
    security: `risk intensity ${score} requires specialist review (${intensity.tier} tier)`,
    e2e: `risk intensity ${score} requires end-to-end path review (${intensity.tier} tier)`,
    independent: `risk intensity ${score} requires independent verification (${intensity.tier} tier)`,
  };
  for (const stage of intensity.requiredStages) {
    if (stage !== 'deterministic') selectStage(stage as ReviewStage, stageWhy[stage as ReviewStage] ?? `required by ${intensity.tier} policy tier`);
  }
  for (const { reviewer } of classified) {
    if ((reviewer.when ?? '').split(';').some((clause) => clause.trim().toLowerCase() === 'on-reject')) {
      selectedNames.add(reviewer.name);
      stageReasons.set(stageFor(reviewer), 'reserved for targeted triage if an earlier reviewer rejects');
    }
  }

  // A lone explicitly configured agent reviewer remains the task's acceptance
  // reviewer. With several broad reviewers, choose only the routed stages.
  if (agents.length === 1 && !deterministicSufficient && selectedNames.size === 0) {
    selectedNames.add(agents[0]!.name);
    stageReasons.set(stageFor(agents[0]!), 'the only authored agent reviewer remains the acceptance check');
  }

  let used = 0;
  for (const item of classified) {
    if (selectedNames.has(item.reviewer.name)) {
      if (deterministicSufficient) {
        selectedNames.delete(item.reviewer.name);
        continue;
      }
      if (used >= budget) {
        selectedNames.delete(item.reviewer.name);
        budgetSkipped.add(item.reviewer.name);
      }
      else used += 1;
    }
  }

  const reviewers: ReviewerRoute[] = configured.map((reviewer) => {
    if (reviewer.verdict === 'exit-code') return {
      name: reviewer.name, stage: 'deterministic', when: reviewer.when ?? 'always', verdictMode: reviewer.verdict, why: reviewer.why ?? '', selected: true,
      reason: 'deterministic command evidence is retained regardless of agent-review budget',
    };
    const stage = stageFor(reviewer);
    const selected = selectedNames.has(reviewer.name);
    const conditionalTriage = (reviewer.when ?? '').split(';').some((clause) => clause.trim().toLowerCase() === 'on-reject');
    const reason = selected
      ? conditionalTriage
        ? 'reserved for targeted triage if an earlier reviewer rejects'
        : (stageReasons.get(stage) ?? 'selected by the risk-based stage policy')
      : deterministicSufficient
        ? 'skipped because successful deterministic validation is sufficient for this low-risk unit'
        : budgetSkipped.has(reviewer.name)
          ? `skipped because the agent review budget (${budget}) is exhausted`
          : `skipped because this review stage is not justified by the risk signals (${risk})`;
    return { name: reviewer.name, stage, when: reviewer.when ?? 'always', verdictMode: reviewer.verdict ?? 'marker', why: reviewer.why ?? '', selected, reason };
  });
  const stages: ReviewStageDecision[] = REVIEW_STAGES.map((stage) => {
    if (stage === 'deterministic') return { stage, selected: deterministic.length > 0, reason: deterministic.length ? 'configured deterministic reviewer retained' : 'no deterministic reviewer configured' };
    const chosen = reviewers.find((reviewer) => reviewer.stage === stage && reviewer.selected);
    const skipped = reviewers.find((reviewer) => reviewer.stage === stage && !reviewer.selected);
    return chosen
      ? { stage, selected: true, reason: chosen.reason }
      : { stage, selected: false, reason: skipped?.reason ?? `no ${stage} reviewer is configured` };
  });
  const selectedAgentCount = reviewers.filter((reviewer) => reviewer.selected && reviewer.stage !== 'deterministic').length;
  const verificationRequired = ['subsystem', 'specialist', 'independent'].includes(intensity.tier) || selectedAgentCount > 1;
  const priority = clamp(Math.round(score * 0.8 + (verificationRequired ? 12 : 0)));
  return {
    schemaVersion: 1,
    unit: evidence.unit,
    risk,
    riskScore: score,
    riskReasons: reasons,
    intensity,
    depth: intensity.tier === 'independent' ? 'escalated' : ['specialist', 'subsystem'].includes(intensity.tier) ? 'deep' : ['contract', 'local'].includes(intensity.tier) ? 'targeted' : 'deterministic',
    modelClass: selectedAgentCount === 0 ? 'none' : ['specialist', 'independent'].includes(intensity.tier) ? 'strong' : 'cheap',
    reviewRequired: selectedAgentCount > 0 || deterministic.length > 0,
    deterministicSufficient,
    verificationRequired,
    independentReviewers: reviewers.filter((reviewer) => reviewer.selected && reviewer.stage === 'independent').length,
    priority,
    budget: { maxAgentReviewers: budget, usedAgentReviewers: selectedAgentCount },
    stages,
    reviewers,
  };
}
