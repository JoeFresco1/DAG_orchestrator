// Viewer/server lifecycle commands: `serve`, `launch`, `servers`.
import { launchProject, projectEntriesFromArgs, pruneServers, stopServer } from '../launcher.js';
import { addProject } from '../registry.js';
import { startServer } from '../server.js';
import { countFlag, emit, flag, has } from '../cli-args.js';

// `serve` runs the web viewer in the foreground. With --file it serves one run;
// without it, hub mode serves every registered project from the registry
// (never an implicit ./dag.run.json).
export function serveCmd(argv: string[]): Promise<void> {
  startServer({
    file: flag(argv, 'file'),
    port: countFlag(argv, 'port', 1) ?? 8787,
    autoResume: has(argv, 'auto-resume'),
    killOrphansOnResume: has(argv, 'kill-orphans'),
    open: has(argv, 'open'),
  });
  // Never resolves: the HTTP server keeps the process alive.
  return new Promise(() => {});
}

// One server per project, each on its own stable port, so every project gets
// its own browser window and nothing is shared.
export async function launchCmd(argv: string[]): Promise<void> {
  const dirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) dirs.push(argv[i + 1]);
  }
  const entries = projectEntriesFromArgs(dirs, has(argv, 'all'));
  if (entries.length === 0) {
    console.log('no projects selected; use --all or --dir <folder> (repeatable)');
    console.log('tip: register one first with: dag projects add --dir C:\\path\\to\\project');
    process.exitCode = 1;
    return;
  }
  const results: Awaited<ReturnType<typeof launchProject>>[] = [];
  for (const entry of entries) {
    const result = await launchProject(entry, {
      open: has(argv, 'open'),
      autoResume: has(argv, 'auto-resume'),
      killOrphans: has(argv, 'kill-orphans'),
    });
    results.push(result);
  }
  emit(argv, results, () =>
    results
      .map(
        (r) =>
          `${r.alreadyRunning ? 'running' : 'started'}  ${r.entry.name}\t${r.url}\t${r.entry.file}`,
      )
      .join('\n'),
  );
}

// `servers` lists the background viewers, or stops them with --stop.
export function serversCmd(argv: string[]): void {
  if (has(argv, 'stop')) {
    const dirs: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--dir' && argv[i + 1]) dirs.push(argv[i + 1]);
    }
    // --all stops everything recorded; --dir resolves each folder to its
    // project entry so we stop the right run file.
    const targets = has(argv, 'all')
      ? pruneServers().map((s) => ({ name: s.name, file: s.file }))
      : dirs.map((d) => {
          const entry = addProject(d);
          return { name: entry.name, file: entry.file };
        });
    if (targets.length === 0) {
      console.log('no servers recorded; use --all or --dir <folder>');
      return;
    }
    const rows = targets.map((t) => ({ name: t.name, ...stopServer(t.file) }));
    emit(argv, rows, () =>
      rows
        .map((r) =>
          r.pid === null
            ? `not running\t${r.name}`
            : r.stopped
              ? `stopped\t${r.name}\tpid ${r.pid}`
              : `still alive\t${r.name}\tpid ${r.pid}`,
        )
        .join('\n'),
    );
    return;
  }
  const alive = pruneServers();
  const rows = alive.map((s) => ({
    ...s,
    url: `http://localhost:${s.port}`,
    alive: true,
  }));
  emit(argv, rows, () =>
    rows.length === 0
      ? 'no servers running; start them with: dag launch --all --open'
      : rows.map((r) => `${r.name}\t${r.url}\tpid ${r.pid}\t${r.file}`).join('\n'),
  );
}
