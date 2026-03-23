const { exec, execFile, execSync, spawn } = require('child_process');
const fs = require('fs');

class ContainerManager {
  constructor() {
    // Map: userId -> { containerName, lastActivity }
    this.containers = new Map();
    // Map: userId -> Promise — serializes concurrent ensureContainer calls
    this._creating = new Map();
    // Map: userId -> { child, reject } — tracks active streaming processes for stop
    this._activeStreams = new Map();
    this.TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    this.cleanupInterval = setInterval(() => this.cleanupInactive(), 5 * 60 * 1000);
  }

  /**
   * Get or create a persistent container for a user.
   * Serializes concurrent calls for the same userId to prevent duplicate creation.
   */
  async ensureContainer(userId) {
    if (this._creating.has(userId)) return this._creating.get(userId);
    const promise = this._doEnsureContainer(userId);
    this._creating.set(userId, promise);
    try { return await promise; } finally { this._creating.delete(userId); }
  }

  async _doEnsureContainer(userId) {
    const containerName = `claude-agent-user-${userId}`;

    // Fast path: check in-memory map, then verify it's actually running
    if (this.containers.has(userId)) {
      if (this._isRunning(containerName)) {
        this.containers.get(userId).lastActivity = Date.now();
        return containerName;
      }
      this.containers.delete(userId);
    }

    // Ensure user folder exists with correct permissions
    this.ensureUserFolder(userId);

    // Check if container exists but is stopped (e.g. after backend restart)
    if (this._exists(containerName)) {
      this._start(containerName);
    } else {
      await this._create(userId, containerName);
    }

    // Fix workspace permissions — Windows volume mounts are owned by root,
    // so the node user (UID 1000) can't write. Run chown as root inside container.
    try {
      execSync(`docker exec -u 0 ${containerName} chown -R 1000:1000 /home/node/app/workspace`, { stdio: 'pipe' });
    } catch (e) {
      console.warn(`[ContainerManager] Could not fix workspace permissions:`, e.message);
    }

    this.containers.set(userId, {
      containerName,
      lastActivity: Date.now()
    });

    return containerName;
  }

  /**
   * Execute a claude command inside an existing persistent container.
   * Pipes the user message via stdin (canonical `echo "msg" | claude -p` usage)
   * to avoid Windows argument-quoting issues with special characters.
   * Uses execFile (no shell) to prevent injection. 120s timeout.
   *
   * @param {string} containerName - The container name
   * @param {string} message - The user's message
   * @param {string} systemContext - The system prompt
   * @param {object} modelConfig - Model configuration { api_endpoint, model_identifier, api_key }
   */
  execInContainer(containerName, message, systemContext, modelConfig = null) {
    // Use provided model config or fall back to defaults
    const model = modelConfig?.model_identifier || 'qwen2.5-coder:7b';
    const apiEndpoint = (modelConfig?.api_endpoint || 'http://host.docker.internal:11434').replace(/\/+$/, '');
    const apiKey = modelConfig?.api_key || 'dummy-key';
    const provider = (modelConfig?.provider || 'ollama').toLowerCase();

    // Prefix model identifier correctly per provider so Claude Code CLI
    // routes to the right API. Without the prefix, OpenAI and Google models fail.
    //   openai   → openai/gpt-4o  (not just gpt-4o)
    //   google   → gemini/gemini-2.0-flash  (not just gemini-2.0-flash)
    //   groq     → groq/... not needed — Groq uses ANTHROPIC_BASE_URL passthrough
    //   anthropic/ollama/openrouter → use model identifier as-is
    let resolvedModel = model;
    if (provider === 'openai' && !model.startsWith('openai/')) {
      resolvedModel = `openai/${model}`;
    } else if (provider === 'google' && !model.startsWith('gemini/') && !model.startsWith('google/')) {
      resolvedModel = `gemini/${model}`;
    }


    // Capable providers (cloud APIs) can use Claude Code's native tool
    // definitions for file creation, bash execution, etc.  Weak local models
    // (Ollama 7b) cannot — they need our custom FILE:/COMMAND: instructions.
    // Exception: specific Ollama models marked is_capable=true in the DB
    // (e.g. qwen3-coder:30b, gpt-oss:latest) are treated as capable.
    const CAPABLE_PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter'];
    const isCapable = CAPABLE_PROVIDERS.includes(provider) || !!modelConfig?.is_capable;

    // Build provider-specific environment variables.
    //
    // The Claude Code CLI routes differently per provider:
    //
    //   google     → GOOGLE_API_KEY=AIza...  (Claude Code has native Gemini support)
    //                Do NOT set ANTHROPIC_BASE_URL — Google's API is not Anthropic-compatible.
    //
    //   openai     → ANTHROPIC_BASE_URL=https://api.openai.com/v1   + ANTHROPIC_API_KEY=sk-...
    //   anthropic  → ANTHROPIC_BASE_URL=https://api.anthropic.com   + ANTHROPIC_API_KEY=sk-ant-...
    //   groq       → ANTHROPIC_BASE_URL=https://api.groq.com/...    + ANTHROPIC_API_KEY=gsk_...
    //   openrouter → ANTHROPIC_BASE_URL=https://openrouter.ai/...   + ANTHROPIC_API_KEY=sk-or-...
    //   ollama     → ANTHROPIC_BASE_URL=http://host.docker...        + ANTHROPIC_API_KEY=dummy
    //
    // NOTE: Setting OPENAI_API_KEY does nothing — the Claude CLI ignores it.
    //       ANTHROPIC_BASE_URL must always point to the correct endpoint.
    let providerEnvArgs;
    if (provider === 'google') {
      // Claude Code CLI natively supports Google Gemini via GOOGLE_API_KEY.
      // Routing through ANTHROPIC_BASE_URL fails because Google's API is not Anthropic-format.
      providerEnvArgs = [
        `GOOGLE_API_KEY=${apiKey}`,
      ];
    } else {
      providerEnvArgs = [
        `ANTHROPIC_BASE_URL=${apiEndpoint}`,
        `ANTHROPIC_API_KEY=${apiKey}`,
      ];
    }

    // Use 'env' command to set environment variables for this exec
    // Max agentic tool-call rounds — prevents unlimited retry chains (e.g. 20+ attempts to read a file).
    // Configurable via MAX_AGENT_TURNS (capable cloud models, default 15) and
    // MAX_AGENT_TURNS_LOCAL (non-capable Ollama/local models, default 3).
    // Non-capable models are capped to prevent expensive runaway skill-call loops
    // (e.g. gpt-oss calling Skill 16 times = 493K tokens).
    const maxTurnsEnv = Math.max(1, parseInt(process.env.MAX_AGENT_TURNS, 10) || 15);
    const maxTurnsLocalEnv = Math.max(1, parseInt(process.env.MAX_AGENT_TURNS_LOCAL, 10) || 3);
    const maxTurns = isCapable ? maxTurnsEnv : Math.min(maxTurnsEnv, maxTurnsLocalEnv);

    const args = [
      'exec', '-i',                    // -i keeps stdin open so we can pipe the message
      containerName,
      'env',                           // Use env to set variables for this command
      ...providerEnvArgs,
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', // activates Task tool in all containers
      'claude',
      '-p',                            // Print mode: read from stdin, write response to stdout
      '--model', resolvedModel,
      '--dangerously-skip-permissions',
      '--max-turns', String(maxTurns), // Cap tool-call rounds to prevent runaway chains
    ];

    // For capable cloud models (GPT-4, Claude, etc.): use --append-system-prompt
    // so the model retains native tool definitions (file creation, bash, etc.)
    // while also getting our workspace path instructions.
    //
    // For weak local models (Ollama 7b): use --system-prompt to REPLACE the
    // native prompt because the model can't handle complex tool definitions
    // and outputs broken JSON tool calls.  Our FILE:/COMMAND: instructions
    // give it a simple format it can follow.
    if (systemContext) {
      if (isCapable) {
        args.push('--append-system-prompt', systemContext);
      } else {
        args.push('--system-prompt', systemContext);
      }
    }

    // MCP server config — passed via --mcp-config as a JSON string
    if (modelConfig?.mcpConfig) {
      args.push('--mcp-config', modelConfig.mcpConfig);
    }

    // Message is piped via stdin, NOT passed as a positional argument.

    console.log(`[ContainerManager] Executing with model: ${model}, endpoint: ${apiEndpoint}`);
    console.log(`[ContainerManager] Exec args count: ${args.length}, system-prompt length: ${(systemContext || '').length}, message: "${message.substring(0, 80)}"`);

    return new Promise((resolve, reject) => {
      const child = execFile('docker', args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 600000  // 10 minutes for large file operations
      }, (err, stdout, stderr) => {
        console.log(`[ContainerManager] Exec result — stdout: ${stdout.length} chars, stderr: ${stderr.length} chars, err: ${err ? err.code || err.message : 'none'}`);
        if (stderr) console.warn(`[ContainerManager] Agent stderr:`, stderr.substring(0, 500));
        if (err) return reject({ error: err, stderr });
        resolve({ stdout, stderr });
      });

      // Pipe user message through stdin and close it so claude -p processes it
      child.stdin.write(message);
      child.stdin.end();
    });
  }

  /**
   * Execute a claude command inside a container with streaming stdout.
   * Uses spawn() instead of execFile() so output arrives in real-time chunks.
   * Calls onChunk(text) for each stdout chunk as it arrives.
   * Returns a Promise that resolves with { stdout, stderr } when complete.
   *
   * @param {string} containerName - The container name
   * @param {string} message - The user's message
   * @param {string} systemContext - The system prompt
   * @param {object} modelConfig - Model configuration { api_endpoint, model_identifier, api_key }
   * @param {function} onChunk - Called with each stdout chunk string as it arrives
   */
  execInContainerStream(containerName, message, systemContext, modelConfig = null, onChunk = null, options = {}, userId = null) {
    const model = modelConfig?.model_identifier || 'qwen2.5-coder:7b';
    const apiEndpoint = (modelConfig?.api_endpoint || 'http://host.docker.internal:11434').replace(/\/+$/, '');
    const apiKey = modelConfig?.api_key || 'dummy-key';
    const provider = (modelConfig?.provider || 'ollama').toLowerCase();

    // Prefix model identifier correctly per provider so Claude Code CLI
    // routes to the right API. Without the prefix, OpenAI and Google models fail.
    //   openai   → openai/gpt-4o  (not just gpt-4o)
    //   google   → gemini/gemini-2.0-flash  (not just gemini-2.0-flash)
    //   groq     → groq/... not needed — Groq uses ANTHROPIC_BASE_URL passthrough
    //   anthropic/ollama/openrouter → use model identifier as-is
    let resolvedModel = model;
    if (provider === 'openai' && !model.startsWith('openai/')) {
      resolvedModel = `openai/${model}`;
    } else if (provider === 'google' && !model.startsWith('gemini/') && !model.startsWith('google/')) {
      resolvedModel = `gemini/${model}`;
    }


    // Same capable-provider logic as execInContainer:
    // cloud providers + any Ollama model explicitly marked is_capable=true in the DB.
    const CAPABLE_PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter'];
    const isCapable = CAPABLE_PROVIDERS.includes(provider) || !!modelConfig?.is_capable;

    // Same provider-specific routing logic as execInContainer:
    //   google → GOOGLE_API_KEY (native Gemini support, not Anthropic-compatible)
    //   others → ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
    let providerEnvArgs;
    if (provider === 'google') {
      providerEnvArgs = [
        `GOOGLE_API_KEY=${apiKey}`,
      ];
    } else {
      providerEnvArgs = [
        `ANTHROPIC_BASE_URL=${apiEndpoint}`,
        `ANTHROPIC_API_KEY=${apiKey}`,
      ];
    }

    // Same MAX_AGENT_TURNS / MAX_AGENT_TURNS_LOCAL cap as execInContainer.
    // Non-capable models (Ollama/local) are capped to prevent expensive
    // runaway skill-call loops (e.g. gpt-oss calling Skill 16 times = 493K tokens).
    const maxTurnsEnvStream = Math.max(1, parseInt(process.env.MAX_AGENT_TURNS, 10) || 15);
    const maxTurnsLocalEnvStream = Math.max(1, parseInt(process.env.MAX_AGENT_TURNS_LOCAL, 10) || 3);
    const maxTurnsStream = isCapable ? maxTurnsEnvStream : Math.min(maxTurnsEnvStream, maxTurnsLocalEnvStream);

    const args = [
      'exec', '-i',
      containerName,
      'env',
      ...providerEnvArgs,
      'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', // activates Task tool in all containers
      'claude',
      '-p',
      '--model', resolvedModel,
      '--dangerously-skip-permissions',
      '--max-turns', String(maxTurnsStream), // Cap tool-call rounds to prevent runaway chains
    ];

    // Capable models: append to native prompt; weak models: replace it
    if (systemContext) {
      if (isCapable) {
        args.push('--append-system-prompt', systemContext);
      } else {
        args.push('--system-prompt', systemContext);
      }
    }

    // Add --output-format stream-json to get rich JSON event stream.
    // stream-json requires --verbose when used with -p (print mode).
    // This outputs newline-delimited JSON events: text blocks, tool calls, and a final result.
    if (options.streamJson) {
      args.push('--output-format', 'stream-json');
      args.push('--verbose');
    }

    // MCP server config — enables Claude Code to call external MCP tool servers
    if (modelConfig?.mcpConfig) {
      args.push('--mcp-config', modelConfig.mcpConfig);
    }

    console.log(`[ContainerManager] Streaming exec — model: ${model}, provider: ${provider}, endpoint: ${apiEndpoint}, streamJson: ${!!options.streamJson}`);

    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, {
        // No shell, no maxBuffer limit — we stream manually
      });

      let stdout = '';
      let stderr = '';
      let settled = false; // Prevent double-settle race condition
      let lastDataTime = Date.now(); // Track last data received for stall detection

      // Track this stream so it can be stopped by the user
      if (userId) {
        this._activeStreams.set(userId, { child, reject: (err) => {
          if (!settled) { settled = true; reject(err); }
        }});
      }

      child.stdout.on('data', (buf) => {
        const text = buf.toString();
        stdout += text;
        lastDataTime = Date.now(); // Reset stall timer on any data
        if (onChunk) onChunk(text);
      });

      child.stderr.on('data', (buf) => {
        stderr += buf.toString();
        lastDataTime = Date.now(); // stderr is also activity
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        clearTimeout(timeout);
        if (userId) this._activeStreams.delete(userId);
        reject({ error: err, stderr });
      });

      child.on('close', (code) => {
        if (userId) this._activeStreams.delete(userId);
        clearInterval(stallCheck);
        clearTimeout(timeout);
        console.log(`[ContainerManager] Stream closed — stdout: ${stdout.length} chars, code: ${code}`);
        if (stderr) console.warn(`[ContainerManager] Stream stderr:`, stderr.substring(0, 500));
        if (settled) return; // Already rejected (timeout or stop)
        settled = true;
        if (code !== 0 && !stdout.trim()) {
          reject({ error: new Error(`Process exited with code ${code}`), stderr });
        } else {
          resolve({ stdout, stderr });
        }
      });

      // Stall detection: if no stdout/stderr arrives for STALL_TIMEOUT_SECONDS, kill the process.
      // Configurable via STALL_TIMEOUT_SECONDS in .env (default: 300s / 5 minutes).
      // Increase for heavy data processing tasks (large CSV/Excel analysis, ML training, etc.)
      const STALL_TIMEOUT_MS = Math.max(60, parseInt(process.env.STALL_TIMEOUT_SECONDS, 10) || 300) * 1000;
      const stallCheck = setInterval(() => {
        if (settled) { clearInterval(stallCheck); return; }
        const elapsed = Date.now() - lastDataTime;
        if (elapsed > STALL_TIMEOUT_MS) {
          clearInterval(stallCheck);
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          console.warn(`[ContainerManager] Stream stalled (${Math.round(elapsed/1000)}s without output) — killing process`);
          if (userId) this._activeStreams.delete(userId);
          try { child.kill('SIGTERM'); } catch (_) {}
          reject({ error: Object.assign(new Error('Stream stalled — no output for 3 minutes'), { killed: true }), stderr, stdout });
        }
      }, 30000); // Check every 30 seconds

      // Hard 30-minute timeout (absolute ceiling for very long tasks)
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearInterval(stallCheck);
        if (userId) this._activeStreams.delete(userId);
        child.kill('SIGTERM');
        reject({ error: Object.assign(new Error('Stream timed out after 30 minutes'), { killed: true }), stderr, stdout });
      }, 1800000); // 30 minutes

      // Pipe message via stdin and close it
      child.stdin.write(message);
      child.stdin.end();
    });
  }

  /**
   * Stop an active streaming process for a user.
   * Returns the partial stdout collected so far, or null if no active stream.
   */
  stopStream(userId) {
    const entry = this._activeStreams.get(userId);
    if (!entry) return null;
    console.log(`[ContainerManager] Stopping stream for user ${userId}`);
    try {
      entry.child.kill('SIGTERM');
    } catch (e) {
      console.warn(`[ContainerManager] Error killing stream:`, e.message);
    }
    this._activeStreams.delete(userId);
    return true;
  }

  /**
   * Check if a user has an active streaming process.
   */
  hasActiveStream(userId) {
    return this._activeStreams.has(userId);
  }

  /**
   * Stop and remove a user's container.
   */
  async removeContainer(userId) {
    const containerName = `claude-agent-user-${userId}`;
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: 'pipe' });
    } catch (e) {
      // Container may not exist
    }
    this.containers.delete(userId);
  }

  /**
   * Remove containers idle beyond TIMEOUT_MS.
   */
  cleanupInactive() {
    const now = Date.now();
    for (const [userId, entry] of this.containers.entries()) {
      if (now - entry.lastActivity > this.TIMEOUT_MS) {
        console.log(`[ContainerManager] Cleaning up inactive container for user ${userId}`);
        this.removeContainer(userId);
      }
    }
  }

  /**
   * Remove ALL managed containers (graceful shutdown).
   */
  async shutdown() {
    clearInterval(this.cleanupInterval);
    for (const [userId] of this.containers.entries()) {
      await this.removeContainer(userId);
    }
  }

  /**
   * Remove any orphaned claude-agent-user-* containers from a previous run.
   */
  cleanupOrphaned() {
    try {
      const result = execSync(
        'docker ps -a --filter "name=claude-agent-user-" --format "{{.Names}}"',
        { stdio: 'pipe' }
      ).toString().trim();
      const names = result.split('\n').filter(Boolean);
      for (const name of names) {
        console.log(`[ContainerManager] Removing orphaned container: ${name}`);
        try { execSync(`docker rm -f ${name}`, { stdio: 'pipe' }); } catch {}
      }
    } catch {}
  }

  /**
   * Create the user's workspace folder with permissions for UID 1000 (node user in agent image).
   */
  ensureUserFolder(userId) {
    const userDir = `/srv/claude/users/${userId}`;

    // User-visible folders — surfaced in UI
    const inputDir   = `${userDir}/input`;
    const outputDir  = `${userDir}/output`;

    // Internal agent folders — NOT visible in UI, NOT scanned by snapshotConversationFiles.
    // agent_input:  orchestrator writes shared context/reference files before spawning agents.
    // agent_output: phase-1 parallel agents write structured JSON results here.
    //               synthesis agent reads from here. Cleaned up after synthesis completes.
    const agentInputDir  = `${userDir}/agent_input`;
    const agentOutputDir = `${userDir}/agent_output`;

    let created = false;
    for (const dir of [userDir, inputDir, outputDir, agentInputDir, agentOutputDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created = true;
      }
    }
    if (created) {
      try {
        execSync(`chown -R 1000:1000 ${userDir}`, { stdio: 'pipe' });
      } catch (e) {
        console.warn(`[ContainerManager] Could not chown ${userDir}:`, e.message);
      }
    }
  }

  /**
   * Clear agent_input and agent_output folders after a team run completes.
   * Called by agentTeamManager after synthesis finishes.
   * User-visible input/ and output/ are NOT touched.
   */
  cleanAgentFolders(userId) {
    const userDir = `/srv/claude/users/${userId}`;
    for (const folder of ['agent_input', 'agent_output']) {
      const dir = `${userDir}/${folder}`;
      if (!fs.existsSync(dir)) continue;
      try {
        for (const f of fs.readdirSync(dir)) {
          try { fs.unlinkSync(`${dir}/${f}`); } catch {}
        }
        console.log(`[ContainerManager] Cleaned ${folder}/ for user ${userId}`);
      } catch (e) {
        console.warn(`[ContainerManager] Could not clean ${folder}/:`, e.message);
      }
    }
  }

  /**
   * Write a file inside a container. Uses base64 to avoid escaping issues.
   * Path MUST be within /home/node/app/workspace/ — validated here to prevent
   * path traversal and files landing outside the user's workspace.
   */
  writeFileInContainer(containerName, filePath, content) {
    const WORKSPACE = '/home/node/app/workspace/';
    // Hard enforcement: resolve the path and reject anything outside the workspace.
    // This is the last line of defense against path traversal or accidental misrouting.
    const nodePath = require('path');
    const resolved = nodePath.resolve(filePath);
    if (!resolved.startsWith(WORKSPACE)) {
      return Promise.reject(new Error(
        `[Security] Path '${filePath}' is outside the allowed workspace (${WORKSPACE}). Write rejected.`
      ));
    }

    // Run as root (-u 0) to avoid permission issues on Windows volume mounts,
    // then chown back to node user (1000) so the agent can modify later.
    const script = 'const fs=require("fs"),p=require("path");' +
      'fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});' +
      'fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"));' +
      'try{fs.chownSync(process.argv[1],1000,1000);}catch{}';

    return new Promise((resolve, reject) => {
      execFile('docker', [
        'exec', '-u', '0', containerName,
        'node', '-e', script,
        filePath,
        Buffer.from(content).toString('base64')
      ], { timeout: 10000 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Check if the model endpoint is reachable from inside a container.
   * Accepts an explicit endpoint URL (falls back to container env var) and an
   * optional provider name.  External cloud providers (openai, anthropic,
   * google, groq, openrouter) are assumed to be reachable — their root URLs
   * don't return HTTP 200, so a TCP check would produce false negatives.
   * Handles both HTTP and HTTPS URLs.
   * Returns { ok: true } or { ok: false, reason: string }.
   */
  async checkOllamaHealth(containerName, endpoint = null, provider = null) {
    // External cloud APIs don't expose a simple GET / that returns 200.
    // Skip the connectivity probe and trust that the API key / model name
    // are the real problem when those calls fail.
    const EXTERNAL_PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter'];
    if (provider && EXTERNAL_PROVIDERS.includes(provider.toLowerCase())) {
      console.log(`[ContainerManager] Skipping health check for external provider: ${provider}`);
      return { ok: true };
    }

    try {
      const url = endpoint || 'http://host.docker.internal:11434';
      const mod = url.startsWith('https') ? 'https' : 'http';
      const result = await this.runCommandInContainer(
        containerName,
        `node -e "require('${mod}').get('${url}', r => { process.stdout.write(String(r.statusCode)); process.exit(0); }).on('error', e => { process.stdout.write(e.message); process.exit(1); })"`
      );
      if (result === '200') return { ok: true };
      return { ok: false, reason: `Endpoint returned: ${result}` };
    } catch (e) {
      return { ok: false, reason: e.output || e.message || 'Connection failed' };
    }
  }

  /**
   * Run a shell command inside a container. Returns stdout.
   */
  runCommandInContainer(containerName, command) {
    return new Promise((resolve, reject) => {
      execFile('docker', [
        'exec', containerName,
        'sh', '-c', command
      ], { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // Preserve stdout/stderr in the error so callers can see the actual output
          err.output = (stdout || stderr || '').trim();
          return reject(err);
        }
        resolve((stdout || stderr || '').trim());
      });
    });
  }

  // --- Private helpers ---

  async _create(userId, containerName) {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
    // Use host paths for volume mounts — the Docker daemon resolves paths on
    // the host, not inside this container, so we need the actual host paths.
    const hostUserPath = process.env.HOST_USER_DATA_PATH || 'C:/claude_data/users';
    const hostSkillsPath = process.env.HOST_SKILLS_PATH || 'C:/claude_data/skills';

    // AGENT_IMAGE env var allows different editions to use different images:
    //   Enterprise: claude-agent-image (default)
    //   Community:  claude-agent-image-community
    const agentImage = process.env.AGENT_IMAGE || 'claude-agent-image';

    const cmd = `docker create \
      --name ${containerName} \
      --entrypoint sleep \
      --memory 512m --cpus 0.5 --pids-limit 100 \
      -v ${hostSkillsPath}:/home/node/app/.claude/skills:ro \
      -v ${hostUserPath}/${userId}:/home/node/app/workspace:rw \
      -e ANTHROPIC_BASE_URL=${ollamaUrl} \
      -e ANTHROPIC_API_KEY=dummy-key \
      ${agentImage} \
      infinity`;

    return new Promise((resolve, reject) => {
      exec(cmd, (err) => {
        if (err) return reject(err);
        exec(`docker start ${containerName}`, (err2) => {
          if (err2) return reject(err2);
          resolve(containerName);
        });
      });
    });
  }

  _isRunning(containerName) {
    try {
      const result = execSync(
        `docker inspect -f "{{.State.Running}}" ${containerName}`,
        { stdio: 'pipe' }
      ).toString().trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  _exists(containerName) {
    try {
      execSync(`docker inspect ${containerName}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  _start(containerName) {
    execSync(`docker start ${containerName}`, { stdio: 'pipe' });
  }
}

module.exports = ContainerManager;
