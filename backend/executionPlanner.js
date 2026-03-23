/**
 * executionPlanner.js — Community Edition
 *
 * Single-agent execution only. No multi-agent planning or parallel execution.
 * The full intent-based LLM planner with phase-aware multi-agent execution
 * is available in EzCoworker Enterprise.
 */
'use strict';

async function buildIntentPlan(message, enabledSkills = []) {
  return {
    phases: [{ mode: 'single', steps: [{ agent: 1, task: message, skills: enabledSkills }] }],
    intent: 'general', tier: 1, useTeam: false, reason: 'community_single_agent',
  };
}

async function summarizeExecution()   { return null; }
async function loadExecutionContext() { return null; }
async function classifyTurnIntent()   { return 'NEW'; }
async function buildPatchTask(message) { return message; }
async function buildExtendContext(message) { return { message, context: null }; }
async function selectPlannerModels(models) { return { generator: models && models[0], validator: null }; }

module.exports = {
  buildIntentPlan, summarizeExecution, loadExecutionContext,
  classifyTurnIntent, buildPatchTask, buildExtendContext, selectPlannerModels,
};
