// Server-side usage + plan enforcement.
//
// IMPORTANT: this is an in-memory store. It is a deliberate, documented
// placeholder for the Firestore-backed store described in the product spec
// ("database expansion can come later") — it is NOT persisted across server
// restarts/deploys. It is still real server-side enforcement (never trusts
// the client), which is the requirement that actually matters for
// correctness today. Swap `store` for a Firestore-backed implementation
// behind the same functions when the database layer is built — nothing
// else in the app should need to change.

const { getResetWindow, isUsageStale } = require("../config/reset");
const { getPlan, isValidPlan, PLAN_IDS } = require("../config/plans");

/** @type {Map<string, { planId: string, usedUnits: number, periodStart: string }>} */
const store = new Map();

function getRecord(uid) {
  let record = store.get(uid);
  const now = new Date();
  if (!record) {
    record = { planId: PLAN_IDS.FREE, usedUnits: 0, periodStart: now.toISOString() };
    store.set(uid, record);
  }
  if (isUsageStale(record.periodStart, now)) {
    record.usedUnits = 0;
    record.periodStart = getResetWindow(now).lastReset.toISOString();
  }
  return record;
}

function getStatus(uid) {
  const record = getRecord(uid);
  const plan = getPlan(record.planId);
  const { nextReset } = getResetWindow();
  return {
    planId: plan.id,
    planName: plan.name,
    usageLimitPerWeek: plan.usageLimitPerWeek,
    usedUnits: record.usedUnits,
    remainingUnits: Math.max(0, plan.usageLimitPerWeek - record.usedUnits),
    mediaLimit: plan.mediaLimit,
    priority: plan.priority,
    nextResetAt: nextReset.toISOString(),
  };
}

/** Throws if the estimated cost would exceed the user's remaining weekly allowance. */
function assertCanConsume(uid, estimatedUnits) {
  const record = getRecord(uid);
  const plan = getPlan(record.planId);
  const remaining = plan.usageLimitPerWeek - record.usedUnits;
  if (estimatedUnits > remaining) {
    const err = new Error("Weekly AI usage limit reached.");
    err.code = "USAGE_LIMIT_EXCEEDED";
    err.remaining = Math.max(0, remaining);
    throw err;
  }
}

function consume(uid, units) {
  const record = getRecord(uid);
  record.usedUnits += Math.max(0, units);
  return getStatus(uid);
}

function refund(uid, units) {
  const record = getRecord(uid);
  record.usedUnits = Math.max(0, record.usedUnits - Math.max(0, units));
  return getStatus(uid);
}

function setPlan(uid, planId) {
  if (!isValidPlan(planId)) throw new Error("Invalid plan id.");
  const record = getRecord(uid);
  record.planId = planId;
  return getStatus(uid);
}

module.exports = { getStatus, assertCanConsume, consume, refund, setPlan };
