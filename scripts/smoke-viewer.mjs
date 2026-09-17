#!/usr/bin/env node
// Browser smoke test for the viewer: drives the real pages in headless Edge
// over CDP against a scratch project, and checks that every mutation an
// operator can trigger actually reaches the server.
//
//   node scripts/smoke-viewer.mjs
//
// Skips (exit 0) when headless Edge is not installed, so `pnpm test` stays
// hermetic; run it explicitly before shipping UI changes.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const dist = (name) => `file:///${join(here, 'dist', name).replace(/\\/g, '/')}`;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.log('smoke-viewer: no headless browser found, skipping');
  process.exit(0);
}

const work = join(tmpdir(), `dag-smoke-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const projectDir = join(work, 'proj');
mkdirSync(projectDir, { recursive: true });

const { addTask, newRun, saveRun, logEvent } = await import(dist('store.js'));
const file = join(projectDir, 'dag.run.json');
const run = newRun('smoke viewer');
const ok = addTask(run, { title: 'ok task', spec: '', cmd: `"${process.execPath}" -e "process.exit(0)"` });
const bad = addTask(run, { title: 'bad task', spec: '', cmd: `"${process.execPath}" -e "process.exit(7)"` });
const gated = addTask(run, { title: 'gated task', spec: '', cmd: `"${process.execPath}" -e "process.exit(0)"` });
run.tasks[ok.id].status = 'completed';
run.tasks[bad.id].status = 'failed';
run.tasks[bad.id].failureKind = 'exit';
run.tasks[bad.id].exitCode = 7;
run.tasks[gated.id].gate = { question: 'ship it?', options: ['approved', 'rejected'], approved: null };
saveRun(run, file);

const registry = join(work, 'projects.json');
writeFileSync(
  registry,
  `${JSON.stringify(
    { version: 1, projects: [{ file, name: 'smoke', addedAt: new Date().toISOString() }] },
    null,
    2,
  )}\n`,
);
process.env.DAG_REGISTRY = registry.replace(/\\/g, '/');
process.env.DAG_SERVERS = join(work, 'servers.json').replace(/\\/g, '/');

const { startServer, stopServer } = await import(dist('server.js'));
const PORT = 8791;
startServer({ port: PORT });
await new Promise((r) => setTimeout(r, 1200));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ---- headless browser ----
const CDP = 9391;
let edgePid = null;
const alive = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok;
  } catch {
    return false;
  }
};
if (!(await alive())) {
  const child = spawn(
    edge,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${join(work, 'profile')}`,
      '--no-first-run',
      '--window-size=1400,900',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  edgePid = child.pid ?? null;
  child.unref();
  for (let i = 0; i < 60 && !(await alive()); i += 1) await new Promise((r) => setTimeout(r, 250));
}
if (!(await alive())) {
  console.log('smoke-viewer: browser did not start, skipping');
  stopServer();
  process.exit(0);
}

async function session(url) {
  const target = await (
    await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await new Promise((r) => setTimeout(r, 2200));
  return { evaluate, exceptions, close: () => ws.close() };
}

const projectId = (await (await fetch(`${base}/api/projects`)).json()).projects[0].id;

try {
  // ---- projects page ----
  {
    const s = await session(`${base}/`);
    const cards = await s.evaluate("document.querySelectorAll('#projects a.card').length");
    check('projects page lists the project', cards === 1, `${cards} card(s)`);
    check('no page exception', s.exceptions.length === 0, s.exceptions.join(' | ').slice(0, 160));
    s.close();
  }

  // ---- project page: settings via the UI ----
  {
    const s = await session(`${base}/p/${projectId}`);
    await s.evaluate("document.getElementById('settingsBtn').click()");
    await s.evaluate("document.getElementById('sConcurrency').value='3'");
    await s.evaluate("document.getElementById('saveSettingsBtn').click()");
    await new Promise((r) => setTimeout(r, 1500));
    const settings = await (await fetch(`${base}/api/projects/${projectId}`)).json();
    check('settings saved from the project page', settings.settings.concurrency === 3, `concurrency=${settings.settings.concurrency}`);
    check('no page exception', s.exceptions.length === 0, s.exceptions.join(' | ').slice(0, 160));
    s.close();
  }

  // ---- run page: approve a gate, retry failures, run, stop ----
  {
    const s = await session(`${base}/r/${run.id}`);
    const runBtnDisabled = await s.evaluate("document.getElementById('runBtn').disabled");
    check('Run is enabled when nothing is checked', runBtnDisabled === false, `disabled=${runBtnDisabled}`);

    // Gate approval through the inspector.
    const taskRow = await s.evaluate(`(() => {
      const row = [...document.querySelectorAll('#queue .row')].find((r) => r.textContent.includes('gated task'));
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(row);
    })()`);
    check('the gated task can be selected', taskRow === true);
    await new Promise((r) => setTimeout(r, 800));
    const approved = await s.evaluate(`(() => {
      const btn = [...document.querySelectorAll('#inspector button')].find((b) => b.textContent === 'Approve');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1200));
    const gateState = await (await fetch(`${base}/api/runs/${run.id}/tasks/${gated.id}`)).json();
    check('approval reached the server', approved === true && gateState.task.gate?.approved === true, JSON.stringify(gateState.task?.gate));

    // Retry failed.
    await s.evaluate("document.getElementById('retryBtn').click()");
    await new Promise((r) => setTimeout(r, 1200));
    const afterRetry = await (await fetch(`${base}/api/runs/${run.id}/summary`)).json();
    const badStatus = afterRetry.tasks.find((t) => t.id === bad.id)?.status;
    check('retry requeued the failed task', badStatus === 'pending', `status=${badStatus}`);

    // Run everything (nothing checked) — the documented empty-selection path.
    await s.evaluate("document.getElementById('runBtn').click()");
    await new Promise((r) => setTimeout(r, 4000));
    const afterRun = await (await fetch(`${base}/api/runs/${run.id}/summary`)).json();
    const badAfter = afterRun.tasks.find((t) => t.id === bad.id);
    check('the run actually executed tasks', afterRun.rev > afterRetry.rev, `rev ${afterRetry.rev} -> ${afterRun.rev}`);
    check('the nonzero exit failed the task', badAfter.status === 'failed' && badAfter.failureKind === 'exit', `${badAfter.status}/${badAfter.failureKind}`);

    // Stop is accepted (nothing running, but it must not error the page).
    await s.evaluate("document.getElementById('stopBtn').click()");
    await new Promise((r) => setTimeout(r, 800));
    check('no page exception after the run flows', s.exceptions.length === 0, s.exceptions.join(' | ').slice(0, 160));
    s.close();
  }

  // ---- archived runs stay read-only ----
  {
    const { archiveRun } = await import(dist('runs.js'));
    archiveRun(projectDir, file);
    const start = await fetch(`${base}/api/runs/${run.id}/run/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: null }),
    });
    check('an archived run refuses to start', start.status === 409, `status ${start.status}`);
  }
} finally {
  stopServer();
  if (edgePid) {
    try {
      execFileSync('taskkill', ['/pid', String(edgePid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(work, { recursive: true, force: true });
}

void logEvent;
console.log(`\n${failures === 0 ? 'VIEWER SMOKE OK' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
