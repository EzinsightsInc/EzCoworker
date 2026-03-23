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
 * Sync external API providers from .env
 */
async function syncExternalProviders(pool) {
  console.log('[ModelSync] Syncing external API providers...');
  
  const providers = [
    {
      name: 'OpenAI',
      envPrefix: 'OPENAI',
      defaultUrl: 'https://api.openai.com/v1',
      defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
    },
    {
      name: 'Anthropic',
      envPrefix: 'ANTHROPIC',
      defaultUrl: 'https://api.anthropic.com',
      defaultModels: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229']
    },
    {
      name: 'Google',
      envPrefix: 'GOOGLE',
      defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
      // Updated Feb 2026: gemini-2.0-flash-exp removed, 1.5 models deprecated
      defaultModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']
    },
    {
      name: 'Groq',
      envPrefix: 'GROQ',
      defaultUrl: 'https://api.groq.com/openai/v1',
      defaultModels: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768']
    },
    {
      name: 'OpenRouter',
      envPrefix: 'OPENROUTER',
      defaultUrl: 'https://openrouter.ai/api/v1',
      defaultModels: ['anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-exp']
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
      
      if (existing.rows.length === 0) {
        await pool.query(`
          INSERT INTO model_configs (name, description, provider, api_endpoint, model_identifier, requires_api_key, default_api_key, is_active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [displayName, description, providerKey, apiUrl, model, true, apiKey, true]);
        console.log(`[ModelSync] ✅ Added: ${provider.name} - ${model}`);
      } else {
        await pool.query(`
          UPDATE model_configs 
          SET api_endpoint = $1, default_api_key = $2, is_active = true, updated_at = NOW()
          WHERE model_identifier = $3 AND provider = $4
        `, [apiUrl, apiKey, model, providerKey]);
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
