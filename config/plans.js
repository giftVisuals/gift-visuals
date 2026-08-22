// Central plan configuration. Change values here only — nothing else in the
// app should hardcode media limits, usage allowances, or priority levels.

const PLAN_IDS = Object.freeze({
  FREE: "free",
  PRO: "pro",
  MAX: "max",
});

// "usageLimit" is expressed in AI Usage Units (AUU) per week, not "videos".
// See lib/usage.js for how a job's cost in AUU is calculated.
const PLANS = Object.freeze({
  [PLAN_IDS.FREE]: {
    id: PLAN_IDS.FREE,
    name: "Free",
    mediaLimit: 5,
    usageLimitPerWeek: 300,
    priority: 1, // lowest
    targetProcessingMinutes: { min: 15, max: null },
    maxOutputSeconds: 90,
    maxUploadFileSizeMb: 250,
  },
  [PLAN_IDS.PRO]: {
    id: PLAN_IDS.PRO,
    name: "Pro",
    mediaLimit: 15,
    usageLimitPerWeek: 1500,
    priority: 5,
    targetProcessingMinutes: { min: 7, max: null },
    maxOutputSeconds: 600,
    maxUploadFileSizeMb: 1024,
  },
  [PLAN_IDS.MAX]: {
    id: PLAN_IDS.MAX,
    name: "Max",
    mediaLimit: 70,
    usageLimitPerWeek: 8000,
    priority: 10, // highest
    targetProcessingMinutes: { min: 2, max: null },
    maxOutputSeconds: 1800,
    maxUploadFileSizeMb: 4096,
  },
});

function getPlan(planId) {
  return PLANS[planId] || PLANS[PLAN_IDS.FREE];
}

function isValidPlan(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

module.exports = { PLAN_IDS, PLANS, getPlan, isValidPlan };
