/**
 * Preload rule priority: CUSTOM (admin) > PREDEFINED > AI.
 * Higher-priority rules of the same kind replace lower-priority ones.
 */

export function ruleSourceRank(source) {
  const value = String(source || "")
    .trim()
    .toUpperCase();
  if (value === "CUSTOM" || value === "ADMIN") return 0;
  if (value === "PREDEFINED") return 1;
  if (value === "AI") return 2;
  return 3;
}

export function isTransformationRule(rule) {
  const type = String(rule?.type || "").toLowerCase();
  const category = String(rule?.category || "").toLowerCase();
  return type === "transformation" || category === "transformation";
}

function ruleHaystack(rule) {
  return [
    rule?.ruleName,
    rule?.description,
    rule?.constraint,
    rule?.category,
    rule?.type,
    rule?.ruleId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Rules that would fight over the same field behavior share a key.
 * Distinct custom/AI validations keep unique keys so they still all run.
 */
export function ruleConflictKey(rule) {
  if (isTransformationRule(rule)) return "transformation";

  const text = ruleHaystack(rule);
  const ruleId = String(rule?.ruleId || "");

  if (
    text.includes("duplicate") ||
    ruleId === "COMMON-DUPLICATE" ||
    rule?.constraint === "UNIQUE_REQUIRED" ||
    rule?.constraint === "FLAG_DUPLICATES"
  ) {
    return "duplicate";
  }

  if (
    text.includes("null/empty") ||
    text.includes("null check") ||
    ruleId === "COMMON-NULL-EMPTY" ||
    rule?.constraint === "NOT_NULL_OR_EMPTY" ||
    rule?.constraint === "FLAG_NULL_OR_EMPTY"
  ) {
    return "null_empty";
  }

  return `unique:${ruleId || rule?.ruleName || text}`;
}

function sourceLabel(rank) {
  if (rank === 0) return "custom";
  if (rank === 1) return "predefined";
  if (rank === 2) return "AI";
  return "higher-priority";
}

export function lowerPrioritySkipReason(winningRank) {
  return `Skipped because a ${sourceLabel(winningRank)} rule has higher priority for this field`;
}

/**
 * Keep the highest-priority rule for each conflict key, then sort
 * CUSTOM → PREDEFINED → AI (transformations before other rules at the same source).
 */
export function prioritizeFieldRules(rules) {
  const list = Array.isArray(rules) ? [...rules] : [];
  const bestRankByKey = new Map();

  for (const rule of list) {
    const key = ruleConflictKey(rule);
    const rank = ruleSourceRank(rule.source);
    const current = bestRankByKey.get(key);
    if (current === undefined || rank < current) {
      bestRankByKey.set(key, rank);
    }
  }

  const filtered = list.filter(
    (rule) => ruleSourceRank(rule.source) === bestRankByKey.get(ruleConflictKey(rule)),
  );

  filtered.sort((left, right) => {
    const sourceDiff = ruleSourceRank(left.source) - ruleSourceRank(right.source);
    if (sourceDiff !== 0) return sourceDiff;
    const leftTransform = isTransformationRule(left) ? 0 : 1;
    const rightTransform = isTransformationRule(right) ? 0 : 1;
    return leftTransform - rightTransform;
  });

  return filtered;
}

export function compareFindingsByPriority(left, right) {
  const leftRule = left?.rule || left;
  const rightRule = right?.rule || right;
  const sourceDiff =
    ruleSourceRank(leftRule?.source) - ruleSourceRank(rightRule?.source);
  if (sourceDiff !== 0) return sourceDiff;
  const leftTransform = isTransformationRule(leftRule) ? 0 : 1;
  const rightTransform = isTransformationRule(rightRule) ? 0 : 1;
  if (leftTransform !== rightTransform) return leftTransform - rightTransform;
  const leftErr = String(left?.severity || "").toLowerCase() === "error" ? 0 : 1;
  const rightErr = String(right?.severity || "").toLowerCase() === "error" ? 0 : 1;
  return leftErr - rightErr;
}
