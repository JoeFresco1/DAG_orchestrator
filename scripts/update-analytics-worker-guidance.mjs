// Narrow, idempotent operational adapter update. Frozen specs/checks are untouched.
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'C:/Users/Fresc/advanced-analytics-dag/scripts/build/reliability-adapter.mjs';
let source = readFileSync(path, 'utf8');
const previous = 'Preserve all existing test imports/helpers/assertions. Add top-level tests; use dynamic imports inside new tests when needed rather than changing existing module support.';
const replacement = 'Preserve all existing test imports/helpers/assertions and module statements verbatim. The test guard permits ONLY new top-level test/it/describe/suite calls: no new top-level helper, type, constant, import or export. Define new helpers inside the added test callback or an added suite callback; use dynamic imports inside callbacks. If sharing fixtures through a parent test, await every t.test child and keep the parent name prefixed with scope:' + '${key}' + ': so the unchanged name filter executes all child cases. Do not request another file when nesting helpers solves the assigned scope. Read only the assigned task lines and relevant interface excerpts, rather than dumping the whole task list or old transcripts.';
if (source.includes(previous)) source = source.replace(previous, replacement);
else if (!source.includes(replacement)) throw Error('Adapter guidance changed; inspect before updating');
const oldTail = '\\nFor 002-acceptance-report, reuse correct saved owned test/report work only after diffing against latest accepted HEAD. Attempt 2\'s producer CLI patch is unaccepted but available for a targeted reviewed diff. Never overwrite the whole producer from salvage. Finish the actual matrix and browser checks; a no-op exit 0 is not success.';
const newTail = '\\nAddress incident.lastFailure first when present; it is the latest exact rejection, not a new requirement. Review/check outputs are stored in the linked ledger if a focused excerpt is insufficient. ' + '${key === \'002-acceptance-report\' ? "Reuse saved report work only after diffing against accepted HEAD. Historical producer patches are unaccepted; never overwrite a producer from salvage. Finish the actual matrix and browser checks." : ""}' + ' A no-op exit 0 is not acceptance.';
if (source.includes(oldTail)) source = source.replace(oldTail, newTail);
else if (!source.includes(newTail)) throw Error('Adapter repair prompt changed; inspect before updating');
writeFileSync(path, source);
console.log('Updated only analytics reliability adapter guidance; requirements, tests, graph and model policy unchanged.');
