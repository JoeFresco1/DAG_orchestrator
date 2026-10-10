// Coordinator-owned amendment. Product specifications and shared wire contracts
// remain authoritative; these are executable boundaries and handoff decisions.
const A = 'src/analytics/';
export const changes = {
  '003': {
    rationale: 'Establish callable runtime and lifecycle services before CLI binding; separate executor production from CLI integration fixtures.',
    additions: [
      ['runtime-contract', 'Implement the feature-local DelegatedRuntimeServicesV1 and DelegatedInquiryRequestV1 contracts plus validateDelegatedRuntimeServicesV1 in src/analytics/runtime.ts. Model trusted principal/source resolution, attributed worker invocation, pinned stage execution, committed reads/publication, viewer location, clock and cancellation as explicit typed services using the existing 001/008/009/012/013 and AnalyticsExtensionContextV1 types. Export a validation function that accepts a complete injected service set and rejects missing services or worker-supplied grants. Document the exact runtime service construction and next consumers in docs/build/003-runtime-handoff.md. No stub inquiry executor, canned answer, public command change, or new shared wire field. This boundary is independently testable with injected synthetic services; production construction belongs to runtime-composition.', [A+'runtime.ts', 'docs/build/003-runtime-handoff.md']],
      ['worker-invocation', 'Implement invokeInquiryWorkerV1 in src/analytics/worker.ts using the runtime service contract and existing worker-envelope validators. Execute the configured noninteractive worker through an injected argument-vector transport with a production adapter; send the exact attributed context/requested-output digest and validate plan/code/check/report envelopes. Preserve process failure versus valid negative proposal, timeout/cancellation and unavailable telemetry. Never calculate authoritative analytical values or grant access. Test a valid envelope, malformed/unbound output, transport failure, timeout and context tampering; use synthetic transports in automated tests, leaving the live model journey to final acceptance.', [A+'worker.ts', A+'runtime.ts']],
      ['lifecycle-dispatch', 'Implement dispatchAnalyticsCommandV1 and dispatchAnalyticsLifecycleV1 in src/analytics/extensions.ts, and controller context-service construction in src/analytics/controller.ts. Consume loadAnalyticsExtensionsV1 and its fixed registry; enforce schema/grant checks before command invocation, dependency-ordered hooks, stable event IDs, explicit optional absence and required-hook failure without completion. Bind publishRun/publishProject/recovery to the real 009 scope services. Exercise a real injected provider through these production dispatch entry points, not a helper-only simulation. Do not wait for optional future provider files or edit their fixed schemas.', [A+'extensions.ts', A+'controller.ts']],
      ['runtime-composition', 'Implement createDelegatedRuntimeV1 and runDelegatedInquiryV1 in src/analytics/runtime.ts after the worker, controller stages, budget, exposure and finalization boundaries pass. Construct actual services for the frozen registered synthetic/local source form: resolve principal/current grants through 001 before source reads; resolve source IDs against a trusted project fixture registry rather than arbitrary paths or worker-supplied authority; use existing fixture programs and authoritative 013 computation. Obtain attributed semantic interpretation and Plan proposals from the worker adapter, validate and lock through 008, run admitted stages, invoke registered extension hooks and durable finalization. Use feature-011 committed answer/trace lookup and record lookup location so inspection works after process restart. Missing configured identity, fixture or capability yields an explicit unavailable/denied result, never invented setup or a canned answer. Test the complete runtime with synthetic transport and real persistence; CLI token parsing remains T005.', [A+'runtime.ts', A+'controller.ts']],
    ],
    splits: {
      T006: [
        ['stage-admission', 'Implement admitInquiryStageV1 in src/analytics/controller.ts. Consume orientInquiryV1, worker envelope validation, the runtime service contract, feature-012 admitProposalV1 and the registered budget. Admit one proposal only after its predecessor settles; invoke feature-009 executeStageV1 for pinned computation/check commands with generic retries disabled. Carry Question/Plan and program/environment/source refs. Test valid stage invocation, changed pins, overlapping admission, denied proposal and execution failure retaining evidence. Downstream numeric comparison, lineage and report composition have separate owners.'],
        ['stage-lineage', 'Implement bindInquiryLineageV1 in src/analytics/controller.ts. Bind admitted stage sources/transformations through feature 007; record joins, exclusions, row/entity counts, cutoffs and denominator scope from actual committed execution outputs. Reject or mark unsupported the specific invalid lineage per 007 without deleting the execution. Test unchanged valid scope, multiplied entities and shifted denominators using the real stage/measurement boundary.'],
        ['prediction-checks', 'Implement evaluateInquiryPredictionV1 in src/analytics/controller.ts. Consume admitted pinned execution and lineage; call feature-013 computeAnalytics for authoritative Python baseline/candidate comparison and feature-010 checks for split overlap, feature availability, label maturity and training-only preparation. Bind each check to exact execution/code/policy refs; preserve null/negative results with no favorable-result retry. Test valid/null controls and each assigned required-check failure before claiming supported presentation.'],
        ['report-binding', 'Implement bindInquiryReportV1 in src/analytics/controller.ts. Consume the committed Result and required-check records; bind every report assertion to exact Result, denominator, unit and scope via existing report/Claim services. Reject swapped values and opaque worker-only numbers; preserve unsupported and negative outcomes. Test exact valid bindings and tampered value/unit/scope through the production report binding entry point.'],
      ],
      T007: [
        ['cli-comparison-integration', 'Implement production CLI/dispatcher meaningful-feature and null-feature integration fixtures in src/analytics/acceptance/003.test.ts after runtime composition and T005. Invoke the frozen question-and-fixture form without YAML/node selection. Verify estimate, interval, delta, one fixed scope, Question/Plan bindings and workflow-withheld; access isolation not enforced.'],
        ['cli-lineage-integration', 'Add production CLI/dispatcher fixtures for denominator multiplication/shift and customer/split overlap in src/analytics/acceptance/003.test.ts. Verify each required integrity failure retains committed evidence and blocks supported presentation with the exact denominator/lineage trace.'],
        ['cli-temporal-integration', 'Add production CLI/dispatcher fixtures for future features, immature labels and evaluation-fitted preparation in src/analytics/acceptance/003.test.ts. Inspect the retained failed-check trace and verify each affected claim is ineligible for supported presentation.'],
        ['cli-report-integration', 'Add the swapped-value production CLI fixture in src/analytics/acceptance/003.test.ts. Verify the reported number, Result, denominator, unit and scope are exact and an opaque/swapped worker value cannot become supported.'],
      ],
    },
    order: ['@runtime-contract','@worker-invocation',['T011','T012'],'@lifecycle-dispatch','stage-admission','stage-lineage','prediction-checks','report-binding',['T008'],['T009'],['T010'],'@runtime-composition',['T005'],'cli-comparison-integration','cli-lineage-integration','cli-temporal-integration','cli-report-integration',['T013'],['T014'],['T015'],['T016']],
  },
  '014': { rationale: 'Separate authorized source opening, bounded discovery, candidate packaging and actual recipe execution; retain final whole-feature verification.', order: [['T001'],['T002'],['T003'],['T004'],['T005','T007'],['T006','T008'],['T009']] },
  '015': { rationale: 'Build compatibility before production reuse; move cold/warm assertions with their provider instead of requiring a future provider to pass.', order: [['T002'],['T001','T003','T004'],['T005','T006'],['T007','T008'],['T009'],['T010','T011']] },
  '023': { rationale: 'Scaffold first, then put timeline assertions with the ledger projection they require; attach production hooks only after projection exists.', order: [['T001'],['T002','T003'],['T004'],['T005','T006','T007'],['T008']] },
  '021': {
    rationale: 'Separate three candidate trigger families while keeping attribution, deduplication and candidate-only persistence with each trigger.',
    splits: {
      T005: [
        ['repeat-trigger', 'Recognize repeated validated work across bounded completed inquiry/answer records in src/analytics/skill-capture.ts. Persist candidate-only decisions with exact scope, evidence and validation gaps through 009; use stable signal IDs to prevent duplicate proposals. Test valid repetition, insufficient/invalid repetition and replay.'],
        ['cost-trigger', 'Recognize costly source discovery only against predeclared thresholds and committed source-package evidence exposed through 015 in src/analytics/skill-capture.ts. Preserve intended grant/source scope and exact measured cost/count evidence; absent thresholds or telemetry cannot qualify. Test valid cost, missing threshold, missing evidence and replay without duplicate proposals.'],
        ['correction-trigger', 'Recognize durable corrections only with independent validation and later-reuse evidence in src/analytics/skill-capture.ts. Keep exact owner/conflict and prior-outcome exposure refs; suppress unresolved authority conflict and protected holdout signals; enforce checkpoint budgets and dedup/revision links. Test a validated correction, unvalidated correction, conflict, restricted exposure and exhaustion.'],
      ],
    },
    order: [['T001'],['T002','T003'],'repeat-trigger','cost-trigger','correction-trigger',['T004','T006'],['T007','T008']],
  },
  '016': {
    rationale: 'Build impact traversal before recurrence hooks consume it; keep look/exposure recording separate from graph traversal.',
    splits: { T006: [
      ['impact-traversal', 'Implement cycle-safe traversal of all nine canonical impact categories and append-only impact commits in src/analytics/invalidation.ts. Consume synthetic committed dependency records and 009; preserve historical nodes, exact reasons and revision refs. Test all categories, cycles, two corrections and commit replay/failure through this owned production entry point. Do not require recurrence hooks or the later 005 demo.'],
      ['recurrence-hooks', 'Extend src/analytics/recurrence.ts provider hooks to record inspection looks under the declared policy, route corrections through the accepted invalidation traversal, commit 009 refs and expose them to existing answer/trace finalization. Cover event/processing time, lateness/completeness, repeated looks, lifecycle dispatch and durable failure/replay. Consume only opaque answer-card/ledger refs rather than requiring future demos.'],
    ] },
    order: [['T001','T002','T003','T004'],'impact-traversal',['T005','@recurrence-hooks'],['T007']],
  },
  '006': {
    rationale: 'Separate method applicability, selection/exposure interpretation and causal wording; retain all ordered fault fixtures and browser acceptance.',
    splits: { T005: [
      ['method-applicability', 'Implement method applicability in python/analytics_worker/inferential.py and src/analytics/inferential.ts for customer-level reduction, dependence/cluster uncertainty, small groups, missing/changing categories, representativeness, name-derived labels and unsupported methods. Follow the frozen 006 fault precedence and 010 policy limits. Add valid controls and these fault cases through the existing Python/TypeScript dispatcher.'],
      ['selection-interpretation', 'Implement outcome-selected subgroup, comparison-family and repeated-look interpretation in src/analytics/inferential.ts and python/analytics_worker/inferential.py using committed feature-016 exposure/look evidence. Preserve association-only conclusions and scope/limitations; test no-selection controls plus selected subgroup, repeated look, missing evidence and unsupported causal claims without changing the numeric estimand.'],
    ] },
    order: [['T001','T002'],['T003'],'method-applicability','selection-interpretation',['T004'],['T006']],
  },
  '018': { rationale: 'Validate the pre-batch approval/comparison/audit contract before the production batch runner consumes it; scoring and release follow recorded batch evidence.', order: [['T004'],['T001'],['T002'],['T003'],['T009'],['T010'],['T011'],['T005'],['T006'],['T007'],['T008']] },
  '99': { rationale: 'Inventory early; require the complete evidence matrix only after local integration journeys and quickstart have produced their evidence.', order: [['T001'],['T003'],['T007'],['T008'],['T004'],['T005'],['T002'],['T006']] },
};

// Concrete additional runtime names for the critical 003 handoff. Frozen APIs
// elsewhere are consumed under their existing names, not renamed here.
export const exportsByLabel = {
 'runtime-contract': [[A+'runtime.ts','validateDelegatedRuntimeServicesV1']],
 'worker-invocation': [[A+'worker.ts','invokeInquiryWorkerV1']],
 'lifecycle-dispatch': [[A+'extensions.ts','dispatchAnalyticsCommandV1'],[A+'extensions.ts','dispatchAnalyticsLifecycleV1']],
 'stage-admission': [[A+'controller.ts','admitInquiryStageV1']],
 'stage-lineage': [[A+'controller.ts','bindInquiryLineageV1']],
 'prediction-checks': [[A+'controller.ts','evaluateInquiryPredictionV1']],
 'report-binding': [[A+'controller.ts','bindInquiryReportV1']],
 'runtime-composition': [[A+'runtime.ts','createDelegatedRuntimeV1'],[A+'runtime.ts','runDelegatedInquiryV1']],
};

export const retainedReasons = {
 '019': 'Retain bounded importer -> immutable history -> committed index -> curation -> access-first search -> production command/hook wiring -> output/retention/notebook boundaries. Imported ledger/card records use frozen projection types, never future provider imports.',
 '020': 'Retain card construction -> access-first ranking -> curation/home -> automatic recall -> full evaluation. Each test set stays with its production owner; 023 and 019 are completed prerequisites.',
 '022': 'Retain separate low-risk method eligibility, orientation, supplied/executed-use, source activation, owner review and stale/revoked transitions. Activation fixtures are synthetic candidates; the 004 demo is explicitly later.',
 '004': 'Retain first inquiry/discovery/activation -> second inquiry/reuse -> compatibility -> revocation -> trust/full verification. 003/014/015/022 are completed producers before this demo.',
 '017': 'Retain types/fixtures -> policy assessment state machine -> production decision/command integration -> verification. Types have validator checks; production transition tests stay with their implementation.',
 '005': 'Retain runtime driver -> window comparison/view -> consumed decision -> correction/reassessment -> uncertainty -> focused gate -> publication/policy staleness -> verification. All provider prerequisites exist; each unit proves one scenario transition.',
};
