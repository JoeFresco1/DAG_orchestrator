import type { ReviewRouterEvidence } from './factory/review-router.js';

/** Classify changed paths, never prompt text. Repository graph signals can add authority. */
export function artifactRiskSignals(paths: string[], checksPassed: boolean): NonNullable<ReviewRouterEvidence['artifactSignals']> {
  const normalized = paths.map(path => path.replaceAll('\\', '/').toLowerCase());
  const component = (pattern: RegExp): boolean => normalized.some(path => pattern.test(path));
  const protectedClasses: string[] = [];
  if (component(/(?:^|\/)(?:auth(?:entication|orization)?|permissions?|tenant(?:s|[-_]isolation)?|secrets?|credentials?|crypto(?:graphy)?)(?:[./_-]|$)/)) protectedClasses.push('security or tenant isolation');
  if (component(/(?:^|\/)(?:billing|payments?|pricing|ledger|financial)(?:[./_-]|$)/)) protectedClasses.push('financial behavior');
  if (component(/(?:^|\/)(?:migrations?)(?:\/|$)/)) protectedClasses.push('migration requires destructive-impact review');
  return {
    publicContract: component(/(?:^|\/)(?:api|interfaces?|contracts?|schemas?|events?)(?:[./_-]|$)/),
    dependencyChange: component(/(?:^|\/)(?:package\.json|.*lock.*|requirements.*|pyproject\.toml|go\.(?:mod|sum))$/),
    durableConcurrency: component(/(?:^|\/)(?:runner|scheduler|retry|cancellation|concurrency|store|persistence|integration)(?:[./_-]|$)/),
    coverageUncertain: !checksPassed, protectedClasses,
  };
}
