// ============================================
// AUTOMATIC MODEL DISCOVERY SYSTEM
// ============================================
// Auto-discovers:
// 1. All Ollama models on local machine
// 2. External API providers from .env (OpenAI, Claude, Gemini, etc.)

const axios = require('axios');

/**
 * Sync Ollama models from local instance
 */
async function syncOllamaModels(pool) {
  console.log('[ModelSync] Syncing Ollama models...');
  
  const ollamaUrl = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
  
  try {
    const response = await axios.get(`${ollamaUrl}/api/tags`, { timeout: 5000 });
    
    if (!response.data || !response.data.models) {
      console.warn('[ModelSync] No models found in Ollama');
      return;
    }
    
    const ollamaModels = response.data.models;
    console.log(`[ModelSync] Found ${ollamaModels.length} Ollama models`);
    
    const activeOllamaIds = [];

    // Preserve and auto-insert cloud models that never appear in /api/tags
    const OLLAMA_CLOUD_MODELS = [
      { id: 'gpt-oss:120b-cloud',          name: 'Ollama GPT OSS 120b cloud' },
      { id: 'gpt-oss:20b-cloud',           name: 'Ollama GPT OSS 20b cloud' },
      { id: 'gpt-oss:20b',                 name: 'Ollama GPT OSS 20b' },
      { id: 'gpt-oss:latest',              name: 'Ollama GPT OSS latest' },
      { id: 'deepseek-v3.1:671b-cloud',    name: 'Ollama Deepseek V3.1 671b cloud' },
      { id: 'qwen3-coder:480b-cloud',      name: 'Ollama QWEN3 Coder 480b cloud' },
      { id: 'qwen3-vl:235b-cloud',         name: 'Ollama QWEN3 VL 235b cloud' },
      { id: 'minimax-m2:cloud',            name: 'Ollama Minimax M2 cloud' },
      { id: 'glm-4.6:cloud',              name: 'Ollama GLM 4.6 cloud' },
      { id: 'lfm2.5-thinking:latest',      name: 'Ollama LFM2.5 Thinking latest' },
      { id: 'qwen2.5-coder:7b',            name: 'Ollama QWEN2.5 Coder 7b' },
      { id: 'qwen3-coder:30b',             name: 'Ollama QWEN3 Coder 30b' },
      { id: 'deepseek-r1:8b',              name: 'Ollama Deepseek R1 8b' },
    ];
    for (const model of OLLAMA_CLOUD_MODELS) {
      const existing = await pool.query(
        'SELECT id FROM model_configs WHERE model_identifier = $1 AND provider = $2',
        [model.id, 'ollama']
      );
      if (existing.rows.length === 0) {
        const ins = await pool.query(`
          INSERT INTO model_configs (name, description, provider, api_endpoint, model_identifier, requires_api_key, default_api_key, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
        `, [model.name, `Ollama cloud: ${model.id}`, 'ollama', ollamaUrl, model.id, false, 'dummy-key', true]);
        activeOllamaIds.push(ins.rows[0].id);
        console.log(`[ModelSync] ✅ Added cloud model: ${model.id}`);
      } else {
        await pool.query(
          `UPDATE model_configs SET is_active = true, updated_at = NOW() WHERE id = $1`,
          [existing.rows[0].id]
        );
        activeOllamaIds.push(existing.rows[0].id);
      }
    }

    for (const model of ollamaModels) {
      const modelName = model.name;
      const modelSize = model.size ? `${(model.size / 1024 / 1024 / 1024).toFixed(1)}GB` : '';
      const modelFamily = modelName.split(':')[0];
      const version = modelName.split(':')[1] || 'latest';
      
      const displayName = `Ollama ${modelFamily.replace(/-/g, ' ').toUpperCase()} ${version}`;
      const description = `Local Ollama: ${modelName}${modelSize ? ` (${modelSize})` : ''}`;
      
      const existing = await pool.query(
        'SELECT id FROM model_configs WHERE model_identifier = $1 AND provider = $2',
        [modelName, 'ollama']
      );
      
      if (existing.rows.length === 0) {
        const ins = await pool.query(`
          INSERT INTO model_configs (name, description, provider, api_endpoint, model_identifier, requires_api_key, default_api_key, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
        `, [displayName, description, 'ollama', ollamaUrl, modelName, false, 'dummy-key', true]);
        activeOllamaIds.push(ins.rows[0].id);
        console.log(`[ModelSync] ✅ Added: ${modelName}`);
      } else {
        await pool.query(`
          UPDATE model_configs 
          SET description = $1, api_endpoint = $2, is_active = true, updated_at = NOW()
          WHERE model_identifier = $3 AND provider = $4
        `, [description, ollamaUrl, modelName, 'ollama']);
        activeOllamaIds.push(existing.rows[0].id);
      }
    }

    // Deactivate Ollama models no longer present in Ollama
    if (activeOllamaIds.length > 0) {
      const deactivated = await pool.query(
        `UPDATE model_configs SET is_active = false, updated_at = NOW()
         WHERE provider = 'ollama' AND is_active = true AND id != ALL($1::int[])`,
        [activeOllamaIds]
      );
      if (deactivated.rowCount > 0) {
        console.log(`[ModelSync] 🗑️  Deactivated ${deactivated.rowCount} removed Ollama model(s)`);
      }
    }
    
  } catch (err) {
    console.error('[ModelSync] Ollama sync failed:', err.message);
  }
}

/**
 * Determine if a model supports image input (vision).
 * Source: official provider docs (March 2026)
 * - All Anthropic Claude 4.x: yes
 * - All Gemini models: yes (natively multimodal)
 * - OpenAI: all except o3 and o1 (text-only reasoning models)
 * - Groq / OpenRouter: assume yes (served models generally support vision)
 * - Ollama: no by default (admin can enable manually)
 */
/**
 * Determine if a model does its own chain-of-thought reasoning.
 * Reasoning models think before responding — this improves response quality
 * for complex tasks, complementing Claude Code CLI's own agentic loop.
 * This flag is for UI display and admin insight only — we never send
 * reasoning_effort params to any model (LiteLLM drops them globally).
 */
function modelIsReasoning(provider, modelIdentifier) {
  const p  = (provider || '').toLowerCase();
  const id = (modelIdentifier || '').toLowerCase();
  if (p === 'openai')     return /^o1|^o3|^o4/.test(id);
  if (p === 'google')     return /gemini-(2\.5-pro|3)/.test(id);
  if (p === 'anthropic')  return /claude-(sonnet-4-5|sonnet-4-6|opus-4)/.test(id);
  return false;
}

function modelHasVision(provider, modelIdentifier) {
  const p  = (provider || '').toLowerCase();
  const id = (modelIdentifier || '').toLowerCase();
  if (p === 'ollama') return false;
  if (p === 'openai') return !/^o3|^o1(?!-)/.test(id); // o3 and o1 are text-only
  return true; // anthropic, google, groq, openrouter — all support vision
}

/**
 * Sync external API providers from .env
 */
async function syncExternalProviders(pool) {
  console.log('[ModelSync] Syncing external API providers...');
  
  // ── LiteLLM proxy endpoint — all non-Ollama/Anthropic providers route through here
  // Model identifiers must match model_name aliases in litellm_config.yaml
  const litellmUrl = process.env.LITELLM_URL || 'http://litellm:4000';

  const providers = [
    {
      // OpenAI models — routed via LiteLLM proxy
      // Model IDs match litellm_config.yaml aliases (bare names, no openai/ prefix)
      // Source: https://platform.openai.com/docs/models (March 2026)
      name: 'OpenAI',
      envPrefix: 'OPENAI',
      defaultUrl: litellmUrl,
      defaultModels: [
        'gpt-4o',          // GPT-4o — multimodal flagship
        'gpt-4o-mini',     // GPT-4o Mini — fast, affordable
        'gpt-4.1',         // GPT-4.1 — best coding + instruction following
        'gpt-4.1-mini',    // GPT-4.1 Mini — efficient, near 4.1 quality
        'gpt-4.1-nano',    // GPT-4.1 Nano — lowest cost
        'o3',              // o3 — deep reasoning
        'o4-mini',         // o4-mini — fast reasoning, best-in-class STEM
      ]
    },
    {
      // Anthropic models — routed directly (not via LiteLLM)
      // Source: https://docs.anthropic.com/en/docs/about-claude/models/overview (March 2026)
      name: 'Anthropic',
      envPrefix: 'ANTHROPIC',
      defaultUrl: 'https://api.anthropic.com',
      defaultModels: [
        'claude-opus-4-6',          // Opus 4.6 — most intelligent, 1M context, agents
        'claude-sonnet-4-6',        // Sonnet 4.6 — best speed/intelligence balance
        'claude-sonnet-4-5-20250929', // Sonnet 4.5 — previous generation
        'claude-haiku-4-5-20251001',  // Haiku 4.5 — fastest, near-frontier, cheapest
      ]
    },
    {
      // Gemini models — routed via LiteLLM proxy
      // Model IDs match litellm_config.yaml aliases (bare names, no gemini/ prefix)
      // Source: https://ai.google.dev/gemini-api/docs/models (March 2026)
      // Note: gemini-3-pro-preview shut down Mar 9 2026, use gemini-3.1-pro-preview
      //       gemini-2.0-flash retiring Jun 1 2026
      name: 'Google',
      envPrefix: 'GEMINI',
      defaultUrl: litellmUrl,
      defaultModels: [
        'gemini-2.5-pro',            // Gemini 2.5 Pro — most capable, GA
        'gemini-2.5-flash',          // Gemini 2.5 Flash — fast + smart, GA
        'gemini-2.5-flash-lite',     // Gemini 2.5 Flash-Lite — cost-efficient, GA
        'gemini-3-flash-preview',    // Gemini 3 Flash — frontier-class at Flash speed/price
        'gemini-3.1-pro-preview',    // Gemini 3.1 Pro — latest reasoning-first model
      ]
    },
    {
      // Groq models — routed via LiteLLM proxy
      // Source: https://console.groq.com/docs/models (March 2026)
      name: 'Groq',
      envPrefix: 'GROQ',
      defaultUrl: litellmUrl,
      defaultModels: [
        'llama-3.3-70b-versatile',  // Best Groq model for general tasks
        'llama-3.1-8b-instant',     // Ultra-fast, low latency
      ]
    },
    {
      // OpenRouter — access to hundreds of models via one key
      // Model IDs use provider/model format as OpenRouter expects
      name: 'OpenRouter',
      envPrefix: 'OPENROUTER',
      defaultUrl: litellmUrl,
      defaultModels: [
        'anthropic/claude-sonnet-4-6',
        'openai/gpt-4o',
        'google/gemini-2.5-pro',
        'meta-llama/llama-3.3-70b-instruct',
      ]
    }
  ];
  
  // Track all model identifiers that should be active, grouped by provider
  const activeByProvider = {};

  for (const provider of providers) {
    const providerKey = provider.name.toLowerCase();
    const apiKey = process.env[`${provider.envPrefix}_API_KEY`];
    
    if (!apiKey) {
      console.log(`[ModelSync] ⏭️  Skipping ${provider.name} (no API key)`);
      // No API key → deactivate ALL models for this provider
      const deactivated = await pool.query(
        `UPDATE model_configs SET is_active = false, updated_at = NOW()
         WHERE provider = $1 AND is_active = true`,
        [providerKey]
      );
      if (deactivated.rowCount > 0) {
        console.log(`[ModelSync] 🗑️  Deactivated ${deactivated.rowCount} ${provider.name} model(s) (no API key)`);
      }
      continue;
    }
    
    const apiUrl = process.env[`${provider.envPrefix}_API_URL`] || provider.defaultUrl;
    const modelsEnv = process.env[`${provider.envPrefix}_MODELS`];
    const models = modelsEnv ? modelsEnv.split(',').map(m => m.trim()) : provider.defaultModels;
    
    console.log(`[ModelSync] ${provider.name}: ${models.length} models`);
    activeByProvider[providerKey] = models;
    
    for (const model of models) {
      const displayName = `${provider.name} ${model.split('/').pop().replace(/-/g, ' ').toUpperCase()}`;
      const description = `${provider.name} API: ${model}`;
      
      const existing = await pool.query(
        'SELECT id FROM model_configs WHERE model_identifier = $1 AND provider = $2',
        [model, providerKey]
      );
      
      const hasVision    = modelHasVision(providerKey, model);
      const isReasoning  = modelIsReasoning(providerKey, model);
      if (existing.rows.length === 0) {
        await pool.query(`
          INSERT INTO model_configs (name, description, provider, api_endpoint, model_identifier, requires_api_key, default_api_key, is_active, has_vision, is_reasoning)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [displayName, description, providerKey, apiUrl, model, true, apiKey, true, hasVision, isReasoning]);
        console.log(`[ModelSync] ✅ Added: ${provider.name} - ${model} (vision: ${hasVision}, reasoning: ${isReasoning})`);
      } else {
        await pool.query(`
          UPDATE model_configs 
          SET api_endpoint = $1, default_api_key = $2, is_active = true, has_vision = $3, is_reasoning = $4, updated_at = NOW()
          WHERE model_identifier = $5 AND provider = $6
        `, [apiUrl, apiKey, hasVision, isReasoning, model, providerKey]);
      }
    }

    // Deactivate models for this provider that are no longer in the configured list
    const deactivated = await pool.query(
      `UPDATE model_configs SET is_active = false, updated_at = NOW()
       WHERE provider = $1 AND is_active = true AND model_identifier != ALL($2::text[])`,
      [providerKey, models]
    );
    if (deactivated.rowCount > 0) {
      console.log(`[ModelSync] 🗑️  Deactivated ${deactivated.rowCount} old ${provider.name} model(s)`);
    }
  }
}

/**
 * Main sync function
 */
async function syncAllModels(pool) {
  console.log('[ModelSync] ========================================');
  console.log('[ModelSync] Auto-discovering models...');
  console.log('[ModelSync] ========================================');
  
  try {
    await syncOllamaModels(pool);
    await syncExternalProviders(pool);
    
    const result = await pool.query(
      'SELECT COUNT(*) as count FROM model_configs WHERE is_active = true'
    );
    
    console.log('[ModelSync] ========================================');
    console.log(`[ModelSync] ✅ Complete! ${result.rows[0].count} models available`);
    console.log('[ModelSync] ========================================');
  } catch (err) {
    console.error('[ModelSync] Failed:', err.message);
  }
}

module.exports = { syncAllModels, syncOllamaModels, syncExternalProviders };
