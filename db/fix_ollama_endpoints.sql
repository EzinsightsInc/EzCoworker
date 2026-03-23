-- Fix Ollama API Endpoints - Run this if you have an existing installation
-- This script removes the incorrect /api/chat suffix from Ollama endpoints

-- Update existing model configurations to remove /api/chat
UPDATE model_configs
SET 
    api_endpoint = REPLACE(api_endpoint, '/api/chat', ''),
    updated_at = NOW()
WHERE 
    provider = 'ollama' 
    AND api_endpoint LIKE '%/api/chat%';

-- Update descriptions to clarify these are local
UPDATE model_configs
SET 
    description = REPLACE(description, 'Remote Ollama', 'Local Ollama'),
    updated_at = NOW()
WHERE 
    provider = 'ollama' 
    AND description LIKE '%Remote Ollama%';

-- Verify the fix
SELECT 
    id,
    name,
    provider,
    api_endpoint,
    model_identifier,
    is_active
FROM model_configs
WHERE provider = 'ollama'
ORDER BY id;

-- Expected output: All api_endpoint values should be:
-- http://host.docker.internal:11434 (or :4000 for the custom one)
-- WITHOUT /api/chat at the end
