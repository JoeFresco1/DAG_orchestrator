// The command registry: maps `dag <name>` to its handler. `cli.ts` looks the
// first argument up here and calls it, so adding a command is a one-line entry
// plus its handler in the matching module (no change to the entry point).
import type { CommandHandler } from '../cli-args.js';
import {
  approveCmd,
  addCmd,
  blockedCmd,
  dotCmd,
  editCmd,
  gateCmd,
  gcCmd,
  heartbeatCmd,
  listCmd,
  logCmd,
  logsCmd,
  readyCmd,
  rmCmd,
  setCmd,
  showCmd,
  statusCmd,
} from './tasks.js';
import {
  chainReviewCmd,
  harnessCmd,
  layersCmd,
  modelsCmd,
  reviewCmd,
  reviewerCmd,
} from './reviews.js';
import {
  finalReviewCmd,
  killOrphansCmd,
  resumeCmd,
  retryCmd,
  retryFailedCmd,
  runCmd,
  settingsCmd,
  skipBlockedCmd,
} from './run.js';
import { newRunCmd, runsCmd } from './runs.js';
import { initCmd, projectsCmd } from './projects.js';
import { scheduleCmd } from './schedule.js';
import { launchCmd, serveCmd, serversCmd } from './viewer.js';

export const COMMANDS: Record<string, CommandHandler> = {
  // Viewer / server
  serve: serveCmd,
  launch: launchCmd,
  servers: serversCmd,
  // Projects and run files
  init: initCmd,
  projects: projectsCmd,
  'new-run': newRunCmd,
  runs: runsCmd,
  // Scheduling
  schedule: scheduleCmd,
  scheduler: scheduleCmd,
  // Run lifecycle
  run: runCmd,
  resume: resumeCmd,
  'skip-blocked': skipBlockedCmd,
  'kill-orphans': killOrphansCmd,
  settings: settingsCmd,
  'final-review': finalReviewCmd,
  // Execution controls
  retry: retryCmd,
  'retry-failed': retryFailedCmd,
  // Task graph editing and inspection
  add: addCmd,
  edit: editCmd,
  rm: rmCmd,
  list: listCmd,
  status: statusCmd,
  ready: readyCmd,
  blocked: blockedCmd,
  show: showCmd,
  'set': setCmd,
  'set-cmd': setCmd,
  heartbeat: heartbeatCmd,
  log: logCmd,
  logs: logsCmd,
  gc: gcCmd,
  gate: gateCmd,
  approve: approveCmd,
  reject: approveCmd,
  dot: dotCmd,
  // Reviews and harnesses
  layers: layersCmd,
  'chain-review': chainReviewCmd,
  review: reviewCmd,
  reviewer: reviewerCmd,
  harness: harnessCmd,
  models: modelsCmd,
};
