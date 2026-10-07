// Exercise the packaged controller through the ordinary repository test gate.
// @ts-expect-error JavaScript lifecycle fixtures intentionally use the installed CLI.
await import('../scripts/reliability/reliability.test.mjs');
