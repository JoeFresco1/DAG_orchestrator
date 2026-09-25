# DAG Orchestrator Software Factory

## High-Level Capability Specifications

**Status:** Concept / High-Level Specification
**Version:** 0.1
**Purpose:** Evolve DAG Orchestrator from an agent execution engine with exhaustive review pipelines into an adaptive software-production control plane.

---

# 1. SYSTEM VISION

The software factory should accept structured requirements, generate and execute implementation work, evaluate the resulting system using deterministic and agentic evidence, identify and verify defects, determine root causes, construct remediation work, certify known-good states, and incrementally repeat this process as the system changes.

The central design principle is:

> Agents perform work and judgment.
> The orchestrator decides what work and judgment are worth performing.

The factory should optimize for:

* correctness
* traceability
* evidence
* risk reduction
* autonomy
* resumability
* minimal unnecessary reasoning
* controlled cost
* progressively reduced human intervention

The factory should not optimize for raw reviewer count, raw file coverage, or agent activity for its own sake.

---

# 2. EXISTING FOUNDATION

The current DAG Orchestrator remains the execution substrate.

Existing concepts to retain include:

* dependency-aware task execution
* isolated worktrees
* planning
* execution
* acceptance review
* integration
* retries
* repair
* resumability
* explicit task state
* reviewer verdicts
* chain reviews
* deterministic commands
* harness/model switching
* final review
* dependency invalidation

The new capabilities described below should extend this architecture rather than introduce a second orchestration framework.

---

# SPEC 01 — ADAPTIVE REVIEW ROUTER

## Objective

Replace fixed review pipelines with a decision engine that determines which review capabilities should execute for each unit of code.

## Problem

The current review process can apply local, dependency, subsystem, integration, specialist, and E2E reviews broadly across the repository.

This provides deep coverage but creates a large multiplicative cost.

Not every code unit requires every reviewer.

## Required Behavior

The Review Router SHALL evaluate each reviewable unit before scheduling agentic review.

The router SHALL determine:

* whether review is necessary
* which reviewer types are necessary
* what depth of review is appropriate
* what model class should be used
* whether multiple independent reviewers are justified
* whether deterministic evidence is sufficient
* whether the unit should be escalated
* whether no additional review is justified

## Example Decision

```text
Module: src/auth/token-service.ts

Risk: HIGH
Reasons:
- authentication boundary
- high fan-in
- changed public contract
- deterministic warning
- low test coverage

Route:
✓ deterministic validation
✓ dependency review
✓ security review
✓ integration review
✓ independent verifier
✗ generic architecture review
✗ generic local review
```

## Inputs

* repository graph
* changed files/symbols
* risk scores
* deterministic findings
* prior review history
* prior false positives
* subsystem classification
* test coverage
* current review budget

## Outputs

A machine-readable review plan.

Example:

```json
{
  "unit": "auth/token-service",
  "reviewers": [
    "dependency",
    "security",
    "integration"
  ],
  "verification_required": true,
  "independent_reviewers": 2,
  "priority": 92
}
```

## Success Criteria

* Review stages no longer run universally.
* Every scheduled reviewer has a recorded reason.
* Every skipped reviewer has a recorded reason.
* Review volume decreases without materially reducing verified defect discovery.
* Review routing is reproducible from stored evidence.

---

# SPEC 02 — RISK ENGINE

## Objective

Quantify where software risk is concentrated so that expensive reasoning is directed toward the most consequential areas.

## Risk Model

Risk SHALL be computed using deterministic and historical signals where possible.

Potential signals include:

* LOC
* cyclomatic complexity
* fan-in
* fan-out
* graph centrality
* number of dependents
* public API exposure
* authentication sensitivity
* authorization sensitivity
* persistence
* concurrency
* external integrations
* schema ownership
* deterministic failures
* low test coverage
* recent code churn
* generated code
* previous verified defects
* historic regression rate
* unresolved uncertainty

The initial conceptual model is:

```text
Risk =
    Impact
  × Probability of Defect
  × Uncertainty
```

Separate sub-scores MAY be retained instead of collapsing everything into one number.

## Output

```json
{
  "unit": "workflow-engine",
  "impact": 0.94,
  "defect_probability": 0.62,
  "uncertainty": 0.71,
  "risk_score": 0.73,
  "signals": {
    "fan_in": 34,
    "fan_out": 18,
    "persistence": true,
    "concurrency": true,
    "coverage": 0.58
  }
}
```

## Success Criteria

The system SHALL be capable of ranking reviewable units by risk without using an LLM.

---

# SPEC 03 — RISK-WEIGHTED COVERAGE

## Objective

Separate traditional review coverage from meaningful risk coverage.

## Required Metrics

### Audit Coverage

Track:

* files reviewed
* symbols reviewed
* dependency edges reviewed
* subsystems reviewed
* integration boundaries reviewed
* E2E paths reviewed
* specialist passes completed

### Risk Coverage

Track:

* percentage of weighted code risk inspected
* percentage of weighted dependency risk inspected
* percentage of high-impact execution paths inspected
* percentage of security-sensitive risk inspected
* residual unreviewed risk

## Example

```text
File coverage:             41%
Dependency edge coverage:  33%
Weighted risk coverage:    94%
Critical-flow coverage:   100%
```

The scheduler SHALL prioritize risk coverage.

Audit coverage SHALL remain available for transparency and reporting.

## Success Criteria

The factory must be capable of intentionally leaving low-risk code unreviewed while demonstrating that critical risk has been addressed.

---

# SPEC 04 — SOFTWARE KNOWLEDGE GRAPH

## Objective

Create a durable machine-readable model of the software system that supports planning, review, verification, impact analysis, and remediation.

## Graph Entities

At minimum:

* files
* symbols
* functions
* classes
* APIs
* schemas
* database models
* queues
* events
* tests
* configuration
* external services
* requirements
* tasks
* findings
* root causes

## Edge Types

Examples:

```text
imports
calls
inherits
implements
reads
writes
publishes
subscribes
serializes
deserializes
tests
implements_requirement
modified_by_task
depends_on
```

Edges SHALL be typed.

## Example

```text
SPEC-42
   ↓ implemented_by
CaseService.create()
   ↓ calls
CaseRepository.save()
   ↓ writes
cases
   ↓ consumed_by
WorkflowEngine.advance()
```

## Requirements

The graph SHALL be built predominantly through deterministic tooling.

LLMs MAY assist with ambiguous architectural classification but SHALL NOT recreate relationships that static tooling can derive.

## Success Criteria

The system must support graph queries such as:

```text
What depends on this schema?

Which requirements are implemented by this subsystem?

What execution paths cross this changed symbol?

Which findings involve descendants of this module?
```

---

# SPEC 05 — COHERENT REVIEW UNIT GENERATOR

## Objective

Replace unnecessary file-by-file and edge-by-edge reviews with graph-derived units containing enough context to reason correctly.

## Problem

Independent reviews of:

```text
A
B
A → B
B → C
C
```

repeatedly inspect overlapping code.

## Required Behavior

The system SHALL identify coherent dependency neighborhoods.

Example:

```text
        A
      ↙ ↓ ↘
     B  C  D
        ↓
        E
```

Review unit:

```json
{
  "nucleus": "C",
  "inbound": ["A"],
  "outbound": ["E"],
  "lateral": ["B", "D"],
  "tests": [],
  "contracts": []
}
```

Review units SHALL be constrained so they remain understandable within a practical context budget.

## Success Criteria

* Reduce redundant context consumption.
* Preserve cross-file reasoning quality.
* Avoid thousands of pairwise reviews around high-degree nodes.

---

# SPEC 06 — DETERMINISTIC CONTEXT COMPILER

## Objective

Generate minimal evidence packets for agents instead of allowing every agent to rediscover repository context.

## Required Behavior

Given a task such as:

```text
Review retry behavior in PaymentService
```

the context compiler SHALL deterministically assemble relevant information.

Potential packet contents:

* requested symbol
* implementation
* callers
* callees
* interfaces
* relevant schemas
* relevant tests
* relevant spec clauses
* deterministic diagnostics
* previous findings
* known invariants
* recent changes
* dependency graph snippet

## Example

```text
REVIEW REQUEST
       ↓
graph query
       ↓
context compiler
       ↓
minimal evidence packet
       ↓
reviewer
```

## Constraints

Agents SHOULD NOT routinely receive entire repositories.

Raw repository access MAY remain available for escalation when compiled context proves insufficient.

## Success Criteria

Context size should fall substantially while verified finding precision stays equal or improves.

---

# SPEC 07 — FINDING NORMALIZATION AND OBSERVATION CLUSTERING

## Objective

Prevent raw reviewer observations from creating one downstream workflow per finding.

## Pipeline

```text
raw observations
      ↓
exact deterministic normalization
      ↓
duplicate linking
      ↓
semantic + graph clustering
      ↓
candidate defect hypotheses
```

## Example

Raw findings:

```text
API sometimes returns missing owner.
Frontend crashes when owner missing.
DTO allows owner=null.
Service fails to populate owner.
Integration test never asserts owner.
```

Candidate hypothesis:

```text
Case.owner is not guaranteed across the Case contract.
```

## Requirements

Clusters SHALL consider:

* overlapping files
* symbols
* dependency relationships
* failure scenarios
* categories
* execution paths
* semantic similarity

Exact duplicates SHALL NOT be discarded.

They SHALL be linked as corroborating observations.

## Success Criteria

The number of verification tasks should be significantly smaller than the number of raw findings.

---

# SPEC 08 — DEFECT HYPOTHESIS ENGINE

## Objective

Elevate individual findings into testable defect hypotheses.

## Data Model

```json
{
  "id": "H17",
  "claim": "Case.owner is not guaranteed across the API contract.",
  "observations": [
    "F103",
    "F211",
    "F407",
    "F991"
  ],
  "affected_path": [
    "API",
    "DTO",
    "service",
    "frontend"
  ],
  "confidence": 0.68,
  "status": "unverified"
}
```

## Required Behavior

The system SHALL distinguish:

```text
observation
```

from:

```text
hypothesis
```

A hypothesis is a concrete claim that can be proven or disproven.

## Success Criteria

Verification SHALL primarily operate on defect hypotheses rather than isolated reviewer prose.

---

# SPEC 09 — CHEAP PRE-VERIFICATION

## Objective

Reject obviously invalid findings without spending an additional LLM request.

## Deterministic Questions

Before agent verification, the system SHOULD determine where possible:

* does the cited symbol exist?
* does the referenced line exist?
* is the path reachable?
* is the claimed caller real?
* is there a guard?
* does the type system contradict the claim?
* does a test already prove the proposed failure impossible?
* is the code dead?
* does static analysis corroborate the finding?
* does the claimed dependency exist?

## Pipeline

```text
hypothesis
   ↓
deterministic challenge
   ↓
 ┌───────────┐
invalid    plausible
  ↓            ↓
reject      verifier
```

## Success Criteria

Reduce verifier invocation count while preserving legitimate findings.

---

# SPEC 10 — ADVERSARIAL VERIFICATION ENGINE

## Objective

Verify plausible defect hypotheses by actively attempting to disprove them.

## Required Behavior

The verifier SHALL inspect:

* cited implementation
* callers
* dependencies
* tests
* guards
* runtime assumptions
* execution reachability
* contradictory evidence

The verifier SHALL NOT repair code.

## Output

```json
{
  "hypothesis_id": "H17",
  "verdict": "verified",
  "confidence": 0.94,
  "evidence_for": [],
  "evidence_against": [],
  "reachability": "confirmed"
}
```

## Success Criteria

A verified defect must contain enough evidence that another worker or human can reproduce the reasoning without repeating repository discovery.

---

# SPEC 11 — DISPUTE / ADJUDICATION OBJECTS

## Objective

Turn reviewer disagreement into a targeted reasoning task rather than launching another broad review.

## Example

Reviewer A:

```text
Retry path can write twice.
```

Reviewer B:

```text
requestIdGuard prevents the second write.
```

Create:

```json
{
  "claim": "timeout retries can produce duplicate writes",
  "evidence_for": [],
  "evidence_against": [],
  "open_question": "Does requestIdGuard execute on the timeout retry path?"
}
```

Only the unresolved proposition should be sent to the adjudicator.

## Success Criteria

Adjudication contexts should be significantly smaller than the original review contexts.

---

# SPEC 12 — ROOT-CAUSE GRAPH

## Objective

Identify shared causes among separate verified defects before remediation.

## Important Distinction

Observation clustering asks:

> Are these findings describing the same defect?

Root-cause clustering asks:

> Do these separate defects originate from the same underlying problem?

## Example

```text
D1 auth context lost
D8 tracing context lost
D23 transaction context lost
        ↓
RC4
No explicit execution-context propagation abstraction
```

## Root Cause Entity

```json
{
  "id": "RC4",
  "title": "Missing execution-context propagation abstraction",
  "defects": ["D1", "D8", "D23"],
  "affected_components": [],
  "severity": "high",
  "remediation_scope": []
}
```

## Success Criteria

The remediation DAG should operate on root causes wherever doing so is safer than independently fixing symptoms.

---

# SPEC 13 — FOUR INTERCONNECTED FACTORY GRAPHS

## Objective

Separate distinct graph concerns while maintaining explicit relationships among them.

## Graph A — Requirement Graph

Entities:

* goals
* specs
* requirements
* acceptance criteria

## Graph B — Code Graph

Entities:

* modules
* files
* symbols
* contracts
* data
* execution paths

## Graph C — Execution Graph

Entities:

* implementation tasks
* review tasks
* verification tasks
* remediation tasks

## Graph D — Defect Graph

Entities:

* observations
* hypotheses
* defects
* disputes
* root causes
* remediations

## Cross-Graph Relationships

```text
requirement
   ↓ implemented_by
symbol
   ↓ modified_by
task
   ↓ produced
observation
   ↓ supports
defect
   ↓ explained_by
root cause
   ↓ repaired_by
fix task
```

## Success Criteria

The system must support traceability from a requirement to its implementation, tests, review evidence, defects, fixes, and certification state.

---

# SPEC 14 — PROJECT INTELLIGENCE / STRUCTURED MEMORY

## Objective

Prevent future factory runs from repeatedly rediscovering stable architectural knowledge.

## Memory Contents

Per subsystem:

```json
{
  "component": "case_management",
  "entry_points": [],
  "critical_paths": [],
  "contracts": [],
  "known_invariants": [],
  "risk_profile": {},
  "historic_findings": [],
  "historic_root_causes": [],
  "false_positive_patterns": [],
  "reviewed_at_commit": "",
  "architecture_hash": ""
}
```

## Requirements

Memory SHALL be:

* machine-readable
* versioned
* associated with repository state
* invalidatable
* evidence-backed

Memory SHALL NOT simply be free-form agent summaries.

## Success Criteria

A future run should begin from:

```text
known architecture
+
changes since known state
```

rather than rediscovering the entire codebase.

---

# SPEC 15 — CERTIFIED BASELINE

## Objective

Make expensive repository-wide characterization primarily a one-time operation.

## Concept

After sufficient review and remediation:

```text
commit abc123
```

becomes:

```text
CERTIFIED_BASELINE abc123
```

Certification SHOULD record:

* deterministic test state
* reviewed critical paths
* known residual findings
* risk coverage
* architecture graph hash
* spec graph hash
* open accepted risks

## Example

```json
{
  "commit": "abc123",
  "deterministic_checks": "pass",
  "critical_flow_coverage": 1.0,
  "weighted_risk_coverage": 0.96,
  "critical_findings": 0,
  "high_findings": 0
}
```

## Success Criteria

Future review campaigns SHALL reason primarily over changes relative to the certified baseline.

---

# SPEC 16 — SEMANTIC IMPACT ANALYSIS

## Objective

Determine what previously certified assumptions become invalid when code changes.

## Problem

Simple file diffing or one-hop dependency traversal cannot accurately represent blast radius.

## Required Behavior

Changes SHALL propagate according to typed graph edges.

Examples:

### CSS Change

```text
component
```

Minimal propagation.

### DTO Change

```text
DTO
 ↓
serializers
 ↓
API consumers
 ↓
frontend clients
```

### Database Schema Change

```text
schema
 ↓
repositories
 ↓
services
 ↓
migrations
 ↓
integration flows
```

### Authentication Middleware Change

Potentially broad propagation across protected runtime paths.

## Output

```json
{
  "change": "CaseDTO.owner optional → required",
  "invalidated_units": [],
  "affected_requirements": [],
  "affected_tests": [],
  "required_reviews": []
}
```

## Success Criteria

Review scope SHALL be based on semantic impact rather than arbitrary graph distance alone.

---

# SPEC 17 — INCREMENTAL RE-CERTIFICATION

## Objective

Avoid repeating full repository reviews after every remediation or feature change.

## Pipeline

```text
certified baseline
       ↓
new changes
       ↓
semantic impact analysis
       ↓
invalidate affected certification claims
       ↓
targeted deterministic checks
       ↓
targeted agent review
       ↓
restore certification
```

## Success Criteria

Subsequent review passes should cost materially less than initial certification unless the architecture itself has changed broadly.

---

# SPEC 18 — DYNAMIC REVIEW INTENSITY

## Objective

Match inspection depth to risk.

## Conceptual Tiers

Initial thresholds MAY resemble:

```text
0–20
deterministic checks

20–40
cheap local review

40–60
local + contract review

60–75
subsystem review

75–90
specialist + integration review

90–100
independent reviewers
E2E path review
strong verifier
```

These thresholds SHALL eventually become empirically calibrated.

## Important Requirement

Review intensity SHALL be policy-driven and inspectable.

There should never be an unexplained transition from:

```text
risk score
```

to:

```text
expensive agent swarm
```

---

# SPEC 19 — REVIEWER PERFORMANCE CALIBRATION

## Objective

Measure which reviewers and models are actually useful.

## Metrics Per Reviewer / Model / Review Type

Track:

* findings proposed
* findings verified
* findings rejected
* duplicate rate
* human override rate
* unique findings discovered
* severity calibration
* average requests
* average tokens
* average cost
* average latency
* downstream defects prevented

## Example

```text
Muse Local Reviewer

proposed:       4,210
verified:       3,041
rejected:         721
duplicates:       448
precision:       .72
unique yield:    high
cost:            low
```

## Success Criteria

Reviewer selection SHALL increasingly depend on observed historical performance rather than assumptions about model capability.

---

# SPEC 20 — CALIBRATED CONFIDENCE

## Objective

Replace arbitrary model-generated confidence scores with empirically meaningful confidence.

## Example

If a reviewer has historically produced:

```text
1,000 "high confidence" findings
742 ultimately verified
```

then the system has evidence that the reviewer/model's nominal high-confidence category corresponds to approximately 74% historical precision in that context.

## Requirements

Calibration MAY vary by:

* model
* reviewer role
* language
* subsystem
* category
* severity
* repository

## Success Criteria

Confidence SHALL increasingly reflect historical evidence rather than self-reported model certainty.

---

# SPEC 21 — MODEL / HARNESS ROUTER

## Objective

Use the cheapest sufficiently capable tool for each reasoning problem.

## Escalation Pattern

```text
deterministic
      ↓
cheap model
      ↓ uncertain
medium model
      ↓ disputed/high risk
strong model
      ↓ unresolved
human
```

## Requirements

Escalation SHALL occur because of uncertainty or risk.

High-cost models SHOULD NOT routinely repeat work already resolved by cheaper stages.

## Success Criteria

Strong-model usage should become concentrated in high-value decisions.

---

# SPEC 22 — REVIEW BUDGET MANAGER

## Objective

Make review resources explicit and schedulable.

## Supported Budget Dimensions

```json
{
  "requests": 5000,
  "tokens": 50000000,
  "usd": 20,
  "strong_model_requests": 100,
  "wall_clock_minutes": 180
}
```

## Required Behavior

The scheduler SHALL understand remaining resources.

When constrained, the scheduler SHOULD allocate resources toward the highest expected reduction in residual risk.

## Core Question

```text
What is the most valuable next review action given the remaining budget?
```

## Success Criteria

Runs should not unexpectedly consume unbounded agent capacity.

---

# SPEC 23 — INFORMATION-GAIN SCHEDULER

## Objective

Schedule review work according to expected reduction in uncertainty rather than pipeline order.

## Concept

Each potential review action has:

```text
expected risk reduction
expected information gain
expected cost
```

The scheduler SHOULD prefer actions with high expected value.

Conceptually:

```text
priority =
expected_risk_reduction / expected_cost
```

The exact scoring model MAY evolve.

## Success Criteria

Low-yield repeated inspections should naturally disappear from later passes.

---

# SPEC 24 — CONFIDENCE FRONTIER

## Objective

Measure diminishing returns from additional review.

## Concept

The factory SHOULD be able to model:

```text
review effort
vs
residual software risk
```

Example:

```text
$0.50 → 60% uncertainty removed
$2.00 → 85%
$5.00 → 94%
$20   → 96%
$100  → 97%
```

Exact monetary values are illustrative.

## Success Criteria

The operator should be able to see whether additional review continues to produce meaningful risk reduction.

---

# SPEC 25 — FACTORY EXIT / CONVERGENCE POLICY

## Objective

Provide explicit stopping criteria.

## Example Exit Condition

A review campaign MAY complete when:

```text
open critical findings = 0

AND

no new verified high-severity findings
across N meaningful review units

AND

weighted residual risk < configured threshold

AND

critical E2E paths certified

AND

deterministic checks clean

AND

new verified finding yield falls below threshold
```

## Yield Metric

Example:

```text
verified novel defects / 1,000 requests
```

## Success Criteria

The system SHALL stop because measurable convergence occurred, not because an operator feels that enough review has happened.

---

# SPEC 26 — NEGATIVE EVIDENCE STORE

## Objective

Teach future reviewers what has already been proven not to be a defect.

## Example

```json
{
  "pattern": "repository.find() may return undefined",
  "status": "known-non-issue",
  "reason": "all callers pass through requireEntity()",
  "scope": "src/case/**",
  "verified_at_commit": "abc123"
}
```

## Requirements

Negative evidence SHALL be invalidated when relevant code or assumptions change.

## Benefits

This should reduce:

* repeated false positives
* unnecessary verification
* reviewer disagreement
* wasted context

---

# SPEC 27 — FACTORY TELEMETRY

## Objective

Measure the performance of the entire software-production system.

## Core Metrics

At minimum:

```text
Verified Novel Findings / 1,000 Requests

Root Causes Discovered / 1,000 Requests

Human Interventions / 1,000 Tasks

False Positive Rate

Duplicate Finding Rate

Strong-Model Escalation Rate

Review Cost / Verified Defect

Review Cost / Root Cause

Average Time to Certification

Regression Escape Rate

Remediation Success Rate
```

## Additional Metrics

Implementation:

* task success rate
* retries
* merge conflict rate
* repair rate
* agent fallback rate

Review:

* raw findings
* verified findings
* rejected findings
* hypothesis compression ratio
* root-cause compression ratio

Human involvement:

* human reviews requested
* human verdict reversals
* manual repair interventions

## Success Criteria

The factory must make it possible to determine whether a new policy actually improved autonomy, quality, or efficiency.

---

# SPEC 28 — CERTIFICATION OBJECT

## Objective

Produce an explicit state artifact representing what the factory currently believes to be trustworthy.

## Example

```text
CERTIFIED COMMIT
9f82d31

Deterministic checks: PASS
Critical-flow coverage: 100%
Weighted risk coverage: 96%

Open Critical: 0
Open High:     0
Open Medium:  11
Open Low:      42

Requirement graph:
abc123

Architecture graph:
def456

Test state:
ghi789
```

## Certification Properties

Certification SHALL be:

* tied to a commit
* tied to specification state
* tied to architecture state
* tied to deterministic evidence
* invalidatable
* reproducible

## Success Criteria

The factory must know the difference between:

```text
code exists
```

and:

```text
code is currently certified against known requirements and evidence
```

---

# SPEC 29 — CERTIFICATION INVALIDATION ENGINE

## Objective

Determine precisely which certification claims cease to be valid after a change.

## Example

A change to:

```text
CaseDTO
```

might invalidate:

```text
Case API contract certification
Case creation E2E certification
frontend Case consumer certification
relevant integration tests
```

while leaving unrelated authentication certification untouched.

## Success Criteria

Certification invalidation SHOULD be granular enough that future validation is incremental.

---

# SPEC 30 — REMEDIATION COMPILER

## Objective

Convert verified root causes and defects into a dependency-aware remediation DAG.

## Inputs

* verified defects
* root causes
* code graph
* requirement graph
* impacted execution paths
* regression risks

## Required Behavior

The compiler SHALL prefer:

```text
root cause fix
```

over:

```text
multiple symptom fixes
```

when evidence supports the shared cause.

## Output

```text
root architectural repair
        ↓
service update
        ↓
API contract update
        ↓
frontend adaptation
        ↓
integration tests
        ↓
re-certification
```

## Success Criteria

Every remediation node SHALL be traceable to the verified evidence that justified it.

---

# SPEC 31 — CLOSED-LOOP SOFTWARE FACTORY

## Objective

Combine all capabilities into a continuous production cycle.

## Target Architecture

```text
                   REQUIREMENT GRAPH
                          │
                          ↓
                    TASK COMPILER
                          │
                          ↓
                    EXECUTION DAG
                          │
                          ↓
                ISOLATED WORK CELLS
                          │
                          ↓
                DETERMINISTIC QUALITY
                          │
                          ↓
                 SOFTWARE KNOWLEDGE
                        GRAPH
                          │
                          ↓
                    RISK ENGINE
                          │
                          ↓
                  REVIEW ROUTER
                          │
          ┌───────────────┼───────────────┐
          ↓               ↓               ↓
    deterministic      cheap LLM      strong LLM
          │               │               │
          └───────────────┼───────────────┘
                          ↓
                    FINDING GRAPH
                          │
                          ↓
                  DEFECT HYPOTHESES
                          │
                          ↓
                     VERIFICATION
                          │
                          ↓
                    ROOT CAUSES
                          │
                          ↓
                REMEDIATION COMPILER
                          │
                          ↓
                      FIX DAG
                          │
                          ↓
                   RE-CERTIFICATION
                          │
                          ↓
                 CERTIFIED BASELINE
                          │
                          ↓
                  NEXT CHANGE SET
```

---

# 32. FACTORY CONTROL PLANE

The final architectural division should resemble:

```text
DAG ORCHESTRATOR
│
├── REQUIREMENT COMPILER
│   └── specs → implementation graph
│
├── EXECUTION ENGINE
│   ├── planning
│   ├── worktrees
│   ├── execution
│   ├── acceptance
│   ├── integration
│   ├── retries
│   └── recovery
│
├── KNOWLEDGE GRAPH
│   ├── requirements
│   ├── symbols
│   ├── dependencies
│   ├── contracts
│   ├── tests
│   └── execution paths
│
├── QUALITY CONTROLLER
│   ├── risk
│   ├── impact
│   ├── routing
│   ├── budget
│   └── context compilation
│
├── INSPECTION ENGINE
│   ├── local
│   ├── dependency
│   ├── subsystem
│   ├── integration
│   ├── specialist
│   └── E2E
│
├── DEFECT INTELLIGENCE
│   ├── observations
│   ├── deduplication
│   ├── hypotheses
│   ├── disputes
│   ├── verification
│   └── root causes
│
├── REMEDIATION COMPILER
│   └── verified problems → fix DAG
│
├── CERTIFICATION ENGINE
│   ├── certification
│   ├── invalidation
│   ├── residual risk
│   └── known-good baseline
│
└── FACTORY LEARNING
    ├── reviewer calibration
    ├── model calibration
    ├── negative evidence
    ├── human overrides
    ├── review ROI
    └── factory telemetry
```

---

# 33. RECOMMENDED IMPLEMENTATION SEQUENCE

These capabilities should NOT all be built simultaneously.

## Phase A — Stop the Waste

Implement first:

```text
Risk Engine
      ↓
Adaptive Review Router
      ↓
Coherent Review Units
      ↓
Context Compiler
```

Expected effect:

Reduce unnecessary reviewer calls immediately.

---

## Phase B — Compress Findings

Implement:

```text
Finding Normalization
      ↓
Observation Clustering
      ↓
Defect Hypotheses
      ↓
Cheap Pre-Verification
      ↓
Adversarial Verification
```

Expected effect:

Reduce the number of expensive verification tasks.

---

## Phase C — Fix Causes Instead of Symptoms

Implement:

```text
Root Cause Graph
      ↓
Remediation Compiler
```

Expected effect:

Reduce repeated fixes and improve architectural repair.

---

## Phase D — Stop Repeating Work Across Runs

Implement:

```text
Project Intelligence
      ↓
Certified Baseline
      ↓
Semantic Impact Analysis
      ↓
Incremental Re-Certification
```

Expected effect:

Make the first giant review expensive and later reviews dramatically cheaper.

---

## Phase E — Make the Factory Learn

Implement:

```text
Reviewer Calibration
Model Routing
Negative Evidence
Factory Telemetry
```

Expected effect:

The system begins improving its own resource-allocation policy based on outcomes.

---

## Phase F — Economic Control

Implement:

```text
Budget Manager
      ↓
Information-Gain Scheduler
      ↓
Confidence Frontier
      ↓
Convergence Policy
```

Expected effect:

The system chooses not merely what can be reviewed, but what is worth reviewing.

---

# 34. ULTIMATE SUCCESS CRITERIA

The software factory should eventually be capable of receiving:

```text
GOAL
```

and autonomously performing:

```text
goal
 ↓
specification
 ↓
requirements graph
 ↓
task decomposition
 ↓
dependency planning
 ↓
implementation
 ↓
integration
 ↓
deterministic validation
 ↓
risk analysis
 ↓
adaptive review
 ↓
finding normalization
 ↓
hypothesis generation
 ↓
verification
 ↓
root-cause analysis
 ↓
remediation planning
 ↓
fix execution
 ↓
regression testing
 ↓
re-certification
 ↓
certified baseline
```

with humans intervening principally for:

* genuinely ambiguous product decisions
* unresolved high-impact disputes
* explicit approval gates
* risk acceptance
* requirements that cannot be inferred from evidence

The ultimate measure of success is not how many agents the system can run.

It is:

> How much trustworthy software can the system autonomously produce per unit of human attention, compute, and model reasoning?

That should become the governing objective of the DAG Orchestrator software factory.
