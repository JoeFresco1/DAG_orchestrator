# Feature Specification: Adapter Conformance and Honest Capability Reporting

**Feature Branch**: `011-adapter-conformance`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P2-11: a small optional adapter protocol plus a conformance suite covering model selection, output parsing, cancellation, liveness, exit semantics, and usage reporting, with each adapter reporting supported/unavailable/unverified capabilities, requested settings recorded in attempts, clear failures for unsupported settings, and the plain-command worker left fully supported."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Know what an adapter actually guarantees before relying on it (Priority: P1)

A maintainer selecting a harness for a task asks what it really supports. Each adapter publishes a capability report covering the six protocol dimensions — model selection, output parsing, cancellation, liveness, exit semantics, usage reporting — and marks each one supported, unavailable, or unverified. The plain-command worker keeps working exactly as before without implementing any of the protocol, so adopting the report is never a prerequisite for running a task.

**Why this priority**: Honest capability reporting is the whole point of the feature; without it, every later guarantee (settings recorded, cancellation honored) is an unverifiable claim. This is the MVP slice.

**Independent Test**: List the registered adapters, confirm every one shows a state for all six dimensions, and run a plain `--cmd` task end to end with no adapter configuration while the report exists.

**Acceptance Scenarios**:

1. **Given** the set of registered adapters, **When** a maintainer requests the capability report, **Then** each adapter shows exactly one state — supported, unavailable, or unverified — for each of the six dimensions, with no dimension left blank.
2. **Given** an adapter that has never passed the conformance suite, **When** the report is generated, **Then** its capabilities read unverified rather than supported.
3. **Given** a plain-command task with no adapter settings, **When** the run executes, **Then** it behaves exactly as before this feature, with no protocol requirement imposed on it.

---

### User Story 2 - Run the conformance suite against adapters with local fixtures (Priority: P2)

A maintainer runs the conformance suite, which exercises each protocol dimension against an adapter using local fixtures — a fake worker script that stalls, exits non-zero, streams output, reports usage, or ignores a cancel request — and records a pass, fail, or not-exercised result per dimension. The recorded results are what license an adapter to claim "supported".

**Why this priority**: The suite turns Story 1's three-state report from editorial judgment into evidence; it depends on the protocol and report shape from Story 1 existing first.

**Independent Test**: Run the suite against one adapter and a deliberately misbehaving fixture, then confirm the results distinguish passing, failing, and unexercised dimensions and that the report's "supported" claims match the recorded passes.

**Acceptance Scenarios**:

1. **Given** an adapter implementing the optional protocol, **When** the conformance suite runs, **Then** every dimension is exercised with a local fixture and the result — pass, fail, or not-exercised — is recorded alongside the adapter identity.
2. **Given** an adapter that fails the cancellation fixture, **When** the report is regenerated, **Then** cancellation reads failed or unverified, never supported.
3. **Given** an adapter that does not claim usage reporting, **When** the suite runs, **Then** that dimension records not-exercised and the report reads unavailable, not a fabricated pass.

---

### User Story 3 - Trust the attempt record and fail loudly on unsupported settings (Priority: P3)

A maintainer runs a task through an adapter with an explicit model and settings, then inspects the attempt record and sees exactly what was requested and what the adapter accepted. When the request names a setting the adapter does not support, the attempt fails before any worker launches, with an error naming the setting and the adapter, instead of silently dropping the request. When usage is reported, it lands in the attempt record; when it is not, the record says unavailable.

**Why this priority**: This is the payoff of Stories 1-2 — records and failures are only trustworthy once capabilities are honestly reported and conformance-backed.

**Independent Test**: Submit an unsupported setting and confirm the failure occurs pre-launch with both names in the error; submit a supported one and confirm the attempt record carries the requested model and settings verbatim.

**Acceptance Scenarios**:

1. **Given** an adapter-run attempt requested with a specific model and settings, **When** the attempt record is inspected, **Then** the requested model and settings appear in the record, or an explicit "not requested" marker appears when none were given.
2. **Given** a request naming a setting the adapter reports as unavailable, **When** the attempt is prepared, **Then** it fails before worker launch with an error naming both the setting and the adapter.
3. **Given** an adapter that reports usage, **When** the attempt completes, **Then** the usage figures are recorded on the attempt; when it does not, **Then** the attempt marks usage unavailable.

---

### Edge Cases

- What happens when an adapter claims a capability the suite has not exercised? It is reported as unverified; "supported" is reserved for dimensions with a recorded passing result.
- What happens when a fixture itself is broken (for example, a stall fixture that exits immediately)? The suite reports the run as invalid rather than recording a pass, and no capability is upgraded on an invalid run.
- What happens when the plain-command worker is used with adapter-only settings such as a requested model? The behavior is unchanged from today: the command is arbitrary shell, and the record notes the setting as not applicable to the plain worker.
- What happens when two adapters in a fallback chain support different subsets of a request? Each attempt is judged against its own adapter's capability report, and the failure of one attempt names that adapter before the chain moves to the next candidate.
- What happens when an adapter's behavior changes after a suite run (new version)? Recorded conformance results are tied to the adapter identity and version; a changed identity reads unverified until re-run.
- What happens when usage reporting exists but returns a malformed figure? The attempt records the raw value as unusable and marks the computed usage unavailable rather than guessing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST define a small optional adapter protocol covering six dimensions: model selection, output parsing, cancellation, liveness, exit semantics, and usage reporting; an adapter MAY implement any subset.
- **FR-002**: Each adapter MUST publish a capability report stating exactly one state per dimension — supported, unavailable, or unverified — with no dimension omitted.
- **FR-003**: A dimension MAY be reported supported only when a recorded conformance result shows it passing; dimensions that are offered but not exercised MUST read unverified, and dimensions not offered MUST read unavailable.
- **FR-004**: The system MUST provide a conformance suite that exercises each protocol dimension against local fixtures and records pass, fail, or not-exercised per dimension, tied to adapter identity and version.
- **FR-005**: For any attempt run through an adapter, the attempt record MUST contain the requested model and settings, or an explicit "not requested" marker when none were supplied.
- **FR-006**: Requesting a setting an adapter reports as unavailable MUST fail before worker launch with an error naming the setting and the adapter; the setting MUST NOT be silently ignored.
- **FR-007**: The plain-command worker MUST remain fully supported without implementing the protocol; existing arbitrary-command behavior, records, and exit semantics MUST be unchanged.
- **FR-008**: Cancellation, liveness (stall detection), and exit semantics MUST be defined behaviorally by the protocol — cancel terminates the worker and records the attempt as killed, silence triggers the existing stall path, and non-zero exits are recorded as failures — with the conformance suite verifying each against a fixture.
- **FR-009**: Usage figures reported by an adapter MUST be recorded on the attempt; where an adapter does not report usage, the attempt MUST mark it unavailable.
- **FR-010**: The protocol, fixtures, and conformance results MUST be local to the project (files and commands); no hosted service, account, or remote registry may be required.

### Key Entities

- **Adapter**: An optional harness integration implementing any subset of the six protocol dimensions, identified by name and version, used for some or all attempts.
- **Capability Report**: Per-adapter state for each of the six dimensions — supported, unavailable, or unverified — derivable from the latest conformance results.
- **Conformance Result**: The recorded outcome of running the suite against one adapter version — per-dimension pass, fail, or not-exercised, plus invalid-run markers for broken fixtures.
- **Attempt Record**: The existing per-attempt record, extended to carry requested model and settings, the adapter used, and usage figures or an explicit unavailable marker.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of registered adapters expose a capability report covering all six dimensions with exactly one state each; zero dimensions are blank or defaulted silently.
- **SC-002**: Zero capabilities are reported as supported without a passing conformance result recorded for that adapter identity and version.
- **SC-003**: 100% of unsupported-setting requests fail before worker launch with an error naming the setting and the adapter; zero are silently ignored or deferred to run time.
- **SC-004**: 100% of adapter-run attempt records contain the requested model and settings or an explicit "not requested" marker, and usage is either recorded or explicitly marked unavailable.
- **SC-005**: A plain-command task runs end to end with no adapter configuration and passes the existing pre-feature test suite unchanged, demonstrating the protocol adds zero mandatory surface.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): new capability. Harness presets, fallback chains, and model listing already exist, but no adapter protocol, capability report, or conformance suite was found in the inspected code; the smallest missing piece is the protocol definition plus the fixture suite on top of the existing harness registry.
- Lightweight boundary (from the roadmap): small adapters and local fixtures; explicitly no large provider abstraction framework, no hosted conformance service, and no required cloud or account.
- Competitor inspiration: none cited in the roadmap; the opportunity statement's premise that richer harness guarantees vary across tools is treated as an unverified hypothesis until the suite measures it here.
- Conformance fixtures are local fake worker scripts (stall, non-zero exit, streaming, usage, cancel-ignoring); no fixture may call a paid model API, keeping the suite runnable offline.
- The plain-command worker is the permanent baseline: adopting the protocol is opt-in per adapter and never a precondition for running tasks (constitution: arbitrary command workers are a proven contract).
- "Supported" licensing is versioned: a conformance pass applies to the adapter identity and version that passed, and any identity change reverts claims to unverified.
