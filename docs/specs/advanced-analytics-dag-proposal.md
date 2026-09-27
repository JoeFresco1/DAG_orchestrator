# Advanced Analytics DAG — proposal for review

**Status:** Revised discussion draft after three external reviews

**Date:** 2026-09-26
**Audience:** Architecture reviewers, statisticians, data scientists, and product designers

## 1. Purpose

Adapt DAG Orchestrator into a system whose analytics worker can take a user's question, carry out the analysis, and return a defensible answer. The worker is responsible for refining the question, planning, writing and running code or queries, checking results, and explaining the conclusion. A result should be traceable to the question asked, the exact data used, the method chosen, the checks performed, and the limits of the conclusion.

**Core rule:** the execution system determines what work occurred; the evidence system determines what that work supports. Successful execution, reproducibility, valid data, statistical evidence, reviewer approval, and a useful decision are different facts. The product must not collapse them into one green checkmark.

This proposal is deliberately broader than an implementation plan. It identifies the conceptual model and the decisions to test before committing to a product shape. The existing software factory remains a separate domain built on the same orchestration foundation.

## 2. The problem to solve

Analytical work is often managed as notebooks, scripts, conversations, and reports. These preserve pieces of the process but can lose the relationships between them: which question led to which analysis, whether a hypothesis was formed before looking at the outcome, which dataset version produced a chart, and whether a reported result survived an independent check.

A DAG is useful for ordered, parallel, retryable execution. It is insufficient as the entire analytical model because inquiry changes as evidence arrives. Exploration may produce a new question; a failed assumption check may require a different method; a finding may need confirmation on fresh data. The system must preserve both execution order and the evolution of the inquiry.

The first demo should prevent two failures that a notebook can easily hide: **an exploratory observation presented later as a pre-specified test** and **a denominator change between source and analysis without an explanation**. These are concrete claims of value. The prototype must show them being detected in an answer the worker actually produces, not merely store metadata that nobody uses.

The initial target user is someone who delegates an analytical question to a worker and expects the worker to do the work, using Python, R, or SQL as needed. The user may be an analyst, researcher, or domain expert; they should not have to author every plan or run every check themselves. The worker can generate follow-up questions during exploration, while recording where each came from. External publication and consequential decisions remain separately governed actions. Exploration must remain easy to start; a demanding intake form would push users away. The rigor increases when the worker advances from observations to directed claims.

## 3. Analytical modes

The product should represent the *kind of question* explicitly. Different modes require different evidence and should not share one generic success criterion.

| Mode | Example | Expected output | Essential checks |
| --- | --- | --- | --- |
| Exploratory | What patterns or anomalies appear? | Profiles, visualizations, candidate questions | Data quality, denominators, coverage, selection history |
| Descriptive | How does outcome Y vary by group? | Defined measures and estimates | Population, grouping, missingness, uncertainty where relevant |
| Inferential | Is a specified difference or association supported? | Estimate, interval, test result, assumptions | Sampling/design, effect size, multiple testing, pre-specification status |
| Predictive | Does X improve prediction of Y on new cases? | Fitted model and out-of-sample evaluation | Leakage, split integrity, baseline, calibration, subgroup performance |
| Causal | Would changing X change Y? | Effect estimate under an identification strategy | Confounding, design validity, sensitivity, alternative explanations |

These are modes of reasoning, not isolated pipelines. A project may move between them. In particular, an exploratory observation must not silently become a pre-specified confirmatory result. The system should record when a hypothesis was created, which outcomes its author or agent had already seen, and which data it was tested on. It should support a sealed holdout or new data for confirmation, without implying that either alone solves every validity problem. A plan written before *execution* is not necessarily pre-specified if its author already inspected the outcome.

“What is the deal with gender?” illustrates the need for question refinement. It could ask for a descriptive breakdown, an adjusted association, predictive performance across groups, or a causal account. The system should require an operational definition of the variables, population, outcome, and intended claim before running a directed analysis. It should preserve the analyst's original wording alongside the refined question.

## 4. Two related graphs

### Execution graph

The existing DAG answers: **what must run before what?** Nodes execute commands, use dependencies, retry, review, and record outcomes. A particular execution run remains acyclic.

### Inquiry graph

An analytics domain model answers: **why did this analysis exist and what does it support?** It distinguishes a machine-produced **Result**, an interpreted **Claim**, an assessment **Review**, and an organizational **Decision**. One result may inform several claims; one claim may depend on several results. A decision can rely on a claim while also considering cost, policy, and other facts. Relationships include *suggested by*, *tests*, *uses*, *produces*, *supports*, *challenges*, *reviewed by*, *based on*, and *supersedes*.

Inquiry can loop over time: a result raises another question. That loop should create a new versioned question and new execution tasks or a subsequent run, rather than mutating historical intent. Questions and plans are append-only after execution begins. A substantive plan change creates a new plan version labeled as post-observation when applicable. If tasks are added during a run, each execution records the execution-graph revision under which it was scheduled.

The two graphs should be linked by stable identifiers: an execution references its question and plan; an artifact references its producing execution; a result references artifacts; a claim references results; a review references the subject it assessed. Content hashes help verify artifacts but do not replace these relationships. Neither graph should be inferred solely from task titles or agent prose.

### Worked inquiry thread

1. **Q1:** “What relates to customer churn?” An exploratory profile of development data produces **R1**, an observed usage difference.
2. **Q2:** R1 suggests, “Does a 30-day usage drop predict 90-day churn in active subscribers?” The source of Q2 is recorded as exploratory.
3. **P1:** The worker defines the population, target, split, baseline, metric, and model-selection rule, then locks P1 before the designated evaluation outcomes are released through the workflow. A configured policy may require user review of the plan.
4. **E1 → R2:** Execution E1 trains on development data and produces R2. Deterministic checks pass; a reviewer approves the interpretation. A single planned evaluation on the designated evaluation partition produces **R3**.
5. **C1:** R2 and R3 support the bounded claim “Usage drop improves out-of-sample churn prediction over the stated baseline.” C1 says nothing causal.
6. A later independent cohort produces **R4**, which challenges C1. C1 remains in history with its original support and a new conflicting-evidence link. The worker opens **Q3**, asking whether the relationship varies by cohort; a new plan supersedes P1 for that inquiry. No old question, plan, result, or claim is overwritten.

This thread records both what was learned and when it was learned. In the local prototype R3 is labeled **workflow-withheld evaluation**, never independent confirmation: the worker could read a file available to its command environment even if the workflow did not offer it. If evaluation outcomes are observed before a later plan revision, that revision is explicitly post-observation; see Section 7.

## 5. Durable objects and independent states

The following is a candidate conceptual model, not a demand to implement every object in the first slice. The **first implementation kernel** is Question, versioned Plan, Execution, Result, and Claim, with `produces` and `supports/challenges` links. Dataset and artifact references support that thread. Transformations and checks are required evidence for the two failure cases in Section 2. Study, Decision, reusable Environment, and a richer Review object can follow once the thread has a working reader and an actual consumer. The conceptual distinctions remain even before each gets a separate stored record.

| Object | Minimum recorded fields |
| --- | --- |
| Study | Boundary joining related questions and several execution runs |
| Dataset version or partition | Source reference, immutable version or snapshot ID, schema and row count, partition role, access classification, acquisition time |
| Transformation | Input/output dataset IDs, code and parameters, execution ID, row counts and schema before/after |
| Question | Original wording, refined wording, population, variables, analytical mode, author, creation time, origin |
| Analysis plan | Version, hypothesis or estimand, method, inclusion/exclusion rules, metrics, assumptions, decision criteria, exposure history, lock time |
| Execution | Task and graph revision, command, code revision, environment reference, parameters, seed, input references, attempt history, resource use |
| Artifact | Type, location, content hash, schema or format, producing execution, dependency references |
| Check result | Rule and policy version, observed value or evidence, pass/fail/inconclusive status, checker |
| Result | Machine-produced estimate, metric, interval, test statistic, table/plot reference, or model evaluation; linked artifacts and checks |
| Claim | Human-readable assertion, claim type and scope, supporting and conflicting results, limitations |
| Review | Subject, reviewer identity and authority, rationale, decision, timestamp; may assess a result, plan, or claim |
| Decision | What was decided, deciding actor, supporting claims, timestamp, and an external ticket/policy/action reference |

The run file should not embed large datasets, models, or plots. It should store stable references and concise summaries; larger objects should live in a local or remote artifact store. A domain sidecar with its own schema version is a plausible first implementation, consistent with the software factory's storage boundary. Content hashes alone do not solve external source mutability; a query snapshot or source version must also be recorded. The Decision object records what the organization chose; it does not try to execute or model the downstream action.

Trustworthiness is a set of independent dimensions, not one `verified` status. At minimum, show **execution** (succeeded/failed), **validation** (passed/failed/inconclusive), **evidence** (supported/conflicting/inconclusive/unsupported), **reproducibility** (not attempted/reproduced/mismatch/unavailable), and **review** (unreviewed/approved/challenged/rejected). The system may derive a display badge, but it must preserve the underlying dimensions and the rules used. A perfectly reproducible analysis can be wrong; a correctly executed test can yield inconclusive evidence.

## 6. Task contracts, policies, and governance

An analytics task should declare typed inputs and expected outputs in addition to its command and prose spec. The contract should be machine-checkable where possible:

```yaml
title: Evaluate whether X predicts Y
mode: predictive
question_ref: q_churn_2
plan_ref: p_churn_1
inputs:
  dataset: customer_snapshot_2026_09_01
  partition: development
  target: churn_within_90_days
  features: [tenure, usage_30d, plan]
outputs:
  - kind: model
    name: candidate_model
  - kind: metrics
    name: held_out_evaluation
checks:
  - name: split_integrity
    command: python checks/split_integrity.py --manifest outputs/split.json
    verdict: exit-code
    evidence: outputs/split-check.json
  - name: baseline_comparison
    command: python checks/baseline.py --metrics outputs/metrics.json
    verdict: exit-code
    evidence: outputs/baseline-check.json
policy_ref: predictive_policy_v1
```

The example is illustrative: the contract schema, validator names, and source adapter are open design questions. A check name alone does nothing. Each check needs an executor or a reference to a registered check implementation, a verdict rule, and an evidence artifact. The first slice should map these to the runner's existing named reviewer/command mechanism, then add a structured payload (observed value, policy version, evidence reference) where the present pass/fail verdict is too thin. Analytical check failures must not automatically trigger a work retry. A separate check abstraction is justified only if the reviewer mechanism cannot express these semantics.

The worker authors these contracts from the user's question and dataset. Validation happens **at registration**, before a task can run, so malformed generated contracts fail early without making users fill out the form. The canonical contract should have a versioned machine-readable schema. Because the orchestration engine is TypeScript and analysis is often Python, a shared JSON Schema with a TypeScript validator and an optional Pydantic adapter is more portable than making a Python class the sole source of truth. Conformance tests should ensure both validators accept and reject the same examples.

An exploratory task should register with only a dataset reference, a purpose, and output locations; lightweight does not mean unrecorded. A directed task must reference a plan with the fields its mode needs. The first implementation supports that minimal exploratory contract and one predictive profile. The other modes in Section 3 describe the future analytical vocabulary, not a five-mode schema matrix to build now. Versioned **policy packs** can define required checks for each implemented mode and the rule for reporting missing or inconclusive evidence. A policy pack is not a claim that all statistical judgment can be automated.

A directed analysis should generally follow **define → lock plan → prepare → execute → validate → interpret → review → record claim**. Locking preserves the plan and exposure history; it does not certify the method. An exploratory task may instead produce candidate questions and a profiling artifact. A changed plan after results are observed creates a new version and cannot inherit the old plan's pre-observation label. Recording a claim here means making it available inside the study; external publication is separate.

Checks return structured results and evidence, not only exit codes or reviewer prose. Deterministic checks include schema validity, hashes, split overlap, and denominator consistency. Methodological reviews assess interpretation, confounding, practical importance, and competing explanations. A failed hard check blocks approval of the affected claim while preserving the result for inspection. “Inconclusive” is a legitimate evidence outcome; it is not automatically implied by a confidence interval crossing zero or by a single power threshold.

**Authority matters.** The worker should perform methodological checks and produce an evidence-backed assessment; it should not send routine analytical work back to the user by default. A review can be performed by a separate worker pass or reviewer agent, with its identity, scope, policy version, evidence, and rationale recorded. A policy can require a human gate for high-stakes claims, external publication, or a disputed judgment. Neither a worker nor a human can silently erase a failed hard check; resolving one requires corrected evidence or an explicit, auditable exception. The exact thresholds for human gates remain council decisions.

## 7. Provenance, reproducibility, and execution

The current runner's command execution, dependencies, retries, logs, gates, and reviewer stages are useful foundations. Its Git worktree mode isolates code edits, but Git does not version arbitrary datasets or databases. Analytics execution therefore needs an additional data and artifact boundary.

Record at least: source snapshot/version, code revision, dependency environment, command, parameters, seed, input hashes, output hashes, and execution time. A task should be considered reproducible only when its inputs can be retrieved and its environment can be reconstructed, not merely because a script was saved. The system should state when this standard is not met. Environment may begin as a lockfile or container digest referenced by an execution; a reusable versioned Environment object can follow if it materially improves reuse or audit.

**Transformation lineage is essential.** A filtered, joined, imputed, or feature-engineered table is a new dataset version, linked to the source versions and its producing execution. Record row counts, schema changes, and exclusion reasons. A reviewer must be able to explain why an analysis used 14,271 rows when the source had 14,608 without reconstructing a notebook by hand.

**Data exposure is part of provenance.** Record which analyst or agent was given access to each data partition or result, especially evaluation outcomes. A claim of independent evaluation needs more than disjoint row IDs: its plan and model-selection process must not have been informed by those outcomes. Exposure records cannot prove what a person already knew outside the tool. More concretely, a worker with command access to a filesystem containing the evaluation file can read it regardless of workflow rules; a log written by that worker is not an access-control guarantee. The first slice may use a **workflow-withheld evaluation partition**, and must label it as such. It must not call it sealed or claim enforced independence. A genuine sealed evaluation requires an access boundary outside the worker's authority, such as a separate credential or host and a runner-controlled evaluation step. That stronger design is a later, explicit milestone. Any observed evaluation results followed by a plan or model revision mark that lineage as post-observation.

The first slice needs a bounded worker budget: maximum wall time, agent requests or tokens where measurable, command attempts, and local compute concurrency. Exhaustion should stop new work and report the unfinished question and evidence, not silently continue or reinterpret failure as an answer. Record actual usage where available. CPU, memory, GPU, and monetary limits can become richer scheduler controls later. Remote compute is outside the first slice.

**Recovery and analytical iteration have different semantics.** A transient process or network failure may justify an infrastructure retry of the same immutable plan and inputs. A changed method, seed, population, split, or parameter after inspecting results is an analytical rerun and creates a new execution and provenance event. It must not appear as an ordinary retry or overwrite the earlier result. Data, methodological, validation, access, resource, and review failures need distinct dispositions; a scheduler must not retry its way out of an unfavorable analytical outcome.

Caching can reuse a result only when the effective code, environment, parameters, seed, plan version, policy version, and versioned inputs match, and when the task declares itself safe to cache. External queries, nondeterministic models, and time-dependent data need explicit policies. The first slice can disable caching while establishing these keys. Resource and cost usage should be recorded where available; scheduling limits can expand after the local prototype proves the domain model.

## 8. Statistical and methodological integrity

The product should make common analytical failure modes visible without pretending to automate scientific judgment:

- Track whether a hypothesis and its analysis plan were set before outcome inspection.
- Record the number and family of tests or comparisons when relevant; support an explicit multiple-comparison strategy.
- Report estimates and uncertainty alongside p-values, rather than turning a threshold into the whole finding.
- Distinguish association, prediction, and causation in both task type and claim type.
- Keep training, tuning, and evaluation partitions traceable; detect direct overlap and support leakage reviews.
- Record who or what accessed each partition and whether evaluation outcomes informed a later plan revision.
- Record population and missing-data choices so a result cannot quietly change its denominator.
- Allow sensitivity analyses and competing explanations to attach to the same claim.
- Preserve negative, null, and inconclusive results; do not optimize the workflow for finding significance.

These controls should be configurable by analytical mode. A descriptive count should not require a causal identification review; a causal claim should not pass merely because its code ran successfully.

## 9. Agent role and trust boundary

The existing CLI harnesses can remain the agent interface. The analytics worker should carry a task from question refinement through planning, code or query execution, output inspection, methodological review, and explanation. Numerical claims must be grounded in executed code or queries and versioned artifacts. The worker's narrative is an interpretation of measurements, not the measurement itself.

The analytics domain should impose its own contracts and checks around any harness. This provides portability across agent CLIs without requiring a new model runtime. It also makes agent-free tasks first-class: many data preparation and validation steps should be deterministic commands.

There are **two data trust boundaries**. Sensitivity controls govern what may be sent to an external model, what remains local, and what is logged. Separately, raw rows and free-text fields are untrusted content: they may contain instructions aimed at an agent with command authority. By default, an agent should receive schemas, deterministic profiles, aggregates, and bounded excerpts produced by a trusted data step. Row-level access must be an explicit task capability and must not turn data content into instructions. Redaction or summarization may be necessary, but must not silently change the analytical question. The prototype should use a non-sensitive dataset while the access model is designed.

## 10. Product boundary

Proposed shape: **one orchestration engine, separate software and analytics domains**. The existing `src/factory` centers on requirements, code, defects, Git diffs, and certification. An analytics domain would center on questions, data versions, methods, results, and claims. They can share task execution and run history while evolving separate domain schemas, validators, and views.

Avoid making analytics a collection of renamed software-factory concepts. A dataset is not a repository; a finding is not a commit; a statistical check is not a unit test. Equally, avoid forking the scheduler until a concrete requirement shows that the shared execution model cannot serve both domains.

### Tool integration

We are building the analytics worker and its inquiry model. It may use existing tools as components where that saves implementation effort. For example, [DVC](https://dvc.org/doc/command-reference/) can track data and pipeline outputs; [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking) records runs, parameters, metrics, and artifacts; [Great Expectations](https://docs.greatexpectations.io/docs/core/introduction/gx_overview/) validates data against expectation suites. None is a required dependency or a substitute for the worker. The first slice should use only components that make its end-to-end workflow simpler.

The distinguishing capability is a worker that conducts analysis while maintaining an **inquiry and claim model**: question origin, locked plans, data exposure, result-to-claim links, conflicting evidence, review authority, and decision provenance across runs. Tool integrations should support that workflow. The analytics domain should accept external dataset, check, and run identifiers through adapters while owning stable inquiry links.

### Integration lesson from the software factory

An implemented module is not an integrated capability. In the current factory code, `review-budget`, `risk-coverage`, and `telemetry` have controller consumers; `confidence`, `negative-evidence`, `information-gain`, `disputes`, and `existing-run-reviewer` appear to have no production imports. That makes the blanket claim that all of them are orphaned inaccurate, while the underlying lesson remains strong: each analytical mechanism needs a real caller, observable output, and an end-to-end check. Reuse the existing code only after checking whether its contracts fit analytical evidence. Factory-specific concepts such as repository commits and defect severity should not be lifted into a shared kernel unchanged. Finishing every factory integration is not a prerequisite for an analytics prototype.

The analytics domain should start under `src/analytics/` with a separately versioned sidecar under the run's sidecar directory. Keep the shared run schema and scheduler stable until a concrete requirement calls for changing them. Extract shared evidence or budget utilities only when both domains have working consumers. The viewer already has a basic factory summary; analytics needs a deeper, clickable evidence trace rather than another summary badge.

## 11. First vertical slice

Build one end-to-end worker workflow on a public or synthetic tabular dataset. The user supplies an initial question and dataset; the worker performs the analysis and returns an evidence-linked answer. Use an existing tool or simple immutable local files for dataset and artifact storage; choose an existing validation library if it reduces work. Focus custom implementation on the worker's analytical process, inquiry history, and their links to execution. Set a wall-time and request budget before the worker starts.

1. Register an immutable dataset reference; record a raw-to-analysis transformation with row counts and validation results.
2. Create development and workflow-withheld evaluation partitions. Run a lightweight exploratory profile on development data and preserve its outputs. Do not claim the evaluation partition is technically sealed in this local prototype.
3. Capture a candidate question prompted by exploration and label its origin.
4. Have the worker define and lock one predictive plan, including population, target, baseline, metric, split, method, checks, and exposure state. Validate its typed contract at registration.
5. Execute the plan using a deterministic command. Produce structured Results and Check Results linked to artifacts and execution IDs.
6. Evaluate once on the workflow-withheld data under the locked plan. Record who or what received the evaluation results and label the independence limit accurately.
7. Have the worker create a bounded Claim supported by Results and perform a separate review pass. Assemble a short report sentence from the reviewed claim and evidence links. Use a human gate only if the configured policy requires one.
8. Re-run from recorded inputs. Record reproducibility separately from execution and analytical validity.
9. In the viewer, let a reviewer open a reported number or claim and follow its links to the result, check, execution, transformation, and source dataset version. Show the plan's origin and revision history alongside that trace.

The demonstration should include a train/evaluation overlap and a post-observation plan change. The former must fail validation without erasing the result; the latter must create a new plan version and must not inherit the original pre-observation label. A changed denominator should remain visible through transformation lineage. A later conflicting Result should challenge the Claim without deleting its original evidence.

### Acceptance criteria for the slice

- A reviewer can trace each reported value from report sentence to Claim, Result, artifact, execution, transformation, and source dataset version.
- The trace is inspectable in the viewer; the reviewer does not need to read the raw sidecar to find the evidence.
- The exact dataset partitions, plan version, policy version, and exposure history remain visible after the run.
- Exploratory origin, post-observation revision, and the evaluation partition's actual access guarantee are represented accurately.
- Execution, validation, evidence, reproducibility, and review states are shown independently.
- A failed or inconclusive check prevents unsupported claim approval without deleting evidence.
- A clean rerun reproduces deterministic outputs or reports a specific mismatch; an analytical rerun retains prior results.
- The worker stops within its configured time and request limits and reports partial evidence when a limit is reached.
- Given the initial question and dataset, the worker completes the routine analytical steps without requiring the user to write the plan, code, checks, or report. Deterministic computation and checks remain executable without an LLM.

### Implementation order

1. Connect named checks to actual commands and structured evidence through the existing reviewer seam; ensure analytical failure does not trigger a blind work retry.
2. Run one worker thread within the runner's initial time and attempt limits. Record the five-object kernel, the source-to-analysis row-count change, and a post-observation plan revision. Make the worker's answer consume those records.
3. Add the clickable viewer trace and use it to inspect that same thread. A field with no producer or reader should not count as complete.
4. Add the workflow-withheld evaluation, conflict case, reproduction check, and request/token accounting where measurable. Expand the object model or extract shared factory code only in response to a concrete consumer.

## 12. Deferred scope

Defer distributed compute, a notebook editor, automatic causal identification, broad database connectors, collaborative permissions, a universal statistical test catalog, fully automated report generation, and autonomous publication. A truly sealed evaluation service needs a separate access boundary and is deferred; the prototype must be honest about its weaker workflow-withheld partition. Also defer building a native artifact store or a full database of inquiry events until the prototype demonstrates that simpler versioned sidecar storage is insufficient. These may be important later, but none is required to test the central proposition: whether a DAG plus explicit inquiry and evidence provenance makes analysis more trustworthy and easier to review.

## 13. Decisions for the review council

1. **Primary user and workflow:** Is the first target an individual analyst, an analytics team, or a research group? Which real question and dataset should anchor the prototype?
2. **Tool integration:** Which existing components simplify snapshots, run tracking, or validation without making the worker dependent on an unnecessary stack?
3. **Inquiry representation:** Which objects and relationships must exist in the first slice? Is a small append-only sidecar sufficient across multiple runs?
4. **Data versioning and exposure:** Is an immutable local snapshot enough initially? What guarantee can we honestly make about workflow-withheld evaluation data and prior human/agent exposure? When is a genuinely separate access boundary needed?
5. **Contract friction:** Which fields must be required by mode, and how can exploration stay genuinely lightweight?
6. **Evidence and authority:** What independent states are displayed? Which judgments can the worker review itself, and which require a separate reviewer or human gate?
7. **Review design:** Which checks are deterministic, which require methodological judgment, and where is an LLM useful only as an assistant?
8. **Execution boundary:** Can existing named reviewers host executable analytical checks and structured evidence without coupling the runner to one analytical framework?
9. **Trace and budget:** What minimum viewer interaction proves the lineage is usable, and what initial time/request limits bound the worker without stopping ordinary analysis prematurely?

Council feedback should challenge the assumptions and prioritize a concrete first workflow. The next deliverable should be a revised spec with object schemas, one executable example, and a small implementation plan.

## 14. Disposition of external review suggestions

The reviews materially improved this draft. The central changes adopted here are Result/Claim/Review/Decision separation, independent evidence states, transformation and exposure lineage, append-only plan history, analytical rerun semantics, mode-specific policies, registration-time contract validation, an agent-input trust boundary, and a worker prototype focused on inquiry and execution. Existing tools may serve as components; the worker remains responsible for the analysis.

A later repository-grounded critique sharpened the implementation order: connect checks to executors, prove one thread through the viewer, bound the worker, and avoid claiming a local evaluation file is sealed. Its proposed reuse of factory modules is an audit candidate, not a prerequisite; several of the modules it called orphaned already have production consumers, and others carry software-specific assumptions.

Several detailed prescriptions remain hypotheses rather than requirements:

- **A single finding state machine:** rejected because “inconclusive evidence,” “failed validation,” and “unreproduced result” are different dimensions. A compact display state may be derived later.
- **Automatic inconclusive/rejected transitions based only on a confidence interval, power threshold, or leakage flag:** rejected as a universal rule. These can invalidate a particular analysis or constrain a claim, but interpretation depends on the question and design.
- **`created_at` before execution as proof of pre-specification:** insufficient when an analyst or agent has already seen the outcome. The proposal tracks plan locking and exposure history, with explicit limits on what the system can know.
- **Mandatory Pydantic as the canonical schema:** deferred because the engine is TypeScript and execution may be Python, R, or SQL. Use a versioned portable schema and offer Pydantic validation for Python users.
- **Automatic copying of every dataset and a prescribed SQL snapshot command:** deferred because volume, permissions, and source capabilities vary. Start with immutable local inputs and adapter-defined external references.
- **A full inquiry database, extensive resource scheduler, and universal claim compiler in the first slice:** deferred until one workflow demonstrates a need. The first report can link manually authored sentences to structured claims.
