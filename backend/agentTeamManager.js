/**
 * agentTeamManager.js — Community Edition
 *
 * Single-agent execution only. runTeam() simply runs a single agent.
 * Parallel multi-agent execution with phase-aware synthesis is available
 * in EzCoworker Enterprise.
 */
'use strict';

class AgentTeamManager {
  constructor(containerManager) {
    this._containerManager = containerManager;
  }

  /**
   * Community edition — ignores agentCount and executionPlan.
   * Always runs a single agent.
   */
  async runTeam(containerName, { task, systemContext, modelConfig, userId, onChunk }) {
    const result = await this._containerManager.execInContainer(
      containerName, task, systemContext, modelConfig, onChunk
    );
    return { output: result, agents: 1, mode: 'single' };
  }
}

module.exports = AgentTeamManager;
