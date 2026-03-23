/**
 * pluginManager.js
 * ============================================================
 * Manages plugins and MCP server tools alongside skills.
 *
 * Directory layout (mirrors skills):
 *   /srv/claude/plugins/<name>/PLUGIN.md     — plugin manifest
 *   /srv/claude/plugins/<name>/mcp.json      — optional MCP server config
 *   /srv/claude/mcp-servers/<name>.json      — standalone MCP server definitions
 *
 * Plugin vs Skill vs MCP
 * ──────────────────────
 *   Skill  — a markdown file injected into the system prompt (prompt engineering)
 *   Plugin — same as skill PLUS optional MCP server config (tools)
 *   MCP    — a running server that exposes tools to Claude via JSON-RPC
 *
 * MCP server config format (mcp.json or mcp-servers/*.json)
 * ─────────────────────────────────────────────────────────
 *   {
 *     "name": "filesystem",
 *     "type": "stdio",                 // "stdio" | "sse" | "http"
 *     "command": "npx",                // for stdio
 *     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
 *     "env": { "KEY": "value" },       // optional env vars
 *     "url": "http://localhost:3001"   // for sse/http
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PLUGINS_DIR     = process.env.HOST_PLUGINS_PATH ? '/srv/claude/plugins' : '/srv/claude/plugins';
const MCP_SERVERS_DIR = '/srv/claude/mcp-servers';

class PluginManager {
  constructor() {
    this._pluginCache    = new Map(); // name -> { name, description, category, mcpConfig }
    this._mcpServerCache = new Map(); // name -> mcpServerConfig
  }

  // ─────────────────────────────────────────────────────────
  // PLUGINS
  // ─────────────────────────────────────────────────────────

  /** Scan plugins directory and return all plugin metadata. */
  loadAllPlugins() {
    const plugins = [];

    // Load plugins from /srv/claude/plugins/
    if (fs.existsSync(PLUGINS_DIR)) {
      let dirs = [];
      try { dirs = fs.readdirSync(PLUGINS_DIR); } catch {}

      for (const dir of dirs) {
        const pluginPath = path.join(PLUGINS_DIR, dir);
        try {
          if (!fs.statSync(pluginPath).isDirectory()) continue;

          // Try PLUGIN.md first, then SKILL.md for backwards compatibility
          let manifestPath = path.join(pluginPath, 'PLUGIN.md');
          if (!fs.existsSync(manifestPath)) {
            manifestPath = path.join(pluginPath, 'SKILL.md');
          }
          if (!fs.existsSync(manifestPath)) continue;

          const content  = fs.readFileSync(manifestPath, 'utf-8');
          const fm       = this._parseFrontmatter(content);
          const name     = fm.name || dir;
          const description = fm.description || '';
          const category = fm.category || 'Plugin';

          // Load optional MCP server config
          let mcpConfig = null;
          const mcpPath = path.join(pluginPath, 'mcp.json');
          if (fs.existsSync(mcpPath)) {
            try { mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')); } catch {}
          }

          const plugin = { name, description, category, mcpConfig, manifestPath, pluginPath };
          plugins.push(plugin);
          this._pluginCache.set(name, plugin);
        } catch (err) {
          console.warn(`[PluginManager] Error loading plugin '${dir}':`, err.message);
        }
      }
    }

    // Also scan /srv/claude/mcp-servers/ for standalone MCP definitions
    this._loadStandaloneMcpServers();

    plugins.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return plugins;
  }

  /** Load standalone MCP server JSON files from /srv/claude/mcp-servers/. */
  _loadStandaloneMcpServers() {
    if (!fs.existsSync(MCP_SERVERS_DIR)) return;
    let files = [];
    try { files = fs.readdirSync(MCP_SERVERS_DIR); } catch {}

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const config = JSON.parse(fs.readFileSync(path.join(MCP_SERVERS_DIR, file), 'utf-8'));
        const name   = config.name || path.basename(file, '.json');
        this._mcpServerCache.set(name, config);
        console.log(`[PluginManager] Loaded MCP server: ${name}`);
      } catch (err) {
        console.warn(`[PluginManager] Error loading MCP server '${file}':`, err.message);
      }
    }
  }

  /** Get plugin by name (with cache refresh if needed). */
  getPlugin(name) {
    if (this._pluginCache.size === 0) this.loadAllPlugins();
    return this._pluginCache.get(name) || null;
  }

  // ─────────────────────────────────────────────────────────
  // PROMPT INJECTION
  // ─────────────────────────────────────────────────────────

  /**
   * Build the plugins section to append to the system prompt.
   * Mirrors the skills prompt injection pattern.
   * @param {string[]} enabledPluginNames
   */
  getEnabledPluginsPrompt(enabledPluginNames) {
    if (!enabledPluginNames || !enabledPluginNames.length) return '';
    if (this._pluginCache.size === 0) this.loadAllPlugins();

    const lines = enabledPluginNames.map(n => {
      const p = this._pluginCache.get(n);
      if (!p) return `- [${n}]`;
      const desc = p.description.length > 120 ? p.description.substring(0, 120) + '...' : p.description;
      const mcpNote = p.mcpConfig ? ' [MCP tools available]' : '';
      return `- [${p.name}]${mcpNote}: ${desc}`;
    });

    return [
      '',
      '=== AVAILABLE PLUGINS ===',
      'The following plugins are enabled. Activate them when the user\'s request matches:',
      ...lines,
      '',
      'Plugins marked [MCP tools available] provide additional tools via MCP server.',
      'Only use plugins from this list.',
      '=== END PLUGINS ===',
    ].join('\n');
  }

  // ─────────────────────────────────────────────────────────
  // MCP SERVER CONFIG FOR CLAUDE CODE CLI
  // ─────────────────────────────────────────────────────────

  /**
   * Build the --mcp-config argument JSON for Claude Code CLI.
   * Merges MCP configs from:
   *   1. Enabled plugins that have mcp.json
   *   2. Standalone MCP server definitions
   *   3. User-level MCP server overrides (from DB)
   *
   * Returns null if no MCP servers are configured.
   *
   * @param {string[]} enabledPluginNames
   * @param {object[]} userMcpServers   — from DB: [{ name, type, command, args, url, env }]
   * @returns {string|null}             — JSON string for --mcp-config, or null
   */
  buildMcpConfigArg(enabledPluginNames = [], userMcpServers = []) {
    const mcpServers = {};

    // 1. Standalone MCP servers (always available if defined)
    for (const [name, config] of this._mcpServerCache.entries()) {
      mcpServers[name] = this._normaliseMcpEntry(config);
    }

    // 2. Plugin MCP configs
    if (enabledPluginNames.length) {
      if (this._pluginCache.size === 0) this.loadAllPlugins();
      for (const n of enabledPluginNames) {
        const plugin = this._pluginCache.get(n);
        if (plugin?.mcpConfig) {
          const serverName = plugin.mcpConfig.name || n;
          mcpServers[serverName] = this._normaliseMcpEntry(plugin.mcpConfig);
        }
      }
    }

    // 3. User-level MCP overrides from DB (highest priority)
    for (const srv of userMcpServers) {
      if (!srv.name) continue;
      mcpServers[srv.name] = this._normaliseMcpEntry(srv);
    }

    if (!Object.keys(mcpServers).length) return null;

    // Claude Code CLI --mcp-config format:
    // { "mcpServers": { "<name>": { "command": "...", "args": [...] } } }
    return JSON.stringify({ mcpServers });
  }

  /** Normalise an MCP server entry to the Claude Code CLI format. */
  _normaliseMcpEntry(raw) {
    const entry = {};
    if (raw.type === 'sse' || raw.type === 'http' || raw.url) {
      entry.type = raw.type || 'sse';
      entry.url  = raw.url;
    } else {
      // stdio is the default
      entry.command = raw.command || 'npx';
      entry.args    = raw.args    || [];
    }
    if (raw.env && typeof raw.env === 'object') {
      entry.env = raw.env;
    }
    return entry;
  }

  // ─────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────

  _parseFrontmatter(content) {
    const match = content.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
    if (!match) return {};
    const result = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key   = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  }

  /** Read the full manifest text for a plugin (for skill-style injection). */
  readPluginManifest(name) {
    const plugin = this.getPlugin(name);
    if (!plugin) return null;
    try { return fs.readFileSync(plugin.manifestPath, 'utf-8'); } catch { return null; }
  }

  /** List all available MCP server names. */
  listMcpServers() {
    if (this._pluginCache.size === 0) this.loadAllPlugins();
    const servers = new Set(this._mcpServerCache.keys());
    for (const [, plugin] of this._pluginCache.entries()) {
      if (plugin.mcpConfig?.name) servers.add(plugin.mcpConfig.name);
    }
    return [...servers];
  }
}

module.exports = new PluginManager(); // singleton
