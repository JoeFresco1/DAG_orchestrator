# Feature Specification: Local Run Comparison and Retention Controls

**Feature Branch**: `012-run-comparison-retention`

**Created**: 2026-10-13

**Status**: Draft

**Input**: User description: "Roadmap P2-12: compare runs and worker profiles locally, export an evidence bundle, and preview pruning by age, size, and evidence reachability — reports distinguish review effort, implementation effort, integration repair, and unavailable cost; pruning cannot delete evidence needed by an active run or a retained acceptance receipt without an explicit override; state stays inspectable and portable after the project folder moves."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Compare two runs and see where the effort went (Priority: P1)

A maintainer picks two runs from the project's history and runs a single comparison command. The report separates review effort (review rounds, verdicts, review time), implementation effort (attempts, retries, implementation time), integration repair (requeue-after-review rounds, repair attempts, merge redos), and cost, which is reported per run or explicitly marked unavailable when no harness exposed usage. The report also shows the worker profile of each run — harness chain, models, concurrency, retry/timeout/silence settings — so differences in configuration are visible next to differences in outcomes.

**Why this priority**: Persistence that cannot be compared is write-only; this is the MVP that makes existing local state answerable questions without any deletion risk.

**Independent Test**: Compare two archived runs with different configurations and confirm the four categories are reported separately, cost reads unavailable for a run that reported none, and each run's worker profile is listed.

**Acceptance Scenarios**:

1. **Given** two runs in the project, **When** the maintainer runs the comparison command, **Then** a report is produced separating review effort, implementation effort, and integration repair as distinct categories for each run.
2. **Given** a run whose harness never reported cost or usage, **When** the comparison renders, **Then** cost reads unavailable for that run rather than zero or a guess.
3. **Given** two runs launched with different harness chains and concurrency, **When** the report is read, **Then** each run's worker profile — harness chain, models, concurrency, retry/timeout/silence settings — is shown alongside its outcomes.
4. **Given** a metric that exists for one run only, **When** the report is rendered, **Then** the other run's cell is explicitly marked unavailable instead of being dropped from the comparison.

---

### User Story 2 - Preview pruning and know what would be lost (Priority: P2)

A maintainer whose project folder is growing runs a prune preview: a dry run that lists candidate artifacts by age, size, and evidence reachability, deleting nothing. Items required by an active run, or referenced by a retained acceptance receipt, are flagged as protected. The maintainer then runs the actual prune; protected items are refused with the protecting run or receipt named, and only an explicit override flag allows them to be deleted.

**Why this priority**: Retention is where existing state becomes opaque or lossy; it depends on Story 1's understanding of what evidence matters, and it must never run ahead of its protections.

**Independent Test**: Run the preview against a folder containing old logs, an active run's evidence, and a retained receipt; confirm zero deletions occur in preview mode and every protected item is flagged.

**Acceptance Scenarios**:

1. **Given** a project folder with artifacts of varying age and size, **When** the maintainer runs the prune preview, **Then** candidates are listed with age, size, and whether each is reachable as evidence, and nothing is deleted.
2. **Given** evidence required by an active run, **When** the preview runs, **Then** it is flagged protected; **When** a prune is then attempted without an override, **Then** the deletion is refused and the protecting run is named.
3. **Given** a retained acceptance receipt, **When** a prune would remove the evidence it references, **Then** the prune is refused and the receipt is named unless the explicit override flag is passed.
4. **Given** only unprotected, unreachable, over-age artifacts, **When** the prune runs, **Then** they are removed and the remaining state still passes the project's existing state inspection.

---

### User Story 3 - Export a portable evidence bundle (Priority: P3)

A maintainer exports a bundle for one run — an index plus the run's manifest, task records, attempts, verdicts, receipts, and event excerpts as local files — and shares or archives it. Separately, the maintainer confirms that after moving the project folder to a new path, comparison, prune preview, and bundle inspection all still work with no manual path fixes.

**Why this priority**: Export and portability harden the record produced by Stories 1-2; they are valuable for audits but not required for the day-to-day comparison and retention loop.

**Independent Test**: Export a bundle for a completed run, inspect it from a copy outside the project, then move the project folder and re-run comparison and prune preview successfully.

**Acceptance Scenarios**:

1. **Given** a completed run, **When** the maintainer exports an evidence bundle, **Then** the bundle contains an index listing its items and the corresponding local files, and any item that could not be included is listed as unavailable rather than silently omitted.
2. **Given** an exported bundle copied outside the project folder, **When** it is inspected, **Then** its index and included items are readable without access to the original run.
3. **Given** a project folder moved to a different path, **When** the maintainer runs comparison, prune preview, and bundle inspection, **Then** all three succeed without manual path edits.

---

### Edge Cases

- What happens when comparing a run against itself or against a run from another project? Self-comparison is refused as trivial; runs not present in this project's state are reported as not found rather than partially loaded.
- What happens when cost or usage exists for only one of the compared runs? The report shows the measured figure for one and unavailable for the other; it never averages a measured value with a missing one.
- What happens when pruning would orphan a receipt (evidence gone, receipt still present)? The prune refuses by default and names the receipt; an override is required and recorded in the prune report.
- What happens when a prune preview is generated and the run state changes before the real prune runs? The real prune re-evaluates protections at execution time against current state; a stale preview never authorizes deletion by itself.
- What happens when an active run holds evidence that also qualifies by age and size? Protection wins in every case; age and size only select candidates among unprotected items.
- What happens when the bundle index references an artifact already pruned? The index marks it unavailable with the reason, and the rest of the bundle remains inspectable.
- What happens when state written by an older version is encountered? Comparison and preview report the unreadable portion as unavailable and continue; they never delete what they could not read.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an on-demand local command that compares two or more runs of this project and reports, per run, four separately stated categories: review effort, implementation effort, integration repair, and cost — with cost explicitly marked unavailable when no usage was recorded.
- **FR-002**: The comparison report MUST NOT merge the categories into a single score or grade; each category remains independently interpretable with its inputs named.
- **FR-003**: The comparison MUST show each run's worker profile — harness chain, models, concurrency, and retry/timeout/silence settings — next to its outcomes.
- **FR-004**: The system MUST provide a prune preview (dry run) that lists candidate artifacts by age, size, and evidence reachability and deletes nothing.
- **FR-005**: Pruning MUST refuse to delete evidence required by an active run or evidence referenced by a retained acceptance receipt unless an explicit override flag is supplied; each refusal MUST name the protecting run or receipt.
- **FR-006**: Prune protections MUST be re-evaluated against current state at execution time; a previously generated preview MUST NOT authorize deletion on its own.
- **FR-007**: Retention, comparison, and export MUST operate through the existing project-local state as the single authority; this feature MUST NOT introduce a second store or a background analytics collector.
- **FR-008**: The system MUST export an evidence bundle for a run as local files with an index covering the manifest, task records, attempts, verdicts, receipts, and event excerpts, marking any item that could not be included as unavailable.
- **FR-009**: Comparison, prune preview, prune, and bundle inspection MUST continue to work after the project folder is moved to a new path, with no manual path reconfiguration.
- **FR-010**: All commands in this feature MUST run on demand from the project folder; no background collection, telemetry upload, or hosted service may be required.

### Key Entities

- **Run Comparison Report**: An on-demand report binding selected runs to their worker profiles, the four effort/cost categories per run, and explicit unavailable markers for missing measurements.
- **Prune Plan**: The result of a preview — candidates with age, size, and reachability, protected items with their protecting run or receipt, and the protected/cleared split — valid only until state changes.
- **Evidence Bundle**: An exported, self-contained local copy of one run's evidence with an index that lists included and unavailable items.
- **Worker Profile**: The recorded launch configuration of a run — harness chain, models, concurrency, retry/timeout/silence settings — as stored in existing run state.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One documented command compares two runs and reports all four categories for each; cost reads "unavailable" rather than zero or blank in 100% of runs that recorded no usage.
- **SC-002**: The prune preview deletes zero files in 100% of invocations, and every protected item (active-run evidence, retained-receipt evidence) is flagged in 100% of previews that encounter one.
- **SC-003**: 100% of prune attempts against protected evidence without an explicit override are refused with the protecting run or receipt named; zero protected items are removed by an un-overridden prune.
- **SC-004**: After the project folder is moved to a new path, comparison, prune preview, and bundle inspection all succeed with no manual path edits in 100% of attempts.
- **SC-005**: An exported bundle inspected from outside the project lists every attempted item as included or unavailable in 100% of cases, with no silent omissions.

## Assumptions

- Roadmap classification (confirm during planning by inspecting tests and command paths): needs runtime wiring. Project-local persistence (run file, sidecar state, append-only events, attempt logs), the existing `gc` log pruning, and run archiving already exist; what is missing is the comparison, export, and protection-aware prune-preview command surface wired onto that state.
- Lightweight boundary (from the roadmap): on-demand local commands with no background analytics collection, no hosted service, and no second persistence authority beside the existing project-local state.
- Competitor inspiration: none cited; the opportunity premise that persisted state is opaque and accumulates without controls is treated as a hypothesis to verify against real project folders before tuning default retention ages.
- "Retained acceptance receipt" is assumed to mean a receipt that existing state marks as retained or that belongs to a run kept as history; the exact marker is confirmed during planning against the existing receipt and archive formats, and receipts are treated as protected whenever that marker is present.
- Cost data availability varies by harness, so unavailable is the honest default; no effort estimate is ever synthesized to fill a missing cost.
- Existing `gc` behavior is the retention surface this feature extends; pruning must not fork into a second deletion path with different rules.
