const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ContainerManager = require('./containerManager');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

// === NEW: Multi-agent team, plugins/MCP, chat platforms, IDE ===
const AgentTeamManager     = require('./agentTeamManager');
const { buildIntentPlan, summarizeExecution, loadExecutionContext, classifyTurnIntent, buildPatchTask, buildExtendContext } = require('./executionPlanner');
const pluginManager        = require('./pluginManager');
const { router: platformRouter, init: initPlatformRouter } = require('./chatPlatformRouter');

// === SKILLS CONFIGURATION ===
const SKILL_CATEGORIES = {
  'Document & File Processing': ['pdf', 'docx', 'pptx', 'xlsx'],
  'Web & Frontend':             ['frontend-design', 'frontend-ui', 'web-artifacts-builder', 'webapp-testing', 'agent-browser', 'ui-visual-validator'],
  'Creative & Design':          ['algorithmic-art', 'canvas-design', 'brand-guidelines', 'theme-factory', 'slack-gif-creator'],
  'DevOps & Infrastructure':    ['docker-patterns', 'schema-migration', 'security-audit', 'grafana-dashboards', 'observability'],
  'Testing & Quality':          ['dev-swarm-code-test', 'test-cases', 'testing-integration', 'persona-testing'],
  'Communication & Docs':       ['doc-coauthoring', 'internal-comms', 'rca-generator'],
  'Development Tools':          ['mcp-builder', 'skill-creator', 'skill-development', 'hook-development'],
  'Business & Analytics':       ['kpi-dashboard-design', 'ceo-command-center', 'deep-research'],
  'Project Management':         ['estimating-work', 'project-estimation'],
};

// In-memory cache: skillName -> { name, description, category }
const skillsCache = new Map();

/** Parse YAML-style frontmatter from SKILL.md content */
function parseSkillFrontmatter(content) {
  const match = content.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Return category name for a skill */
function getSkillCategory(skillName) {
  for (const [category, skills] of Object.entries(SKILL_CATEGORIES)) {
    if (skills.includes(skillName)) return category;
  }
  return 'Other';
}

/** Scan /srv/claude/skills and return list of skill metadata, populating the cache */
function loadAllSkills() {
  const skillsDir = '/srv/claude/skills';
  if (!fs.existsSync(skillsDir)) {
    console.warn('[Skills] Skills directory not found:', skillsDir);
    return [];
  }
  const skills = [];
  let dirs;
  try { dirs = fs.readdirSync(skillsDir); } catch (e) { return []; }
  for (const dir of dirs) {
    const skillPath = path.join(skillsDir, dir);
    try {
      if (!fs.statSync(skillPath).isDirectory()) continue;
      const skillMdPath = path.join(skillPath, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const fm = parseSkillFrontmatter(content);
      const name = fm.name || dir;
      const description = fm.description || '';
      const category = getSkillCategory(name);
      const skill = { name, description, category };
      skills.push(skill);
      skillsCache.set(name, skill);
    } catch (err) {
      console.warn(`[Skills] Error loading skill '${dir}':`, err.message);
    }
  }
  // Sort by category then name
  skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return skills;
}

/**
 * Build the skills section to append to the system prompt.
 * @param {string[]|null} enabledSkillNames - array of enabled skill names, or null/undefined to skip
 */
function getEnabledSkillsPrompt(enabledSkillNames) {
  if (!enabledSkillNames || !Array.isArray(enabledSkillNames)) return '';
  if (skillsCache.size === 0) loadAllSkills();

  if (enabledSkillNames.length === 0) {
    return '\n\n=== SKILLS ===\nNo skills are enabled for this session. Use only your base capabilities without loading any skill.\n=== END SKILLS ===';
  }

  // For large skill sets (>8), use compact names-only format to reduce token usage.
  // Full descriptions are only injected when the set is small enough to be useful.
  const COMPACT_THRESHOLD = 8;
  let lines;
  if (enabledSkillNames.length > COMPACT_THRESHOLD) {
    lines = enabledSkillNames.map(n => `- [${n}]`);
    return `\n\n=== AVAILABLE SKILLS ===\nEnabled skills (load and activate when user's request matches):\n${lines.join('\n')}\n\nOnly use skills from this list.\n=== END SKILLS ===`;
  }

  lines = enabledSkillNames.map(n => {
    const s = skillsCache.get(n);
    if (!s) return `- [${n}]`;
    const desc = s.description.length > 120 ? s.description.substring(0, 120) + '...' : s.description;
    return `- [${s.name}]: ${desc}`;
  });

  return `\n\n=== AVAILABLE SKILLS ===\nThe following skills are enabled for this session. Load and activate them when the user's request matches their description:\n${lines.join('\n')}\n\nOnly use skills from this list. Do not use any skill not listed here.\n=== END SKILLS ===`;
}

// --- File Upload Configuration ---
const ALLOWED_EXTENSIONS = new Set([
  // Code
  '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs',
  '.rb', '.php', '.swift', '.kt', '.dart', '.r', '.m', '.sh', '.sql',
  // Web
  '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.vue', '.jsx', '.tsx', '.svelte',
  // Documents
  '.md', '.txt', '.doc', '.docx', '.pdf',
  // Spreadsheets
  '.xls', '.xlsx', '.csv',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
  // Archives
  '.zip', '.tar', '.gz',
]);
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB
const MAX_FILES = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`File type '${ext}' is not allowed. Supported: code, docs, PDF, Excel, CSV, images.`));
  }
});

// Behavioral instructions for the agent model. Passed via --system-prompt to
// REPLACE Claude Code's native prompt, because the 7b model can't handle
// Claude Code's complex tool definitions and outputs JSON tool calls instead.
const AGENT_INSTRUCTIONS = [
  'You are a helpful coding assistant with a workspace at /home/node/app/workspace.',
  '',
  'CRITICAL: You must TAKE ACTION, not just talk about it!',
  'When the user asks you to create files, analyze data, or write code - DO IT IMMEDIATELY using the syntax below.',
  '',
  '=== CREATING FILES ===',
  'Use this EXACT format (FILE: must be on its own line BEFORE the code block):',
  '',
  'FILE: /home/node/app/workspace/output/example.html',
  '```html',
  '<!DOCTYPE html>',
  '<html>...',
  '```',
  '',
  'IMPORTANT: Put files in /home/node/app/workspace/output/ so the user can download them!',
  '',
  '=== READING FILES ===',
  'To read uploaded files, use:',
  'COMMAND: cat /home/node/app/workspace/input/filename.txt',
  'or',
  'COMMAND: head -20 /home/node/app/workspace/input/data.csv',
  '',
  '=== RUNNING COMMANDS ===',
  'COMMAND: ls /home/node/app/workspace/input',
  'COMMAND: python3 script.py',
  'COMMAND: node app.js',
  '',
  '=== RESPONSE PATTERN ===',
  'Good: "I\'ll create the dashboard for you.',
  'FILE: /home/node/app/workspace/output/dashboard.html',
  '```html',
  '<html>...',
  '```',
  'I\'ve created the dashboard in output/dashboard.html"',
  '',
  'Bad: "I\'ll help you create a dashboard. Let me start by..." (then nothing happens)',
  '',
  '=== WORKSPACE FOLDERS ===',
  '- /home/node/app/workspace/input/ — User uploaded files are HERE. Read from this folder.',
  '- /home/node/app/workspace/output/ — SAVE ALL your created files HERE so user can download them.',
  '- /home/node/app/workspace/ — Temporary workspace for intermediate files.',
  '',
  '=== RULES ===',
  'CRITICAL PATH RULE: ALL created files MUST go in /home/node/app/workspace/output/',
  'NEVER write files to /home/node/app/workspace/ root — ALWAYS use the output/ subfolder.',
  '',
  '=== EFFICIENCY RULES (IMPORTANT) ===',
  'These rules exist because you have a limited number of tool-call rounds. Use them wisely.',
  '',
  '1. DO NOT retry the same command with different timeouts. If a command fails, try a DIFFERENT approach immediately.',
  '2. DO NOT run exploratory ls/find commands to discover tools — assume these are pre-installed:',
  '   - Node.js: xlsx, docx, pptxgenjs, pdf-lib, sharp (npm global packages)',
  '   - Python3: pandas, openpyxl, pypdf, pdfplumber, reportlab, Pillow, python-pptx, python-docx',
  '   - System: python3, pandoc, poppler-utils (pdftotext/pdftoppm/pdfimages), qpdf, tesseract, soffice, curl, jq',
  '3. DO NOT use npm install to install packages — they are already installed globally.',
  '4. For Excel files: use `node -e "const XLSX=require(\'xlsx\')..."` or `python3 -c "import pandas as pd..."` directly.',
  '5. For PDF files: use `pdftotext` (CLI), `python3 -c "import pdfplumber..."` directly.',
  '6. For Word/DOCX: use `node -e "const {Document}=require(\'docx\')..."` or `python3 -c "import docx..."` directly.',
  '7. If one approach fails once, switch to an alternative immediately — do not repeat the same failing approach.',
  '',
  '=== LARGE FILE & LONG-RUNNING TASK RULES ===',
  'These rules prevent stall timeouts when processing large files or running heavy operations.',
  '',
  '1. SAMPLE BEFORE FULL PROCESSING: For files >1MB, always start with head/tail/wc to understand structure',
  '   before running a full-file analysis. Example:',
  '   COMMAND: wc -l /home/node/app/workspace/input/data.csv',
  '   COMMAND: head -20 /home/node/app/workspace/input/data.csv',
  '',
  '2. PRINT PROGRESS DURING LONG OPERATIONS: Always emit print() statements in Python loops so the',
  '   system knows the script is still running. Never let a script run silently for more than 30 seconds.',
  '   Good: `print(f"Processing {len(df)} rows...")` at the start, `print("Done.")` at the end.',
  '',
  '3. USE CHUNKED/STREAMING READS FOR LARGE CSVs (>5MB):',
  '   Instead of: `df = pd.read_csv(file)` on a huge file,',
  '   Use: `for chunk in pd.read_csv(file, chunksize=10000): ...` and print chunk progress.',
  '',
  '4. WRITE INTERMEDIATE RESULTS: For multi-step analysis, save intermediate results to output/',
  '   after each major step so progress is not lost if a later step times out.',
  '',
  '5. KEEP COMMANDS FOCUSED: Break large scripts into smaller commands that each complete quickly',
  '   and print their result, rather than one monolithic script that runs silently for minutes.',
  '',
  '1. Always use ABSOLUTE paths starting with /home/node/app/workspace/OUTPUT/',
  '2. When user asks to create/generate something - DO IT (use FILE: syntax)',
  '3. When user asks about uploaded files - READ THEM FIRST (use COMMAND: cat or head)',
  '4. Save ALL output files to /home/node/app/workspace/output/',
  '5. Don\'t just explain what you\'ll do - ACTUALLY DO IT',
  '6. You can create multiple files in one response',
  '7. After creating files, briefly confirm what you did',
  '',
  '=== EXAMPLES ===',
  'User: "Create a Python script that prints hello"',
  'You: "Here\'s the script:',
  'FILE: /home/node/app/workspace/output/hello.py',
  '```python',
  'print("Hello, World!")',
  '```',
  'Created hello.py in the output folder."',
  '',
  'User: "What\'s in data.csv?"',
  'You: "Let me check:',
  'COMMAND: head -10 /home/node/app/workspace/input/data.csv',
  'This will show the first 10 lines."',
  '',
  'REMEMBER: Actions speak louder than words. Create files, don\'t just talk about creating them!',
].join('\n');

// Minimal system context for capable models (cloud APIs + capable Ollama models).
// These models use Claude Code's NATIVE tools (Write, Bash, Skill, etc.) and must
// NOT receive FILE:/COMMAND: text instructions, which conflict with and suppress
// native tool usage (the model avoids using Write/Bash when told to use FILE: format).
const CAPABLE_SYSTEM_PROMPT = [
  'You are a helpful coding and data assistant with a workspace at /home/node/app/workspace.',
  '',
  '=== WORKSPACE PATHS ===',
  '- Input files (user uploads): /home/node/app/workspace/input/',
  '- Output files (save ALL created files here): /home/node/app/workspace/output/',
  '',
  '=== CRITICAL RULES ===',
  '1. ALWAYS save output files to /home/node/app/workspace/output/ — never to the workspace root or any other subfolder.',
  '2. Use absolute paths for all file operations (e.g. /home/node/app/workspace/output/dashboard.html).',
  '3. After creating files, briefly confirm what was created and where.',
  '4. When reading user uploads, read from /home/node/app/workspace/input/.',
  '5. Be concise and practical. Take action, do not just describe what you plan to do.',
  '6. ALWAYS append a datetime suffix to every output filename using format YYYYMMDD_HHMMSS.',
  '   Examples: ceo-command-center_20240315_143022.html, report_20240315_143022.pdf, analysis_20240315_143022.xlsx',
  '   Use Python: from datetime import datetime; ts = datetime.now().strftime("%Y%m%d_%H%M%S")',
  '   Or shell: TS=$(date +%Y%m%d_%H%M%S)',
  '   This ensures files are never overwritten and each run produces a unique file.',
  '',
  '=== LARGE FILE & LONG-RUNNING TASK RULES ===',
  '1. SAMPLE BEFORE FULL PROCESSING: For files >1MB, start with head/tail/wc to understand structure.',
  '2. PRINT PROGRESS: Always emit print() statements during long loops so the system knows the script is running.',
  '3. USE CHUNKED READS for large CSVs (>5MB): use pd.read_csv with chunksize and print progress.',
  '4. SAVE INTERMEDIATE RESULTS to output/ after each major processing step.',
  '5. KEEP COMMANDS FOCUSED: break large scripts into smaller commands that each print their result.',
].join('\n');

const app = express();
// Trust the first proxy (nginx/load-balancer) so express-rate-limit
// can correctly identify client IPs from the X-Forwarded-For header.
app.set('trust proxy', 1);
app.use(express.json());

// CORS: allow the deployed frontend origin and any localhost dev origin
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,          // http://localhost:3500
  'http://localhost:3000',
  'http://localhost:3500',
  'http://localhost:5000',
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight requests for all routes

// === Platform webhook router (Slack, Discord, WhatsApp, Zoho, Generic) ===
// Webhook endpoints bypass auth middleware — they verify via platform signatures.
// Must be mounted before the auth rate limiters.
// Platform webhook router not included in Community Edition

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Fix ERR_ERL_INVALID_IP_ADDRESS: extract IP properly behind proxies
  keyGenerator: (req) => {
    return req.ip?.replace(/:\d+$/, '') || req.connection?.remoteAddress || 'unknown';
  },
  message: { error: 'Too many authentication attempts. Please try again later.' }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip?.replace(/:\d+$/, '') || req.connection?.remoteAddress || 'unknown';
  },
  message: { error: 'Too many messages. Please wait a moment.' }
});

// --- Health Check ---
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

const containerManager  = new ContainerManager();
const agentTeamManager  = new AgentTeamManager(containerManager);

// In-memory cache for uploaded file listings per user.
// Invalidated on upload or delete. Avoids repeated fs.readdirSync on every chat message.
const fileListingCache = new Map(); // userId -> { fileListStr: string|null, timestamp: number }
const FILE_CACHE_TTL = 60 * 1000; // 1 minute

// Number of previous messages to include as context in each chat request.
// Configurable via CONTEXT_MESSAGE_LIMIT in .env. Lower = faster + cheaper, higher = more context.
const CONTEXT_MESSAGE_LIMIT = Math.max(1, parseInt(process.env.CONTEXT_MESSAGE_LIMIT, 10) || 10);
console.log(`[Config] Context message limit: ${CONTEXT_MESSAGE_LIMIT}`);

// Import model sync functionality
const { syncAllModels } = require('./modelSync');

// ============================================================
// === LLM ROUTER =============================================
// ============================================================
//
// ARCHITECTURE: Intent → Plan → Model
//
// 1. DETECT INTENT — what is the user actually trying to do?
//    (writing, coding, analysis, agentic, conversation, etc.)
//
// 2. ANALYSE SKILLS — what skills are enabled?
//    Skills can require more capable models to execute correctly.
//    Skills can also CONFIRM the intent (e.g. pdf skill + "convert" = file task)
//
// 3. BUILD EXECUTION PLAN — what tools/capabilities are needed?
//    Simple text → tier 1 (Ollama)
//    Code + file ops → tier 2 (capable Ollama)
//    MCP + multi-step + agentic → tier 3 (commercial flagship)
//
// 4. SELECT MODEL — pick best available model for the plan tier
//    Tier 1-2: prefer local Ollama (free, fast, private)
//    Tier 3: prefer Claude Sonnet (best Claude Code CLI tool calling)
//    GLM: always last resort regardless of tier
//
// ============================================================

// ── INTENT CATEGORIES ────────────────────────────────────────
// Each intent has a base tier. Skills and tool requirements can raise it.
// Important: check SPECIFIC intents before GENERIC ones to avoid
// "write a linkedin post" matching generic "write" as a coding task.

const SKILL_MIN_TIER = {
  // Tier 4: Elite agentic — need flagship model tool calling
  'agent-browser':        4,
  'ceo-command-center':   4,
  'dev-swarm-code-test':  4,
  'webapp-testing':       4,
  'persona-testing':      4,
  'testing-integration':  4,

  // Tier 3: Complex — commercial mid tier sufficient
  'deep-research':        3,
  'mcp-builder':          3,
  'skill-creator':        3,
  'skill-development':    3,
  'hook-development':     3,
  'observability':        3,
  'grafana-dashboards':   3,
  'kpi-dashboard-design': 3,
  'security-audit':       3,

  // Tier 2: Capable Ollama handles these well
  'schema-migration':     2,
  'docker-patterns':      2,
  'algorithmic-art':      2,
  'canvas-design':        2,
  'web-artifacts-builder':2,
  'db-scanner':           2,
  'project-estimation':   2,
  'estimating-work':      2,

  // Tier 1: Standard Ollama is fine
  'pdf':              1,
  'docx':             1,
  'pptx':             1,
  'xlsx':             1,
  'frontend-design':  1,
  'frontend-ui':      1,
  'brand-guidelines': 1,
  'theme-factory':    1,
  'doc-coauthoring':  1,
  'internal-comms':   1,
  'rca-generator':    1,
  'slack-gif-creator':1,
};

// ── INTENT → TIER (updated for 4-tier system) ─────────────────
const INTENTS = [
  // Social/content — very specific, check first
  { name: 'social_content',   tier: 1, match: (m) =>
      /\b(linkedin|twitter|tweet|instagram|facebook|tiktok|social.?media)\b/.test(m) ||
      /\b(write|create|draft|generate).{0,30}(post|caption|bio|update|content|thread)\b/.test(m) },

  // Coding/technical — check BEFORE writing_creative
  // so "write a python script" correctly hits tier 2 not tier 1
  { name: 'coding_task',      tier: 2, match: (m) =>
      /\b(python|javascript|typescript|nodejs|react|vue|angular|sql|bash|shell|java|golang|rust|c\+\+|kotlin|swift|php|ruby)\b/.test(m) ||
      /\b(write|create|build|implement|code|develop).{0,40}(function|class|module|component|api|endpoint|service|script|app|application|tool|cli|bot|plugin|library)\b/.test(m) ||
      /\b(debug|fix.+bug|refactor|optimize|review.+code|unit.?test|add.+feature|write.+test)\b/.test(m) },
  { name: 'data_task',        tier: 2, match: (m) =>
      /\b(analyze|analyse|visualize|plot|graph|chart).{0,30}(data|dataset|csv|metrics|stats|numbers|results)\b/.test(m) },
  { name: 'technical_infra',  tier: 2, match: (m) =>
      /\b(docker|kubernetes|k8s|deploy|ci.?cd|pipeline|nginx|schema.?migration|database.?design|terraform|ansible)\b/.test(m) },

  // General writing — after coding so scripts don't fall here
  { name: 'writing_creative', tier: 1, match: (m) =>
      /\b(write|draft|compose|create).{0,30}(email|letter|essay|article|blog|story|poem|summary|bio|cover.?letter|press.?release|announcement|newsletter|memo|proposal)\b/.test(m) ||
      /\b(proofread|edit|rewrite|rephrase|improve|shorten|expand|paraphrase|translate)\b/.test(m) },
  { name: 'document_task',    tier: 1, match: (m) =>
      /\b(convert|extract|parse|read|summarize|summarise).{0,30}(pdf|doc|docx|excel|xlsx|csv|pptx|file|document|spreadsheet)\b/.test(m) ||
      /\b(create|make|generate).{0,30}(pdf|doc|docx|excel|xlsx|csv|pptx|spreadsheet|presentation|slide)\b/.test(m) },
  { name: 'simple_question',  tier: 1, match: (m) =>
      /^(what|who|when|where|why|how|is|are|can|could|should|tell me|explain|describe|list|give me).{0,80}[?]?$/.test(m) },
  { name: 'design_visual',    tier: 1, match: (m) =>
      /\b(design|create|make).{0,30}(logo|banner|poster|flyer|template|theme|infographic)\b/.test(m) &&
      !/\b(code|implement|build|deploy|api|backend)\b/.test(m) },

  // Tier 3: Research/reasoning — Haiku/Flash preferred over Ollama
  { name: 'web_research',     tier: 3, match: (m) =>
      /\b(research|search.+web|find.+online|look.+up|current|latest|news|today|recent.+news)\b/.test(m) ||
      /\b(comprehensive|in.?depth|detailed.?analysis|compare.+products|market.+research|competitor.+analysis)\b/.test(m) },
  { name: 'complex_reasoning',tier: 3, match: (m) =>
      /\b(strategy|business.?plan|investment.+analysis|architecture.+design|system.+design|trade.?off|evaluate.+options|due.+diligence)\b/.test(m) },

  // Tier 4: Agentic/orchestration — Sonnet/flagship only
  { name: 'agentic_task',     tier: 4, match: (m) =>
      /\b(scrape|crawl|automate|fill.?form|web.?test|e2e|end.?to.?end|swarm|multi.?agent|orchestrat|coordinate|parallel.?agent|spawn.?agent)\b/.test(m) },
  { name: 'command_center',   tier: 4, match: (m) =>
      /\b(command.?center|ceo.?dashboard|executive.?dashboard|ops.?center)\b/.test(m) },
  { name: 'mcp_tools',        tier: 4, match: (m) =>
      /\b(mcp|model.?context.?protocol|tool.?call|function.?call)\b/.test(m) },
];
// ── PREFERENCE SCORE within same tier ─────────────────────────
// ── DYNAMIC MODEL CLASSIFICATION ─────────────────────────────
// Instead of hardcoding model names, we classify models dynamically
// based on: provider, is_capable flag from DB, and identity patterns.
//
// TIER SYSTEM (4 levels):
//   Tier 1 — Standard Ollama (uncapable): llama, mistral, phi, gemma, glm etc.
//   Tier 2 — Capable Ollama: qwen3-coder, qwen3, gpt-oss, deepseek-coder etc.
//   Tier 3 — Commercial mid: haiku, gpt-4o-mini, gemini-flash, groq, openrouter
//   Tier 4 — Commercial flagship: sonnet, opus, gpt-4o, gpt-5, gemini-pro
//
// GLM is always tier 1 (last resort) regardless of is_capable flag.
//
// For Ollama: tier is determined by is_capable flag from the DB,
// which admins control via modelSync — so adding a new capable model
// just requires flagging it in the DB, no code change needed.
// ──────────────────────────────────────────────────────────────


// ── Community Edition — simplified model selection ───────────────────────────
// Full intelligent model routing (tier system, intent analysis, team detection)
// is available in EzCoworker Enterprise.

function selectBestModel(models) {
  if (!models || models.length === 0) return null;
  // Simple: prefer capable models, then first available
  const capable = models.find(m => m.is_capable);
  const best = capable || models[0];
  if (best) console.log(`[LLM Router] Using: "${best.name}" (${best.provider})`);
  return best || null;
}

function shouldUseAgentTeam() {
  return { useTeam: false, agentCount: 1, reason: 'community_single_agent',
           intent: 'general', tier: 1, agentRoles: [], capabilityFlags: {} };
}

function analyseRequest(message) {
  return { intent: 'general', tier: 1 };
}


// --- Wait for database to be ready, then run migrations ---
async function runMigrations(retries = 15, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      console.log(`[DB] Waiting for postgres... (${i + 1}/${retries})`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) DEFAULT 'New Conversation',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      metadata JSONB DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
  `);

  // Migration: add metadata column to existing messages tables
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL`);

  // Conversation file attachments: track which files were used per conversation
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_files (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder VARCHAR(20) NOT NULL CHECK (folder IN ('input', 'output')),
      filename VARCHAR(500) NOT NULL,
      size BIGINT DEFAULT 0,
      attached_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(conversation_id, folder, filename)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_files_conversation ON conversation_files(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_conv_files_user ON conversation_files(user_id);
  `);

  // ── Multi-turn execution context table ────────────────────────────────────
  // Stores summarized phase-1 outputs + synthesis decisions per conversation.
  // Used by the planner on Turn 2+ to decide PATCH / EXTEND / REBUILD and to
  // inject prior findings into the synthesis agent without re-running analysis.
  // Never exposed to the UI — internal planning state only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_execution_context (
      conversation_id  INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL,
      phase1_summaries JSONB   DEFAULT '[]',
      synthesis_notes  TEXT    DEFAULT '',
      produced_files   JSONB   DEFAULT '[]',
      plan_summary     JSONB   DEFAULT '{}',
      last_updated     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_exec_ctx_user ON conversation_execution_context(user_id);
  `);

  // Migration: clear conversation_files data that was incorrectly bulk-inserted
  // (old snapshot logic inserted ALL workspace files into every conversation).
  // Safe to truncate — it will be rebuilt accurately going forward.
  // Only run if the table has data but no conversations have more than 20 files
  // (heuristic: bulk-insert creates many rows per conversation).
  try {
    const { rows: [bulkCheck] } = await pool.query(`
      SELECT MAX(file_count) as max_files FROM (
        SELECT conversation_id, COUNT(*) as file_count FROM conversation_files GROUP BY conversation_id
      ) sub
    `);
    if (bulkCheck?.max_files > 20) {
      await pool.query('TRUNCATE TABLE conversation_files');
      console.log('[DB] Cleared bulk-inserted conversation_files — will rebuild accurately going forward');
    }
  } catch (_) {}

  // Conversation share tokens
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_shares (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_token VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP DEFAULT NULL,
      UNIQUE(conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shares_token ON conversation_shares(share_token);
  `);

  // Model switcher feature tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_configs (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      provider VARCHAR(100) NOT NULL,
      api_endpoint VARCHAR(500) NOT NULL,
      model_identifier VARCHAR(255) NOT NULL,
      requires_api_key BOOLEAN DEFAULT false,
      default_api_key TEXT,
      is_active BOOLEAN DEFAULT true,
      is_capable BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(model_identifier, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_model_configs_active ON model_configs(is_active);
    CREATE INDEX IF NOT EXISTS idx_model_configs_provider ON model_configs(provider);

    CREATE TABLE IF NOT EXISTS user_model_preferences (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model_config_id INTEGER NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE,
      user_api_key TEXT,
      auto_select BOOLEAN DEFAULT false,
      selected_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_model_prefs_user_id ON user_model_preferences(user_id);

    -- Fix any existing incorrect API endpoints that have /api/chat suffix
    UPDATE model_configs
    SET api_endpoint = REPLACE(api_endpoint, '/api/chat', '')
    WHERE provider = 'ollama' AND api_endpoint LIKE '%/api/chat%';
  `);

  // Migration: add is_capable column to existing model_configs tables (existing installs).
  await pool.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS is_capable BOOLEAN DEFAULT false`);

  // Migration: add mcp_capable column — true only for models confirmed to handle SSE MCP tool calling.
  // Separate from is_capable so regular agent tasks aren't affected.
  await pool.query(`ALTER TABLE model_configs ADD COLUMN IF NOT EXISTS mcp_capable BOOLEAN DEFAULT false`);

  // Set mcp_capable based on known capable model families
  await pool.query(`
    UPDATE model_configs SET mcp_capable = true WHERE
      model_identifier ILIKE '%gpt-oss%'
      OR model_identifier ILIKE '%qwen3-coder%'
      OR model_identifier ILIKE '%qwen3.5%'
      OR (model_identifier ILIKE '%qwen3%' AND model_identifier NOT ILIKE '%qwen2%')
      OR model_identifier ILIKE '%deepseek-r1%'
      OR model_identifier ILIKE '%deepseek-v3%'
      OR provider IN ('anthropic','openai','google','groq','openrouter')
  `);
  console.log('[DB] mcp_capable flags updated');
  // Migration: add auto_select to user_model_preferences (existing installs)
  await pool.query(`ALTER TABLE user_model_preferences ADD COLUMN IF NOT EXISTS auto_select BOOLEAN DEFAULT false`);

  // Dynamically flag capable Ollama models based on known capable model families.
  // These models support Claude Code CLI native tool definitions (Write, Bash, Read etc.)
  // New models added to the DB will be auto-flagged if their identifier matches these patterns.
  // Admins can also manually set is_capable=true for any new model via SQL.
  await pool.query(`
    UPDATE model_configs SET is_capable = true
    WHERE provider = 'ollama' AND (
      -- gpt-oss family
      model_identifier LIKE 'gpt-oss%'
      -- qwen3 family (includes qwen3.5, qwen3-coder, qwen3:30b, qwen3:8b, etc.)
      OR model_identifier LIKE 'qwen3%'
      -- qwen2.5 family (includes qwen2.5-coder, qwen2.5:72b, etc.)
      OR model_identifier LIKE 'qwen2.5%'
      -- qwen2 capable variants
      OR model_identifier LIKE 'qwen2%coder%'
      -- deepseek coder variants
      OR model_identifier LIKE 'deepseek%coder%'
      OR model_identifier LIKE 'deepseek-v%'
      OR model_identifier LIKE 'deepseek-r%'
      -- mistral large / nemo
      OR model_identifier LIKE 'mistral-nemo%'
      OR model_identifier LIKE 'mistral-large%'
      OR model_identifier LIKE 'mixtral%'
      -- newer llama variants known to support tool calling
      OR model_identifier LIKE 'llama3.3%'
      OR model_identifier LIKE 'llama3.2%'
      OR model_identifier LIKE 'llama-3.3%'
      OR model_identifier LIKE 'llama-3.2%'
    )
  `);
  // GLM always last resort regardless of any other flags
  await pool.query(`
    UPDATE model_configs SET is_capable = false
    WHERE provider = 'ollama' AND model_identifier LIKE 'glm%'
  `);

  // mcp_capable flags managed manually in Community Edition
  // Log what got flagged
  const capableResult = await pool.query(`
    SELECT model_identifier FROM model_configs
    WHERE provider = 'ollama' AND is_capable = true
    ORDER BY model_identifier
  `);
  const capableList = capableResult.rows.map(r => r.model_identifier).join(', ');
  const mcpCapableResult = await pool.query(`
    SELECT model_identifier, provider FROM model_configs
    WHERE mcp_capable = true AND is_active = true
    ORDER BY provider, model_identifier
  `);
  const mcpCapableList = mcpCapableResult.rows.map(r => r.model_identifier).join(', ');
  if (mcpCapableList) console.log(`[DB] MCP-capable models: ${mcpCapableList}`);
  console.log(`[DB] Capable Ollama models (tier 2): ${capableList || 'none'}`);
  const uncapableResult = await pool.query(`
    SELECT model_identifier FROM model_configs
    WHERE provider = 'ollama' AND is_capable = false
    ORDER BY model_identifier
  `);
  console.log(`[DB] Standard Ollama models (tier 1): ${uncapableResult.rows.map(r => r.model_identifier).join(', ') || 'none'}`);

  // User skill preferences
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_skills (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_name VARCHAR(255) NOT NULL,
      enabled BOOLEAN DEFAULT false,
      UNIQUE(user_id, skill_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_skills_user_id ON user_skills(user_id);
  `);

  // User plugin preferences (mirrors user_skills)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_plugins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plugin_name VARCHAR(255) NOT NULL,
      enabled BOOLEAN DEFAULT false,
      UNIQUE(user_id, plugin_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_plugins_user_id ON user_plugins(user_id);
  `);

  // User-level MCP server overrides (custom endpoint URLs, env vars, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_mcp_servers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(20) DEFAULT 'stdio',
      command VARCHAR(512),
      args JSONB DEFAULT '[]',
      url VARCHAR(512),
      env JSONB DEFAULT '{}',
      enabled BOOLEAN DEFAULT true,
      UNIQUE(user_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user_id ON user_mcp_servers(user_id);
  `);

  // Platform webhook users (synthetic users for Slack/Discord/WhatsApp/Zoho)
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS platform VARCHAR(50) DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_user_id VARCHAR(255) DEFAULT NULL;
  `);

  // Skills default to ENABLED — users may disable skills they don't want.
  // No reset migration needed; new skills will default to true on first load.

  // Admin role
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()`);

  console.log('[DB] Migrations complete');

  // Pre-load skills + plugins cache at startup
  try {
    const skills = loadAllSkills();
    console.log(`[Skills] Loaded ${skills.length} skills into cache`);
  } catch (err) {
    console.warn('[Skills] Could not pre-load skills cache:', err.message);
  }
  try {
    const plugins = pluginManager.loadAllPlugins();
    console.log(`[Plugins] Loaded ${plugins.length} plugins into cache`);
  } catch (err) {
    console.warn('[Plugins] Could not pre-load plugins cache:', err.message);
  }

  // Auto-sync models from Ollama and .env
  try {
    await syncAllModels(pool);
  } catch (err) {
    console.warn('[Startup] Model auto-sync failed, will retry on next startup:', err.message);
  }
}

// --- JWT Auth Middleware ---
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Try to parse a JSON tool call. Falls back to regex for broken JSON
 * (e.g. Python expressions like "str" * 100 inside JSON values).
 */
function tryParseToolCall(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.name && parsed.arguments !== undefined) return parsed;
  } catch {}

  // Regex fallback for broken JSON
  const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;

  const result = { name: nameMatch[1], arguments: {} };

  const pathMatch = text.match(/"file_path"\s*:\s*"([^"]+)"/);
  if (pathMatch) result.arguments.file_path = pathMatch[1];

  // Handle "content": "str" * N  (Python-style string multiplication)
  const contentMultMatch = text.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\*\s*(\d+)/);
  if (contentMultMatch) {
    let content = contentMultMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const times = Math.min(parseInt(contentMultMatch[2], 10), 1000);
    result.arguments.content = content.repeat(times);
  } else {
    const contentMatch = text.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (contentMatch) {
      result.arguments.content = contentMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }

  const cmdMatch = text.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (cmdMatch) result.arguments.command = cmdMatch[1].replace(/\\n/g, '\n');

  return result;
}

/**
 * Parse file operations and tool calls from raw model output.
 * Handles multiple formats the model may produce:
 *   1. FILE: path + code block (preferred, instructed via system prompt)
 *   2. JSON tool calls wrapped in markdown fences (```json ... ```)
 *   3. Bare JSON tool calls (single or multi-line)
 *   4. Broken JSON (regex fallback)
 */
function extractToolCalls(output) {
  const toolCalls = [];
  let remaining = output;

  // 1a. Extract  FILE: /path\n```lang\ncontent\n```  blocks (FILE: outside code block)
  remaining = remaining.replace(
    /FILE:\s*(\S+)\s*\n```[\w]*\n([\s\S]*?)```/g,
    (_match, filePath, content) => {
      toolCalls.push({ name: 'Write', arguments: { file_path: filePath, content: content.trimEnd() } });
      return '';
    }
  );

  // 1b. Extract  ```lang\n[#] FILE: /path\ncontent\n```  blocks (FILE: inside code block)
  //     The model sometimes puts FILE: as a comment on the first line of a code block.
  remaining = remaining.replace(
    /```[\w]*\n#?\s*FILE:\s*(\S+)\s*\n([\s\S]*?)```/g,
    (_match, filePath, content) => {
      toolCalls.push({ name: 'Write', arguments: { file_path: filePath, content: content.trimEnd() } });
      return '';
    }
  );

  // 2. Extract  COMMAND: ...  lines
  remaining = remaining.replace(
    /COMMAND:\s*(.+)/g,
    (_match, command) => {
      toolCalls.push({ name: 'Bash', arguments: { command: command.trim() } });
      return '';
    }
  );

  // 3. Unwrap JSON from markdown code fences and try to parse
  remaining = remaining.replace(
    /```(?:json)?\s*\n([\s\S]*?)\n```/g,
    (match, inner) => {
      const parsed = tryParseToolCall(inner.trim());
      if (parsed) { toolCalls.push(parsed); return ''; }
      return match; // Keep non-tool-call code blocks
    }
  );

  // 4. Try to find bare JSON tool calls (line-by-line)
  const lines = remaining.split('\n');
  const textLines = [];
  let jsonBuf = '';
  let depth = 0;

  for (const line of lines) {
    const t = line.trim();

    if (depth > 0) {
      jsonBuf += '\n' + line;
      depth += (t.match(/\{/g) || []).length;
      depth -= (t.match(/\}/g) || []).length;
      if (depth <= 0) {
        const parsed = tryParseToolCall(jsonBuf);
        if (parsed) { toolCalls.push(parsed); }
        else { textLines.push(jsonBuf); }
        jsonBuf = '';
        depth = 0;
      }
      continue;
    }

    if (t === '{') {
      // Multi-line JSON where first line is just '{'
      jsonBuf = line;
      depth = 1;
    } else if (t.startsWith('{') && t.includes('"name"')) {
      const opens = (t.match(/\{/g) || []).length;
      const closes = (t.match(/\}/g) || []).length;
      if (opens <= closes) {
        const parsed = tryParseToolCall(t);
        if (parsed) { toolCalls.push(parsed); continue; }
        textLines.push(line);
      } else {
        jsonBuf = t;
        depth = opens - closes;
      }
    } else {
      textLines.push(line);
    }
  }

  if (jsonBuf) textLines.push(jsonBuf);
  return { toolCalls, text: textLines.join('\n').trim() };
}

/**
 * Process raw agent output: parse tool calls in all formats, execute file
 * writes and shell commands inside the container, return readable response.
 */
async function processAgentResponse(rawOutput, cMgr, containerName) {
  const trimmed = rawOutput.trim();
  if (!trimmed) return 'No response received.';

  const { toolCalls, text } = extractToolCalls(trimmed);

  if (toolCalls.length === 0) return text || trimmed;

  const results = [];
  const WORKSPACE = '/home/node/app/workspace/';

  for (const tc of toolCalls) {
    const name = (tc.name || '').toLowerCase();
    const args = tc.arguments || {};

    if (name === 'write' || name === 'create' || name === 'write_to_file') {
      let filePath = args.file_path || args.path || args.filePath || '';
      const content = args.content || '';
      // Ensure workspace prefix
      if (filePath && !filePath.startsWith('/')) filePath = WORKSPACE + filePath;
      // Enforce output/ subdirectory — redirect files written to workspace root or wrong subfolders.
      // The model sometimes ignores the output/ instruction and writes to workspace/ directly.
      if (filePath.startsWith(WORKSPACE) && !filePath.startsWith(WORKSPACE + 'output/') && !filePath.startsWith(WORKSPACE + 'input/')) {
        filePath = WORKSPACE + 'output/' + filePath.replace(WORKSPACE, '');
      }
      if (filePath && filePath.startsWith(WORKSPACE) && content) {
        try {
          await cMgr.writeFileInContainer(containerName, filePath, content);
          const shortPath = filePath.replace(WORKSPACE, '');
          const lang = shortPath.split('.').pop() || '';
          results.push(`Created \`${shortPath}\`:\n\`\`\`${lang}\n${content}\n\`\`\``);
        } catch (err) {
          results.push(`Failed to create \`${filePath}\`: ${err.message}`);
        }
      }
    } else if (name === 'bash' || name === 'execute' || name === 'run' || name === 'shell') {
      const command = args.command || args.cmd || '';
      if (command) {
        try {
          const out = await cMgr.runCommandInContainer(containerName, command);
          const truncated = out.length > 2000 ? out.substring(0, 2000) + '\n... (truncated)' : out;
          results.push(`Ran \`${command}\`:\n\`\`\`\n${truncated}\n\`\`\``);
        } catch (err) {
          results.push(`Command \`${command}\` failed: ${err.message}`);
        }
      }
    }
  }

  const parts = [text, ...results].filter(Boolean);

  // If we found tool calls but couldn't execute any, fall back to raw output
  // instead of showing "no visible output"
  if (parts.length === 0 && toolCalls.length > 0) {
    return trimmed;
  }

  return parts.join('\n\n') || trimmed;
}

// --- Auth: Register ---
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash]
    );
    const userId = result.rows[0].id;

    // Create user folder at registration time
    containerManager.ensureUserFolder(userId);

    // Return a token so the frontend can use authenticated endpoints immediately
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ id: userId, token, userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Auth: Login ---
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (user && await bcrypt.compare(password, user.password_hash)) {
      const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });

      // Ensure user folder exists
      containerManager.ensureUserFolder(user.id);

      // Pre-warm the container so the first message is faster
      containerManager.ensureContainer(user.id).catch(err => {
        console.error(`[Login] Failed to pre-warm container for user ${user.id}:`, err);
      });

      res.json({ token, userId: user.id });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Auth: Logout ---
app.post('/api/logout', authMiddleware, async (req, res) => {
  try {
    await containerManager.removeContainer(req.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Get Conversation List ---
app.get('/api/conversations', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.userId]
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Get Messages for a Conversation ---
app.get('/api/conversations/:id/messages', authMiddleware, async (req, res) => {
  try {
    const conv = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (conv.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const result = await pool.query(
      'SELECT role, content, created_at, metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Delete Conversation ---
app.delete('/api/conversations/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Get Available Models ---
app.get('/api/models', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, description, provider,
              requires_api_key AND default_api_key IS NULL AS requires_api_key
       FROM model_configs WHERE is_active = true ORDER BY name ASC`
    );
    res.json({ models: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Get Current User Model ---
app.get('/api/models/current', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT mc.id, mc.name, mc.description, mc.provider, mc.requires_api_key,
             ump.user_api_key IS NOT NULL as has_user_key,
             COALESCE(ump.auto_select, false) as auto_select
      FROM user_model_preferences ump
      JOIN model_configs mc ON ump.model_config_id = mc.id
      WHERE ump.user_id = $1 AND mc.is_active = true
    `, [req.userId]);

    if (result.rows.length === 0) {
      const defaultResult = await pool.query(
        'SELECT id, name, description, provider, requires_api_key FROM model_configs WHERE id = 1'
      );
      return res.json({ model: defaultResult.rows[0] || null, auto_select: false });
    }

    res.json({ model: result.rows[0], auto_select: result.rows[0].auto_select });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Select Model ---
app.put('/api/models/select', authMiddleware, async (req, res) => {
  try {
    const { modelId, userApiKey } = req.body;
    if (!modelId || isNaN(parseInt(modelId, 10))) {
      return res.status(400).json({ error: 'Model ID is required.' });
    }

    // Check if model exists and is active
    const modelCheck = await pool.query(
      'SELECT id, name, requires_api_key, default_api_key FROM model_configs WHERE id = $1 AND is_active = true',
      [modelId]
    );
    if (modelCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Model not found or inactive.' });
    }

    const model = modelCheck.rows[0];

    // Validate API key requirement — allow if server has a default key
    if (model.requires_api_key && !userApiKey && !model.default_api_key) {
      return res.status(400).json({ error: 'This model requires an API key.' });
    }

    // Upsert user preference
    await pool.query(`
      INSERT INTO user_model_preferences (user_id, model_config_id, user_api_key)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET model_config_id = $2, user_api_key = $3, selected_at = NOW()
    `, [req.userId, modelId, userApiKey || null]);

    res.json({ success: true, model: { id: model.id, name: model.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Sync Models (Manual Trigger) ---
app.post('/api/models/sync', authMiddleware, async (req, res) => {
  try {
    console.log(`[API] User ${req.userId} triggered model sync`);
    await syncAllModels(pool);
    
    // Return updated model list
    const result = await pool.query(
      'SELECT id, name, description, provider, model_identifier, is_active, is_capable FROM model_configs WHERE is_active = true ORDER BY provider, name ASC'
    );
    
    res.json({ 
      success: true, 
      message: `Successfully synced! Found ${result.rows.length} active models.`,
      models: result.rows 
    });
  } catch (err) {
    console.error('[API] Model sync error:', err);
    res.status(500).json({ error: 'Failed to sync models: ' + err.message });
  }
});

// --- Toggle model capable flag (admin: promote/demote Ollama models) ---
app.put('/api/models/:id/capable', authMiddleware, async (req, res) => {
  try {
    const { capable } = req.body;
    const modelId = parseInt(req.params.id, 10);
    if (isNaN(modelId)) return res.status(400).json({ error: 'Invalid model ID' });

    // Get the model
    const check = await pool.query(
      'SELECT id, name, provider, model_identifier FROM model_configs WHERE id = $1',
      [modelId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Model not found' });
    const model = check.rows[0];

    // Prevent forcing GLM to capable — it stays last resort
    if (/glm/i.test(model.model_identifier) && capable) {
      return res.status(400).json({ error: 'GLM models cannot be marked capable — they are reserved as last resort' });
    }

    await pool.query(
      'UPDATE model_configs SET is_capable = $1, updated_at = NOW() WHERE id = $2',
      [!!capable, modelId]
    );

    console.log(`[Models] ${model.name} (${model.provider}) is_capable → ${capable}`);
    res.json({ success: true, model: { ...model, is_capable: !!capable } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Rename Conversation ---
app.patch('/api/conversations/:id/title', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ error: 'Title is required.' });
    }
    const result = await pool.query(
      'UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, title',
      [title.trim().substring(0, 255), req.params.id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ success: true, conversation: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Share Conversation: create/get share link ---
app.post('/api/conversations/:id/share', authMiddleware, async (req, res) => {
  try {
    const convId = parseInt(req.params.id, 10);
    const check = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [convId, req.userId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Conversation not found.' });

    // Check if share already exists
    const existing = await pool.query(
      'SELECT share_token FROM conversation_shares WHERE conversation_id = $1',
      [convId]
    );
    if (existing.rows.length > 0) {
      return res.json({ shareToken: existing.rows[0].share_token });
    }

    // Generate secure random token
    const crypto = require('crypto');
    const shareToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'INSERT INTO conversation_shares (conversation_id, user_id, share_token) VALUES ($1, $2, $3)',
      [convId, req.userId, shareToken]
    );
    res.json({ shareToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Revoke Share ---
app.delete('/api/conversations/:id/share', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM conversation_shares WHERE conversation_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Public: View Shared Conversation (no auth needed) ---
app.get('/api/share/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const shareResult = await pool.query(
      `SELECT cs.conversation_id, c.title, c.created_at
       FROM conversation_shares cs
       JOIN conversations c ON cs.conversation_id = c.id
       WHERE cs.share_token = $1`,
      [token]
    );
    if (shareResult.rows.length === 0) return res.status(404).json({ error: 'Share not found or expired.' });
    const { conversation_id, title, created_at } = shareResult.rows[0];
    const msgs = await pool.query(
      'SELECT role, content, created_at, metadata FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversation_id]
    );
    // Include files so the shared view can show what was uploaded and generated
    const sharedFiles = await pool.query(
      'SELECT folder, filename, size, attached_at FROM conversation_files WHERE conversation_id = $1 ORDER BY folder ASC, attached_at ASC',
      [conversation_id]
    );
    res.json({
      title, created_at, messages: msgs.rows,
      files:   sharedFiles.rows,
      inputs:  sharedFiles.rows.filter(f => f.folder === 'input'),
      outputs: sharedFiles.rows.filter(f => f.folder === 'output'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Conversation Files: List files attached to a conversation ---
app.get('/api/conversations/:id/files', authMiddleware, async (req, res) => {
  try {
    const conv = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Conversation not found.' });

    const result = await pool.query(
      'SELECT folder, filename, size, attached_at FROM conversation_files WHERE conversation_id = $1 ORDER BY folder ASC, attached_at ASC',
      [req.params.id]
    );
    // Return split into input/output groups for the UI
    const files   = result.rows;
    const inputs  = files.filter(f => f.folder === 'input');
    const outputs = files.filter(f => f.folder === 'output');
    res.json({ files, inputs, outputs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Conversation Files: Retroactively link uploads to a new conversation ---
// Called when files were uploaded before a conversation existed (new chat flow).
// The frontend sends the filenames; we insert them into conversation_files.
app.post('/api/conversations/:id/link-uploads', authMiddleware, async (req, res) => {
  try {
    const convId = parseInt(req.params.id, 10);
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || !filenames.length) return res.json({ linked: 0 });

    const conv = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [convId, req.userId]
    );
    if (conv.rows.length === 0) return res.status(404).json({ error: 'Conversation not found.' });

    const inputDir = `/srv/claude/users/${req.userId}/input`;
    let linked = 0;
    for (const filename of filenames) {
      // Validate — only link files that actually exist in the user's input folder
      const filePath = require('path').join(inputDir, filename);
      if (!filePath.startsWith(inputDir)) continue; // path traversal guard
      let size = 0;
      try { size = require('fs').statSync(filePath).size; } catch { continue; }

      await pool.query(`
        INSERT INTO conversation_files (conversation_id, user_id, folder, filename, size)
        VALUES ($1, $2, 'input', $3, $4)
        ON CONFLICT (conversation_id, folder, filename) DO UPDATE SET size = $4, attached_at = NOW()
      `, [convId, req.userId, filename, size]);
      linked++;
    }
    console.log(`[ConvFiles] Retroactively linked ${linked} file(s) to conv ${convId}`);
    res.json({ linked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LLM Router: Auto-select best model for message+skills ---
app.post('/api/models/auto-select', authMiddleware, async (req, res) => {
  try {
    const { message, enabledSkills } = req.body;
    const modelsResult = await pool.query(
      `SELECT id, name, description, provider, model_identifier, is_capable, 
              requires_api_key AND default_api_key IS NULL AS needs_user_key
       FROM model_configs WHERE is_active = true`
    );
    const models = modelsResult.rows;
    // Filter to only models the user can use (no user key needed if server key present)
    const usable = models.filter(m => !m.needs_user_key);
    const best = selectBestModel(usable, message || '', enabledSkills || []);
    if (!best) return res.json({ modelId: null, reason: 'No models available' });

    const tier = (() => {
      const p = (best.provider || '').toLowerCase();
      const id = (best.model_identifier || '').toLowerCase();
      if (p === 'anthropic') return /claude-(3-5|3\.5|4|opus)/.test(id) ? 3 : 2;
      if (p === 'openai') return /gpt-4o|o1|o3|gpt-5/.test(id) ? 3 : /gpt-4/.test(id) ? 2 : 1;
      if (p === 'google') return /gemini.*(1\.5-pro|2\.0|ultra|pro)/.test(id) ? 3 : 2;
      if (p === 'groq' || p === 'openrouter') return 2;
      return best.is_capable ? 2 : 1;
    })();

    res.json({ 
      modelId: best.id, 
      modelName: best.name,
      provider: best.provider,
      tier,
      reason: `Selected for complexity tier ${tier}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Toggle auto-select preference ---
app.put('/api/models/auto-select/toggle', authMiddleware, async (req, res) => {
  try {
    const { enabled } = req.body;
    await pool.query(`
      INSERT INTO user_model_preferences (user_id, model_config_id, auto_select)
      VALUES ($1, 1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET auto_select = $2, selected_at = NOW()
    `, [req.userId, !!enabled]);
    res.json({ success: true, auto_select: !!enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/upload', authMiddleware, (req, res) => {
  upload.array('files', MAX_FILES)(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB).` });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files (max ${MAX_FILES}).` });
      return res.status(400).json({ error: err.message });
    }
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files provided.' });

    const userId = req.userId;
    const inputDir = `/srv/claude/users/${userId}/input`;
    containerManager.ensureUserFolder(userId);

    // Optional: conversationId sent by frontend to link uploads to a specific chat
    const conversationId = req.body.conversationId ? parseInt(req.body.conversationId, 10) : null;

    const results = [];
    for (const file of req.files) {
      // Sanitize filename — strip path traversal characters
      let safeName = path.basename(file.originalname).replace(/[^\w.\-() ]/g, '_');
      if (!safeName || safeName.startsWith('.')) safeName = 'file_' + safeName;

      // Handle name collisions by appending a counter
      let destPath = path.join(inputDir, safeName);
      if (fs.existsSync(destPath)) {
        const ext = path.extname(safeName);
        const base = path.basename(safeName, ext);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          destPath = path.join(inputDir, `${base}_${counter}${ext}`);
          counter++;
        }
        safeName = path.basename(destPath);
      }

      fs.writeFileSync(destPath, file.buffer);
      results.push({ name: safeName, size: file.size });
      console.log(`[Upload] User ${userId}: ${safeName} (${file.size} bytes)`);

      // Link this uploaded file to the conversation immediately
      if (conversationId) {
        try {
          await pool.query(`
            INSERT INTO conversation_files (conversation_id, user_id, folder, filename, size)
            VALUES ($1, $2, 'input', $3, $4)
            ON CONFLICT (conversation_id, folder, filename) DO UPDATE SET size = $4, attached_at = NOW()
          `, [conversationId, userId, safeName, file.size]);
          console.log(`[ConvFiles] Input file linked to conv ${conversationId}: ${safeName}`);
        } catch (e) {
          console.warn('[ConvFiles] Failed to link upload to conversation:', e.message);
        }
      }
    }

    fileListingCache.delete(userId); // Invalidate cached file listing — new files uploaded
    res.json({ files: results });
  });
});

// --- List Files ---
app.get('/api/files', authMiddleware, (req, res) => {
  try {
    const userId = req.userId;
    const folder = req.query.folder; // 'input', 'output', or omit for both
    const baseDir = `/srv/claude/users/${userId}`;
    const folders = folder === 'input' ? ['input'] : folder === 'output' ? ['output'] : ['input', 'output'];

    const files = [];
    for (const f of folders) {
      const dir = path.join(baseDir, f);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const filePath = path.join(dir, name);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          files.push({ name, size: stat.size, modified: stat.mtime.toISOString(), folder: f });
        } catch {}
      }
    }

    // Sort by modified date, newest first
    files.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({ files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Download File ---
app.get('/api/files/download/:folder/:filename', authMiddleware, (req, res) => {
  try {
    const { folder, filename } = req.params;
    if (folder !== 'input' && folder !== 'output') {
      return res.status(400).json({ error: 'Folder must be "input" or "output".' });
    }
    // Path traversal prevention
    const safeName = path.basename(filename);
    if (safeName !== filename || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    const filePath = path.join(`/srv/claude/users/${req.userId}`, folder, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    res.download(filePath, safeName);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Platform File Download (token-free, for Zoho/Slack/Discord links) ---
// Uses a short-lived signed token generated at time of file creation.
// Token = base64(userId:filename:timestamp) signed with JWT_SECRET — expires in 24h.
app.get('/api/platform/files/:token/:filename', (req, res) => {
  try {
    const { token, filename } = req.params;
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.userId || !decoded.filename || decoded.filename !== path.basename(filename)) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    const safeName = path.basename(filename);
    const filePath = path.join(`/srv/claude/users/${decoded.userId}`, 'output', safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.download(filePath, safeName);
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
});

// --- Delete File ---
app.delete('/api/files/:folder/:filename', authMiddleware, (req, res) => {
  try {
    const { folder, filename } = req.params;
    if (folder !== 'input' && folder !== 'output') {
      return res.status(400).json({ error: 'Folder must be "input" or "output".' });
    }
    const safeName = path.basename(filename);
    if (safeName !== filename || filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }

    const filePath = path.join(`/srv/claude/users/${req.userId}`, folder, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    fs.unlinkSync(filePath);
    fileListingCache.delete(req.userId); // Invalidate cached file listing — file removed
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Skills: List all available skills with categories ---
app.get('/api/skills', authMiddleware, (req, res) => {
  try {
    // Only reload from disk when cache is empty; avoids thrashing the filesystem
    // on every UI refresh. To force a reload, restart the backend or POST /api/models/sync.
    if (skillsCache.size === 0) {
      loadAllSkills();
    }
    const skills = Array.from(skillsCache.values())
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    res.json({ skills });
  } catch (err) {
    console.error('[Skills] Error listing skills:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Skills: Get user's skill preferences ---
app.get('/api/skills/preferences', authMiddleware, async (req, res) => {
  try {
    if (skillsCache.size === 0) loadAllSkills();
    const result = await pool.query(
      'SELECT skill_name, enabled FROM user_skills WHERE user_id = $1',
      [req.userId]
    );
    // Default: all skills ENABLED. Users may disable individual skills they don't want.
    // Skills with an explicit saved preference (enabled or disabled) respect the saved value.
    const preferences = {};
    for (const skill of skillsCache.values()) {
      preferences[skill.name] = true;
    }
    for (const row of result.rows) {
      preferences[row.skill_name] = row.enabled;
    }
    res.json({ preferences });
  } catch (err) {
    console.error('[Skills] Error getting preferences:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Skills: Save user's skill preferences ---
app.put('/api/skills/preferences', authMiddleware, async (req, res) => {
  try {
    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'preferences object is required' });
    }
    for (const [skillName, enabled] of Object.entries(preferences)) {
      if (typeof enabled !== 'boolean') continue;
      await pool.query(`
        INSERT INTO user_skills (user_id, skill_name, enabled)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, skill_name)
        DO UPDATE SET enabled = $3
      `, [req.userId, skillName, enabled]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Skills] Error saving preferences:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// === PLUGINS API ============================================
// ============================================================

// --- List all plugins ---
app.get('/api/plugins', authMiddleware, (req, res) => {
  try {
    const plugins = pluginManager.loadAllPlugins();
    res.json({ plugins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Get user's plugin preferences ---
app.get('/api/plugins/preferences', authMiddleware, async (req, res) => {
  try {
    const allPlugins = pluginManager.loadAllPlugins();
    const result = await pool.query(
      'SELECT plugin_name, enabled FROM user_plugins WHERE user_id = $1',
      [req.userId]
    );
    const preferences = {};
    for (const p of allPlugins) preferences[p.name] = false; // plugins off by default
    for (const row of result.rows) preferences[row.plugin_name] = row.enabled;
    res.json({ preferences });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Save user's plugin preferences ---
app.put('/api/plugins/preferences', authMiddleware, async (req, res) => {
  try {
    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'preferences object is required' });
    }
    for (const [name, enabled] of Object.entries(preferences)) {
      if (typeof enabled !== 'boolean') continue;
      await pool.query(`
        INSERT INTO user_plugins (user_id, plugin_name, enabled)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, plugin_name) DO UPDATE SET enabled = $3
      `, [req.userId, name, enabled]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// === MCP SERVERS API =========================================
// ============================================================

// --- List all MCP servers (system + user) ---
app.get('/api/mcp-servers', authMiddleware, async (req, res) => {
  try {
    const systemServers = pluginManager.listMcpServers().map(name => ({ name, source: 'system' }));
    const userResult    = await pool.query(
      'SELECT name, type, command, args, url, env, enabled FROM user_mcp_servers WHERE user_id = $1',
      [req.userId]
    );
    const userServers = userResult.rows.map(r => ({ ...r, source: 'user' }));
    res.json({ servers: [...systemServers, ...userServers] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Add or update a user-level MCP server ---
app.put('/api/mcp-servers', authMiddleware, async (req, res) => {
  try {
    const { name, type, command, args, url, env, enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    await pool.query(`
      INSERT INTO user_mcp_servers (user_id, name, type, command, args, url, env, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id, name) DO UPDATE
        SET type=$3, command=$4, args=$5, url=$6, env=$7, enabled=$8
    `, [req.userId, name, type||'stdio', command||null, JSON.stringify(args||[]), url||null, JSON.stringify(env||{}), enabled !== false]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Delete a user MCP server ---
app.delete('/api/mcp-servers/:name', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM user_mcp_servers WHERE user_id = $1 AND name = $2',
      [req.userId, req.params.name]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Chat Endpoint ---
app.post('/api/chat', authMiddleware, chatLimiter, async (req, res) => {
  const userId = req.userId; // From JWT
  const { message, conversationId, enabledSkills } = req.body;

  // Input validation
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required.' });
  if (message.length > 32768) return res.status(400).json({ error: 'Message too long (max 32KB).' });
  if (conversationId && isNaN(parseInt(conversationId, 10))) return res.status(400).json({ error: 'Invalid conversation ID.' });

  console.log(`[Chat] User ${userId} asks: ${message.substring(0, 100)}`);

  try {
    // 1. Resolve or create conversation
    let convId = conversationId ? parseInt(conversationId, 10) : null;
    if (convId) {
      const check = await pool.query(
        'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
        [convId, userId]
      );
      if (check.rows.length === 0) return res.status(403).json({ error: 'Conversation not found' });
    } else {
      const title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
      const result = await pool.query(
        'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id',
        [userId, title]
      );
      convId = result.rows[0].id;
    }

    // 2. Save user message
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [convId, 'user', message]
    );

    // 3. Ensure persistent container is running
    const containerName = await containerManager.ensureContainer(userId);

    // 4. Fetch last N messages for context (N = CONTEXT_MESSAGE_LIMIT from .env, default 3).
    // ORDER BY DESC LIMIT N avoids loading the whole conversation; reverse gives chronological order.
    const historyResult = await pool.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
      [convId, CONTEXT_MESSAGE_LIMIT]
    );
    const recentMessages = historyResult.rows.reverse().map(m => ({
      role: m.role,
      content: m.content.length > 2000 ? m.content.substring(0, 2000) + '... [truncated]' : m.content
    }));
    let historyBlock = '';
    if (recentMessages.length > 0) {
      historyBlock = '\n\n--- CONVERSATION HISTORY ---\n' +
        recentMessages.map(m => `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content}`).join('\n\n') +
        '\n--- END HISTORY ---\n\nThe user\'s latest message is provided as the main input. Use the conversation history above for context.';
    }

    // 5. Build system context — behavioral instructions + uploaded files + conversation history.
    // Uses --system-prompt to REPLACE Claude Code's native prompt because the
    // 7b model can't handle native tool definitions (outputs JSON tool calls).
    let systemContext = AGENT_INSTRUCTIONS;

    // 5a. List only files uploaded for THIS conversation (not all user files)
    try {
      if (convId) {
        const convFiles = await pool.query(
          `SELECT filename, size FROM conversation_files
           WHERE conversation_id = $1 AND folder = 'input' ORDER BY attached_at ASC`,
          [convId]
        );
        if (convFiles.rows.length > 0) {
          const fileListStr = convFiles.rows
            .map(f => `  input/${f.filename} (${(f.size / 1024).toFixed(1)} KB)`)
            .join('\n');
          systemContext += `\n\n--- FILES FOR THIS CONVERSATION ---\n${fileListStr}\n` +
            `These are the only files available. Do NOT read files from other sessions.\n--- END FILES ---`;
        }
      }
    } catch (e) {
      console.warn(`[Chat] Could not list conversation files:`, e.message);
    }

    if (historyBlock) {
      systemContext += '\n\n' + historyBlock.trim();
    }

    // 5c. Inject enabled skills into system prompt (per-message, from frontend)
    const skillsPrompt = getEnabledSkillsPrompt(enabledSkills);
    if (skillsPrompt) {
      systemContext += skillsPrompt;
      console.log(`[Chat] Skills injected: ${Array.isArray(enabledSkills) ? enabledSkills.length : 'none'} skill(s)`);
    }

    // 5b. Fetch user's selected model configuration
    let modelConfig = null;
    const modelPrefResult = await pool.query(`
      SELECT mc.api_endpoint, mc.model_identifier, mc.provider, mc.default_api_key, ump.user_api_key
      FROM user_model_preferences ump
      JOIN model_configs mc ON ump.model_config_id = mc.id
      WHERE ump.user_id = $1 AND mc.is_active = true
    `, [userId]);

    if (modelPrefResult.rows.length > 0) {
      const row = modelPrefResult.rows[0];
      modelConfig = {
        api_endpoint: row.api_endpoint,
        model_identifier: row.model_identifier,
        provider: row.provider,
        api_key: row.user_api_key || row.default_api_key || 'dummy-key'
      };
      console.log(`[Chat] Using model: ${modelConfig.model_identifier} (${modelConfig.provider}) at ${modelConfig.api_endpoint}`);
    } else {
      // Default to first model (Local Ollama)
      const defaultModelResult = await pool.query(
        'SELECT api_endpoint, model_identifier, provider, default_api_key FROM model_configs WHERE id = 1'
      );
      if (defaultModelResult.rows.length > 0) {
        const row = defaultModelResult.rows[0];
        modelConfig = {
          api_endpoint: row.api_endpoint,
          model_identifier: row.model_identifier,
          provider: row.provider,
          api_key: row.default_api_key || 'dummy-key'
        };
      }
    }

    // 6. Execute in persistent container (docker exec, not docker run)
    console.log(`[Chat] System context length: ${systemContext.length} chars`);
    let { stdout, stderr } = await containerManager.execInContainer(
      containerName, message, systemContext, modelConfig
    );
    console.log(`[Chat] Raw stdout (${stdout.length} chars):`, JSON.stringify(stdout.substring(0, 300)));
    if (stderr) console.warn(`[Chat] Agent stderr for user ${userId}:`, stderr.substring(0, 500));

    // 6b. If stdout is empty, check endpoint health and retry once
    if (!stdout.trim()) {
      const endpoint = (modelConfig?.api_endpoint || '').replace(/\/+$/, '') || undefined;
      console.warn(`[Chat] Empty response — checking endpoint health (${endpoint || 'default'})...`);
      const health = await containerManager.checkOllamaHealth(containerName, endpoint, modelConfig?.provider);
      console.log(`[Chat] Endpoint health:`, JSON.stringify(health));

      if (!health.ok) {
        return res.status(502).json({
          error: `Cannot reach model endpoint${endpoint ? ' at ' + endpoint : ''} (${health.reason}). Make sure the endpoint is running and reachable.`
        });
      }

      // Ollama is up — wait 2s before retrying (model may have needed to load)
      console.log(`[Chat] Retrying exec after 2s delay...`);
      await new Promise(r => setTimeout(r, 2000));
      const retry = await containerManager.execInContainer(
        containerName, message, systemContext, modelConfig
      );
      stdout = retry.stdout;
      stderr = retry.stderr;
      console.log(`[Chat] Retry stdout (${stdout.length} chars):`, JSON.stringify(stdout.substring(0, 300)));
      if (stderr) console.warn(`[Chat] Retry stderr:`, stderr.substring(0, 500));
    }

    // 7. Post-process output — parse tool-call JSON and execute file writes/commands
    const processed = await processAgentResponse(stdout, containerManager, containerName);
    console.log("Agent Reply:", processed);

    // 8. Save assistant response
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [convId, 'assistant', processed]
    );

    // 9. Update conversation timestamp
    await pool.query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [convId]
    );

    res.json({ reply: processed, conversationId: convId });

  } catch (err) {
    const execErr = err.error || err;
    console.error("Chat Error:", execErr.message || execErr);
    if (err.stderr) console.error("[Chat] Agent stderr:", err.stderr.substring(0, 500));
    let statusCode = 500;
    let userMessage = 'An error occurred while processing your request.';
    if (execErr.killed) {
      statusCode = 504;
      userMessage = 'Request timed out. Please try a shorter or simpler message.';
    } else if (execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      statusCode = 502;
      userMessage = 'The response was too large. Please try a more specific request.';
    }
    res.status(statusCode).json({ error: userMessage });
  }
});

// --- Chat Stream Endpoint (SSE) ---
// Streams real-time agent thinking, tool calls, and output as Server-Sent Events.
// Client reads via fetch() + response.body.getReader() (POST + SSE pattern).
app.post('/api/chat/stream', authMiddleware, chatLimiter, async (req, res) => {
  const userId = req.userId;
  const { message, conversationId, enabledSkills, enabledPlugins, agentTeam, agentCount } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (message.length > 32768) {
    return res.status(400).json({ error: 'Message too long (max 32KB).' });
  }
  if (conversationId && isNaN(parseInt(conversationId, 10))) {
    return res.status(400).json({ error: 'Invalid conversation ID.' });
  }

  // Helper: record a file snapshot (filename → mtime) of the workspace BEFORE the agent runs.
  // Returns a Map of "folder/filename" → mtime in ms.
  function getWorkspaceSnapshot(userId) {
    const snapshot = new Map();
    const baseDir = `/srv/claude/users/${userId}`;
    // Only snapshot user-visible folders — agent_input/agent_output intentionally excluded
    for (const folder of ['input', 'output']) {
      const dir = `${baseDir}/${folder}`;
      try {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          try {
            const stat = fs.statSync(`${dir}/${name}`);
            if (stat.isFile()) snapshot.set(`${folder}/${name}`, stat.mtimeMs);
          } catch {}
        }
      } catch {}
    }
    return snapshot;
  }

  // Helper: after the agent runs, compare workspace to the before-snapshot.
  // Records only NEW or MODIFIED files from this response turn.
  // Auto-zips output files if 5+ were generated in a single response.
  async function snapshotConversationFiles(convId, userId, beforeSnapshot) {
    try {
      const baseDir = `/srv/claude/users/${userId}`;
      const newOutputFiles = []; // tracks output files created in THIS response only

      // IMPORTANT: only 'input' and 'output' are scanned — 'agent_input' and
      // 'agent_output' are intentionally excluded. Those folders hold intermediate
      // phase-1 JSON blobs used internally by the agent team and must never appear
      // in the user's file panel or be downloadable.
      for (const folder of ['input', 'output']) {
        const dir = `${baseDir}/${folder}`;
        try {
          if (!fs.existsSync(dir)) continue;
          for (const name of fs.readdirSync(dir)) {
            try {
              // Skip auto-generated zip files to avoid re-zipping zips
              if (name.startsWith('output_files_') && name.endsWith('.zip')) continue;

              const stat = fs.statSync(`${dir}/${name}`);
              if (!stat.isFile()) continue;
              const key      = `${folder}/${name}`;
              const prevMtime = beforeSnapshot ? beforeSnapshot.get(key) : undefined;
              const isNew      = prevMtime === undefined;
              const isModified = prevMtime !== undefined && stat.mtimeMs > prevMtime;

              if (isNew || isModified) {
                await pool.query(`
                  INSERT INTO conversation_files (conversation_id, user_id, folder, filename, size)
                  VALUES ($1, $2, $3, $4, $5)
                  ON CONFLICT (conversation_id, folder, filename) DO UPDATE SET size = $5, attached_at = NOW()
                `, [convId, userId, folder, name, stat.size]);
                console.log(`[ConvFiles] ${isNew ? 'NEW' : 'MODIFIED'} file → conv ${convId}: ${key} (${stat.size} bytes)`);

                if (folder === 'output') newOutputFiles.push({ name, path: `${dir}/${name}` });
              }
            } catch {}
          }
        } catch {}
      }

      // Auto-zip: if 5+ output files produced in this single response, zip them all
      if (newOutputFiles.length >= 5) {
        try {
          const { execSync } = require('child_process');
          const outputDir = `${baseDir}/output`;
          const stamp     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const zipName   = `output_files_${stamp}.zip`;
          const zipPath   = `${outputDir}/${zipName}`;
          const fileList  = newOutputFiles.map(f => `"${f.name}"`).join(' ');

          execSync(`cd "${outputDir}" && zip -q "${zipPath}" ${fileList}`, { timeout: 30000 });

          const zipSize = fs.statSync(zipPath).size;
          await pool.query(`
            INSERT INTO conversation_files (conversation_id, user_id, folder, filename, size)
            VALUES ($1, $2, 'output', $3, $4)
            ON CONFLICT (conversation_id, folder, filename) DO UPDATE SET size = $4, attached_at = NOW()
          `, [convId, userId, zipName, zipSize]);

          console.log(`[ConvFiles] Auto-zipped ${newOutputFiles.length} output files → ${zipName} (${(zipSize/1024).toFixed(1)} KB)`);
        } catch (zipErr) {
          console.warn('[ConvFiles] Auto-zip failed:', zipErr.message);
        }
      }
    } catch (e) {
      console.warn('[ConvFiles] Snapshot error:', e.message);
    }
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Activity metadata tracking — persisted with the assistant message
  const activitySteps = [];   // [{type, icon, text, success?}]
  let tokenUsage = null;       // {input_tokens, output_tokens, total_tokens}

  // Helper: emit a typed SSE event AND record activity steps for persistence
  function emit(event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Persist thinking steps and tool events for replay after page refresh
    if (event === 'thinking' && data.text) {
      activitySteps.push({ type: 'thinking', icon: data.icon || '•', text: data.text });
    } else if (event === 'tool_call' && data.name) {
      let text = data.name;
      if (data.path) text += `: ${data.path}`;
      else if (data.command) text += `: ${data.command}`;
      else if (data.args) text += `: ${data.args}`;
      activitySteps.push({ type: 'tool_call', icon: '🔧', text });
    } else if (event === 'tool_result' && data.name) {
      const ok = data.success !== false;
      let text = ok ? `Done: ${data.name}` : `Failed: ${data.name}`;
      if (data.path) text = ok ? `${data.name}: ${data.path}` : `${data.name} failed: ${data.path}`;
      else if (data.command) text = ok ? `${data.command}` : `Failed: ${data.command}`;
      activitySteps.push({ type: 'tool_result', icon: ok ? '✅' : '❌', text, success: ok });
    } else if (event === 'error' && data.message) {
      activitySteps.push({ type: 'error', icon: '❌', text: data.message });
    }
  }

  // Keep connection alive with a comment ping every 5s (aggressive to survive proxies)
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 5000);

  const cleanup = () => {
    clearInterval(keepAlive);
  };

  res.on('close', cleanup);

  try {
    const startTime = Date.now();

    // Step 1: Resolve or create conversation
    let convId = conversationId ? parseInt(conversationId, 10) : null;
    if (convId) {
      const check = await pool.query(
        'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
        [convId, userId]
      );
      if (check.rows.length === 0) {
        emit('error', { message: 'Conversation not found' });
        res.end();
        return cleanup();
      }
    } else {
      const title = message.substring(0, 50) + (message.length > 50 ? '...' : '');
      const result = await pool.query(
        'INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id',
        [userId, title]
      );
      convId = result.rows[0].id;
    }

    // Save user message
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [convId, 'user', message]
    );

    // Snapshot workspace BEFORE agent runs — used later to detect new/modified files
    const workspaceBeforeSnapshot = getWorkspaceSnapshot(userId);

    // Step 2: Ensure container is running
    const containerName = await containerManager.ensureContainer(userId);

    // Step 3: Build context — fetch last N messages (N = CONTEXT_MESSAGE_LIMIT from .env).
    const historyResult = await pool.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
      [convId, CONTEXT_MESSAGE_LIMIT]
    );
    const recentMessages = historyResult.rows.reverse().map(m => ({
      role: m.role,
      content: m.content.length > 2000 ? m.content.substring(0, 2000) + '... [truncated]' : m.content
    }));
    let historyBlock = '';
    if (recentMessages.length > 0) {
      historyBlock = '\n\n--- CONVERSATION HISTORY ---\n' +
        recentMessages.map(m => `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content}`).join('\n\n') +
        '\n--- END HISTORY ---\n\nThe user\'s latest message is provided as the main input. Use the conversation history above for context.';
    }

    let systemContext = AGENT_INSTRUCTIONS;

    // List only files uploaded for THIS conversation — not all files in the user's folder.
    // Files from other conversations are irrelevant context and can confuse the agent.
    // The agent can still access the full input folder via Bash/Read tools if the user
    // explicitly asks (e.g. "check all files in my input folder").
    try {
      let fileListStr = null;
      if (convId) {
        // Fetch input files linked to this specific conversation from DB
        const convFilesResult = await pool.query(
          `SELECT filename, size FROM conversation_files
           WHERE conversation_id = $1 AND folder = 'input'
           ORDER BY attached_at ASC`,
          [convId]
        );
        if (convFilesResult.rows.length > 0) {
          fileListStr = convFilesResult.rows
            .map(f => `  input/${f.filename} (${(f.size / 1024).toFixed(1)} KB)`)
            .join('\n');
        }
      }
      if (fileListStr) {
        systemContext += `\n\n--- FILES UPLOADED FOR THIS CONVERSATION ---\n${fileListStr}\n` +
          `These are the only files available. Do NOT read files from other sessions.\n--- END FILES ---`;
      }
    } catch (e) {
      console.warn(`[Stream] Could not list conversation files:`, e.message);
    }

    if (historyBlock) {
      systemContext += '\n\n' + historyBlock.trim();
    }

    // Step 3b. Inject enabled skills into system prompt (per-message, from frontend)
    const skillsPrompt = getEnabledSkillsPrompt(enabledSkills);
    if (skillsPrompt) {
      systemContext += skillsPrompt;
      console.log(`[Stream] Skills injected: ${Array.isArray(enabledSkills) ? enabledSkills.length : 'none'} skill(s)`);
    }

    // Step 3c. Inject enabled plugins into system prompt
    // If frontend sends explicit list use it; otherwise load ALL available plugins.
    // Plugins are server-wide tools (MCP servers, integrations) — no per-user toggle UI yet.
    const activePlugins = enabledPlugins && Array.isArray(enabledPlugins) && enabledPlugins.length > 0
      ? enabledPlugins
      : (() => {
          try {
            const allPlugins = pluginManager.loadAllPlugins();
            return allPlugins.map(p => p.name);
          } catch { return []; }
        })();

    if (activePlugins.length > 0) {
      const pluginsPrompt = pluginManager.getEnabledPluginsPrompt(activePlugins);
      if (pluginsPrompt) {
        systemContext += pluginsPrompt;
        console.log(`[Stream] Plugins injected: ${activePlugins.length} plugin(s)`);
      }
    }

    // Step 3d. Resolve MCP server config — merge system plugins + user MCP servers
    const userMcpResult = await pool.query(
      'SELECT name, type, command, args, url, env FROM user_mcp_servers WHERE user_id = $1 AND enabled = true',
      [userId]
    );
    const userMcpServers = userMcpResult.rows.map(r => ({
      name: r.name, type: r.type, command: r.command,
      args: r.args, url: r.url, env: r.env,
    }));
    const mcpConfigJson = pluginManager.buildMcpConfigArg(activePlugins, userMcpServers);
    // mcpConfigJson will be passed to execInContainerStream via modelConfig extras

    // Step 4: Get model config — if auto_select is ON, use the LLM router to pick
    // the best model for THIS specific message + skills. Re-evaluated every message.
    // If auto_select is OFF, use the user's manually saved preference.
    let modelConfig = null;

    const modelPrefResult = await pool.query(`
      SELECT mc.api_endpoint, mc.model_identifier, mc.provider, mc.default_api_key, mc.is_capable,
             ump.user_api_key, COALESCE(ump.auto_select, false) as auto_select
      FROM user_model_preferences ump
      JOIN model_configs mc ON ump.model_config_id = mc.id
      WHERE ump.user_id = $1 AND mc.is_active = true
    `, [userId]);

    const userAutoSelect = modelPrefResult.rows[0]?.auto_select || false;

    if (userAutoSelect) {
      // AUTO MODE: run intent detection + router to pick best model per-message
      const allModelsResult = await pool.query(`
        SELECT id, name, provider, model_identifier, api_endpoint, default_api_key, is_capable,
               requires_api_key AND default_api_key IS NULL AS needs_user_key
        FROM model_configs WHERE is_active = true
      `);
      const usableModels = allModelsResult.rows.filter(m => !m.needs_user_key);
      const bestModel = selectBestModel(usableModels, message, enabledSkills);

      if (bestModel) {
        modelConfig = {
          api_endpoint: bestModel.api_endpoint,
          model_identifier: bestModel.model_identifier,
          provider: bestModel.provider,
          is_capable: bestModel.is_capable || false,
          api_key: bestModel.default_api_key || 'dummy-key'
        };
        console.log(`[Stream] AUTO mode: routed to "${modelConfig.model_identifier}" (${modelConfig.provider})`);
      }
    }

    // MANUAL MODE (or auto failed to find a model): use saved preference
    if (!modelConfig) {
      if (modelPrefResult.rows.length > 0) {
        const row = modelPrefResult.rows[0];
        modelConfig = {
          api_endpoint: row.api_endpoint,
          model_identifier: row.model_identifier,
          provider: row.provider,
          is_capable: row.is_capable || false,
          api_key: row.user_api_key || row.default_api_key || 'dummy-key'
        };
        console.log(`[Stream] MANUAL mode: using "${modelConfig.model_identifier}" (${modelConfig.provider})`);
      } else {
        const defaultModelResult = await pool.query(
          'SELECT api_endpoint, model_identifier, provider, default_api_key, is_capable FROM model_configs WHERE id = 1'
        );
        if (defaultModelResult.rows.length > 0) {
          const row = defaultModelResult.rows[0];
          modelConfig = {
            api_endpoint: row.api_endpoint,
            model_identifier: row.model_identifier,
            provider: row.provider,
            is_capable: row.is_capable || false,
            api_key: row.default_api_key || 'dummy-key'
          };
        }
      }
    }

    const modelName = modelConfig?.model_identifier || 'default model';
    const provider = (modelConfig?.provider || 'ollama').toLowerCase();
    const CAPABLE_PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter'];
    // A model is "capable" if its provider is a known cloud API, OR if explicitly
    // marked is_capable=true in the DB (e.g. capable Ollama models like qwen3-coder:30b).
    const isCapable = CAPABLE_PROVIDERS.includes(provider) || !!modelConfig?.is_capable;

    // For capable models, rebuild the system context — but the approach differs by provider:
    //
    // CLOUD providers (anthropic, openai, google, etc.):
    //   Use full CAPABLE_SYSTEM_PROMPT + files + history + skills.
    //   Large context windows handle this well.
    //
    // CAPABLE OLLAMA models (gpt-oss, qwen3-coder, etc.):
    //   Use --append-system-prompt with MINIMAL content only.
    //   CLAUDE.md inside the container already provides workspace path rules.
    //   Skills are auto-discovered from /home/node/app/.claude/skills/ by Claude CLI.
    //   Adding CAPABLE_SYSTEM_PROMPT + skills list DEGRADES tool execution:
    //   the model gets overwhelmed with redundant context and hallucinates file creation
    //   instead of actually invoking Write/Bash. Keep appended content to files + history only.
    if (isCapable) {
      if (provider === 'ollama') {
        // Minimal append for capable Ollama models — do not repeat what CLAUDE.md already says,
        // do not inject skills (auto-discovered from disk), do not add workspace rules.
        let ollamaCapableContext = '';
        // Only inject files that belong to this conversation
        try {
          const olmFiles = convId ? await pool.query(
            `SELECT filename, size FROM conversation_files
             WHERE conversation_id = $1 AND folder = 'input' ORDER BY attached_at ASC`, [convId]
          ) : { rows: [] };
          if (olmFiles.rows.length > 0) {
            const olmFileStr = olmFiles.rows.map(f => `  input/${f.filename} (${(f.size/1024).toFixed(1)} KB)`).join('\n');
            ollamaCapableContext += `=== FILES FOR THIS CONVERSATION ===\n${olmFileStr}\n=== END FILES ===`;
          }
        } catch (_) {}
        if (historyBlock) {
          ollamaCapableContext += (ollamaCapableContext ? '\n\n' : '') + historyBlock.trim();
        }
        systemContext = ollamaCapableContext;
        console.log(`[Stream] Capable Ollama model — minimal append context: ${systemContext.length} chars`);
      } else {
        // Full context for cloud API providers (anthropic, openai, google, groq, openrouter).
        let capableContext = CAPABLE_SYSTEM_PROMPT;
        // Only inject files that belong to this conversation
        try {
          const cldFiles = convId ? await pool.query(
            `SELECT filename, size FROM conversation_files
             WHERE conversation_id = $1 AND folder = 'input' ORDER BY attached_at ASC`, [convId]
          ) : { rows: [] };
          if (cldFiles.rows.length > 0) {
            const cldFileStr = cldFiles.rows.map(f => `  input/${f.filename} (${(f.size/1024).toFixed(1)} KB)`).join('\n');
            capableContext += `\n\n--- FILES FOR THIS CONVERSATION ---\n${cldFileStr}\n` +
              `Do NOT read files from other sessions.\n--- END FILES ---`;
          }
        } catch (_) {}
        if (historyBlock) capableContext += '\n\n' + historyBlock.trim();
        if (skillsPrompt) capableContext += skillsPrompt;
        // Also inject active plugins into capable cloud context
        if (activePlugins.length > 0) {
          const pluginsForContext = pluginManager.getEnabledPluginsPrompt(activePlugins);
          if (pluginsForContext) capableContext += pluginsForContext;
        }
        systemContext = capableContext;
        console.log(`[Stream] Capable cloud model — CAPABLE_SYSTEM_PROMPT: ${capableContext.length} chars`);
      }
    }

    // ── Execution plan — LLM-driven intent planner ──────────────────────────────
    const mcpNamesForPlan = userMcpServers.map(s => s.name);

    // Collect attached file metadata for the planner
    const attachedFileMeta = (() => {
      try {
        const inputDir = `/srv/claude/users/${userId}/input`;
        if (!require('fs').existsSync(inputDir)) return [];
        return require('fs').readdirSync(inputDir).map(f => ({
          name: f,
          type: require('path').extname(f).replace('.', '') || 'unknown',
        }));
      } catch { return []; }
    })();

    // ── Multi-turn: load prior execution context if this is Turn 2+ ──────────
    const priorContext = convId ? await loadExecutionContext(pool, convId) : null;

    let intentPlan  = null;
    let turnMode    = 'NEW';   // NEW | PATCH | EXTEND | REBUILD

    if (priorContext) {
      // Turn 2+: classify what the user wants relative to prior work
      let models = [];
      try {
        const mr = await pool.query('SELECT id, name, provider, model_identifier, api_endpoint, default_api_key, is_capable, is_active FROM model_configs WHERE is_active = true');
        models = mr.rows;
      } catch {}

      const classification = await classifyTurnIntent(pool, message, priorContext, models);
      turnMode = classification.mode;

      emit('plan_status', { icon: '🔄', text: `Turn context loaded — mode: ${turnMode} (${classification.reason})` });
      console.log(`[Plan] Turn mode: ${turnMode} — ${classification.reason}`);

      if (turnMode === 'PATCH') {
        // Targeted change — single synthesis agent with injected prior context
        // No planner call, no parallel agents needed
        emit('plan_status', { icon: '🩹', text: 'PATCH mode — targeted change, skipping re-analysis' });
        intentPlan = {
          intent:    `PATCH: ${message}`,
          complexity: 'simple',
          _meta:     { generator: 'patch-router', validator: 'none' },
          phases: [{
            phase: 1,
            mode:  'synthesis',
            steps: [{
              id:           1,
              task:         buildPatchTask(message, priorContext),
              driven_by:    'patch-router',
              input_files:  ['ALL_PRIOR_OUTPUTS'],
              output_schema: '',
              dependsOn:    [],
              canRunInParallel: false,
            }],
          }],
        };
      } else if (turnMode === 'EXTEND') {
        // New workstream on top of existing — re-plan but inject prior context
        emit('plan_status', { icon: '➕', text: 'EXTEND mode — planning new workstream on top of prior output' });
        try {
          const extendedMessage = buildExtendContext(message, priorContext);
          intentPlan = await buildIntentPlan(
            pool, extendedMessage, attachedFileMeta,
            enabledSkills, activePlugins, userMcpServers, pluginManager, emit
          );
        } catch (planErr) {
          console.warn(`[Plan] EXTEND planner failed: ${planErr.message} — single agent`);
          intentPlan = null;
        }
      } else {
        // REBUILD — full re-plan from scratch, ignore prior context
        emit('plan_status', { icon: '🔁', text: 'REBUILD mode — starting fresh plan' });
        try {
          intentPlan = await buildIntentPlan(
            pool, message, attachedFileMeta,
            enabledSkills, activePlugins, userMcpServers, pluginManager, emit
          );
        } catch (planErr) {
          console.warn(`[Plan] REBUILD planner failed: ${planErr.message} — single agent`);
          intentPlan = null;
        }
      }
    } else {
      // Turn 1 — fresh plan
      try {
        intentPlan = await buildIntentPlan(
          pool, message, attachedFileMeta,
          enabledSkills, activePlugins, userMcpServers, pluginManager,
          emit
        );
      } catch (planErr) {
        console.warn(`[Plan] Planner threw unexpectedly: ${planErr.message} — single agent`);
        intentPlan = null;
      }
    }

    // Fall back to heuristic plan for tier/intent detection (model selection still needs it)
    const execPlan = buildExecutionPlan(message, enabledSkills, activePlugins, mcpNamesForPlan);
    console.log(`[Plan] tier=${execPlan.tier} intent=${execPlan.intent} | intentPlan=${intentPlan ? intentPlan.phases?.length + ' phases' : 'null→single'}`);

    // IDE/API callers may force team mode; intentPlan drives it otherwise
    const runAsTeam = (intentPlan !== null) || (agentTeam === true);

    if (runAsTeam) {
      const teamAgentCount = intentPlan
        ? Math.max(...(intentPlan.phases || []).map(p => (p.steps || []).length), 1)
        : execPlan.agentCount;
      emit('thinking', { step: 'agent_team_start', text: 'Working on this...', icon: '⚡' });
      let teamReply = '';
      try {
        const teamResult = await agentTeamManager.runTeam(containerName, {
          task:          message,
          systemContext,
          modelConfig,
          executionPlan: intentPlan,           // ← new: structured phase plan
          agentCount:    teamAgentCount,
          agentRoles:    execPlan.agentRoles,  // legacy fallback roles
          userId,
          onChunk: (sseChunk) => {
            for (const line of sseChunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === 'agent_text')   { emit('agent_text', { text: evt.text }); teamReply += evt.text; }
                if (evt.type === 'agent_spawn')  emit('thinking', { step: 'working', text: 'Working...', icon: '⚡' });
                if (evt.type === 'tool_call')    emit('tool_call', { name: evt.name });
                if (evt.type === 'final_result') { emit('agent_text', { text: evt.text }); teamReply = evt.text || teamReply; }
                if (evt.type === 'plan_status')  emit('plan_status', { icon: evt.icon, text: evt.text });
              } catch {}
            }
          },
        });
        if (!teamReply && teamResult.stdout) teamReply = teamResult.stdout.trim();
      } catch (teamErr) {
        const e = teamErr.error || teamErr;
        if (e.killed) {
          emit('error', { message: 'Request timed out. Please try breaking it into smaller tasks.' });
          cleanup(); if (!res.writableEnded) res.end(); return;
        }
        // Team failed — fall through to single agent
        console.warn(`[AgentTeam] Team failed (${e.message}), falling back to single agent`);
        res._teamFallback = { reason: intentPlan ? 'intent_plan_runtime_error' : execPlan.reason, agent_count: teamAgentCount, error: e.message };
      }
      if (teamReply) {
        const teamElapsed = (Date.now() - startTime) / 1000;
        const teamMeta = JSON.stringify({
          elapsed_seconds: teamElapsed,
          team: {
            used: true,
            agent_count: teamAgentCount,
            intent_plan: intentPlan ? { phases: intentPlan.phases?.length, intent: intentPlan.intent, generator: intentPlan._meta?.generator, validator: intentPlan._meta?.validator } : null,
            reason:      intentPlan ? 'intent_based_plan' : execPlan.reason,
            turn_mode:   turnMode || 'NEW',
            agent_roles: execPlan.agentRoles,
            capability_flags: execPlan.capabilityFlags,
            fallback: false,
          },
          model: modelConfig ? { identifier: modelConfig.model_identifier, provider: modelConfig.provider } : null,
          skills: enabledSkills || [],
          plugins: activePlugins || [],
          mcp_servers: mcpNamesForPlan || [],
        });
        await pool.query('INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1,$2,$3,$4)', [convId, 'assistant', teamReply, teamMeta]);
        await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [convId]);
        await snapshotConversationFiles(convId, userId, workspaceBeforeSnapshot);

        // ── Async post-turn summarizer (fire-and-forget, never blocks response) ──
        // Skipped for PATCH turns — prior context is still valid, nothing new to summarize.
        if (intentPlan && intentPlan.phases && turnMode !== 'PATCH') {
          const phase1Outputs = agentTeamManager._lastPhase1Outputs || [];
          pool.query('SELECT id, name, provider, model_identifier, api_endpoint, default_api_key, is_capable, is_active FROM model_configs WHERE is_active = true')
            .then(mr => summarizeExecution(pool, convId, userId, message, phase1Outputs, teamReply, intentPlan, mr.rows))
            .catch(e => console.warn('[Summarizer] Fire-and-forget error:', e.message));
        }

        emit('done', { conversationId: convId, reply: teamReply });
        cleanup(); if (!res.writableEnded) res.end(); return;
      }
    }

    // Attach MCP config so containerManager can pass --mcp-config
    if (mcpConfigJson) {
      modelConfig = { ...modelConfig, mcpConfig: mcpConfigJson };
      console.log(`[Stream] MCP config: ${Object.keys(JSON.parse(mcpConfigJson).mcpServers || {}).length} server(s)`);
    }

    emit('thinking', { step: 'agent_start', text: 'Working on it...', icon: '⚡' });

        emit('thinking', { step: 'agent_start', text: `Calling agent [${modelName}]...`, icon: '🤖' });

    // Step 5: Stream agent output using --output-format stream-json for ALL models.
    // The claude CLI's stream-json flag controls its STDOUT format — it works regardless
    // of whether the backend is Anthropic, OpenAI, or Ollama. This gives us structured
    // newline-delimited JSON events showing text blocks, tool calls, and the final result.
    let rawOutput = '';
    let jsonLineBuffer = '';
    let finalResult = null;    // Set from stream-json "result" event
    let collectedText = '';    // Accumulated text content (for Ollama FILE:/COMMAND: post-processing)

    const onChunk = (chunk) => {
      rawOutput += chunk;
      jsonLineBuffer += chunk;

      // Split on newlines and process each complete JSON line
      const lines = jsonLineBuffer.split('\n');
      jsonLineBuffer = lines.pop(); // keep the last (possibly incomplete) line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const event = JSON.parse(trimmed);

          if (event.type === 'assistant') {
            // Stream each content block as it arrives
            const content = event.message?.content || [];
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                // Live-stream the agent's text to the frontend
                emit('agent_text', { text: block.text });
                collectedText += block.text; // accumulate for post-processing
              } else if (block.type === 'tool_use') {
                // Show which tool the agent is invoking
                const toolName = block.name || 'unknown';
                const input = block.input || {};
                if (toolName === 'Read' || toolName === 'read_file' || toolName === 'view') {
                  emit('tool_call', { name: 'Read', path: (input.file_path || input.path || '').replace('/home/node/app/workspace/', '') });
                } else if (toolName === 'Write' || toolName === 'write_file' || toolName === 'str_replace_editor' || toolName === 'create_file') {
                  emit('tool_call', { name: 'Write', path: (input.path || input.file_path || '').replace('/home/node/app/workspace/', '') });
                } else if (toolName.toLowerCase() === 'bash' || toolName === 'execute_command') {
                  const cmd = input.command || input.cmd || '';
                  emit('tool_call', { name: 'Bash', command: cmd.length > 80 ? cmd.substring(0, 80) + '...' : cmd });
                } else if (toolName === 'LS' || toolName === 'list_directory') {
                  emit('tool_call', { name: 'List', path: (input.path || '').replace('/home/node/app/workspace/', '') || 'workspace' });
                } else {
                  emit('tool_call', { name: toolName, args: JSON.stringify(input).substring(0, 100) });
                }
              }
            }
          } else if (event.type === 'result') {
            // Claude CLI's final clean answer — use this as the definitive reply
            finalResult = event.result || '';
            // Extract token usage if available (Anthropic/OpenAI/capable models)
            if (event.usage) {
              const u = event.usage;
              tokenUsage = {
                input_tokens: u.input_tokens || 0,
                output_tokens: u.output_tokens || 0,
                total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0)
              };
            }
          }
          // Ignore: system/init, user/tool_result, etc.

        } catch (e) {
          // Not valid JSON (plain text line or partial line) — treat as live text
          if (trimmed && !trimmed.startsWith('{')) {
            emit('agent_text', { text: trimmed });
            collectedText += trimmed + '\n';
          }
        }
      }
    };

    let streamResult;
    try {
      // Enable stream-json for ALL models — it is a claude CLI output flag,
      // not an API flag. Works with Ollama, OpenAI, Anthropic, etc.
      streamResult = await containerManager.execInContainerStream(
        containerName, message, systemContext, modelConfig, onChunk,
        { streamJson: true }, userId
      );
    } catch (streamErr) {
      const execErr = streamErr.error || streamErr;
      // Check endpoint health on failure
      if (!rawOutput.trim()) {
        const endpoint = (modelConfig?.api_endpoint || '').replace(/\/+$/, '') || undefined;
        const health = await containerManager.checkOllamaHealth(containerName, endpoint, modelConfig?.provider);
        if (!health.ok) {
          emit('error', { message: `Cannot reach model endpoint (${health.reason}). Make sure the model server is running.` });
          res.end();
          return cleanup();
        }
      }
      if (execErr.killed) {
        emit('error', { message: 'Request timed out. Please try a shorter or simpler message.' });
      } else {
        emit('error', { message: 'Agent execution failed. Please try again.' });
      }
      res.end();
      return cleanup();
    }

    // Flush any remaining data in the JSON line buffer
    if (jsonLineBuffer.trim()) {
      try {
        const event = JSON.parse(jsonLineBuffer.trim());
        if (event.type === 'result') {
          finalResult = event.result || '';
        } else if (event.type === 'assistant') {
          const content = event.message?.content || [];
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              collectedText += block.text;
              emit('agent_text', { text: block.text });
            }
          }
        }
      } catch (_) {
        // Not JSON — treat as plain text output (stream-json may not have started)
        const t = jsonLineBuffer.trim();
        if (t) { collectedText += t; emit('agent_text', { text: t }); }
      }
    }

    const WORKSPACE = '/home/node/app/workspace/';
    let processed;

    if (isCapable) {
      // For capable models: the claude CLI ideally handles all tool calls internally.
      // The stream-json "result" event contains the clean final answer.
      // HOWEVER: capable Ollama models (gpt-oss, qwen3-coder, etc.) cannot actually
      // invoke Claude CLI's native tool_use mechanism. They output FILE:/COMMAND:
      // patterns as text instead. We must parse and execute those patterns here,
      // otherwise files are "created" only in the model's text — never on disk.
      const baseText = finalResult || collectedText.trim() || 'No response received.';

      // Check the collected text blocks for FILE:/COMMAND: patterns the native tools
      // may have missed (common with all Ollama models regardless of capability flag).
      const textToParse = collectedText.trim();
      const { toolCalls: pendingCalls, text: cleanText } = textToParse
        ? extractToolCalls(textToParse)
        : { toolCalls: [], text: baseText };

      if (pendingCalls.length > 0) {
        emit('thinking', { step: 'processing', text: 'Processing agent output...', icon: '⚙️' });
        const capableResults = [];

        for (const tc of pendingCalls) {
          const name = (tc.name || '').toLowerCase();
          const args = tc.arguments || {};

          if (name === 'write' || name === 'create' || name === 'write_to_file') {
            let filePath = args.file_path || args.path || args.filePath || '';
            const content = args.content || '';
            if (filePath && !filePath.startsWith('/')) filePath = WORKSPACE + filePath;
            // Redirect files outside output/ to output/ subdirectory
            if (filePath.startsWith(WORKSPACE) && !filePath.startsWith(WORKSPACE + 'output/') && !filePath.startsWith(WORKSPACE + 'input/')) {
              filePath = WORKSPACE + 'output/' + filePath.replace(WORKSPACE, '');
            }
            if (filePath && filePath.startsWith(WORKSPACE) && content) {
              const shortPath = filePath.replace(WORKSPACE, '');
              emit('thinking', { step: 'writing', text: `Writing file: ${shortPath}`, icon: '💾' });
              try {
                await containerManager.writeFileInContainer(containerName, filePath, content);
                emit('tool_result', { name: 'Write', path: shortPath, success: true });
                const lang = shortPath.split('.').pop() || '';
                capableResults.push(`Created \`${shortPath}\`:\n\`\`\`${lang}\n${content}\n\`\`\``);
              } catch (err) {
                emit('tool_result', { name: 'Write', path: shortPath, success: false, error: err.message });
                capableResults.push(`Failed to create \`${shortPath}\`: ${err.message}`);
              }
            }
          } else if (name === 'bash' || name === 'execute' || name === 'run' || name === 'shell') {
            const command = args.command || args.cmd || '';
            if (command) {
              const shortCmd = command.length > 60 ? command.substring(0, 60) + '...' : command;
              emit('thinking', { step: 'running', text: `Running: ${shortCmd}`, icon: '⚡' });
              try {
                const out = await containerManager.runCommandInContainer(containerName, command);
                const truncated = out.length > 2000 ? out.substring(0, 2000) + '\n... (truncated)' : out;
                emit('tool_result', { name: 'Bash', command: shortCmd, success: true, output: out.length > 500 ? out.substring(0, 500) + '...' : out });
                capableResults.push(`Ran \`${command}\`:\n\`\`\`\n${truncated}\n\`\`\``);
              } catch (err) {
                emit('tool_result', { name: 'Bash', command: shortCmd, success: false, error: err.message });
                capableResults.push(`Command \`${command}\` failed: ${err.message}`);
              }
            }
          }
        }

        // Use clean text (FILE:/COMMAND: patterns stripped) + execution results.
        // Fall back to baseText if cleanText is empty (e.g. model only output file blocks).
        const textPart = cleanText.trim() || baseText;
        processed = [textPart, ...capableResults].filter(Boolean).join('\n\n');
      } else {
        // No FILE:/COMMAND: patterns found — native tools handled everything (or no files).
        processed = baseText;
      }
    } else {
      // For Ollama/weak models: parse FILE:/COMMAND: patterns from the collected
      // text content (not raw stdout, which is now stream-json lines).
      emit('thinking', { step: 'processing', text: 'Processing agent output...', icon: '⚙️' });

      // Use collectedText (extracted from stream-json text blocks) for tool parsing.
      // Fall back to raw stdout if stream-json didn't work (model may not support it).
      const textToParse = collectedText.trim() || streamResult.stdout.trim();
      const { toolCalls, text: textContent } = extractToolCalls(textToParse);

      // Feature 2 fix: detect when model outputs ONLY unrecognized tool calls
      // (e.g. "skill" calls) with no text content — retry with plain-text instruction
      const KNOWN_TOOLS = ['write', 'create', 'write_to_file', 'bash', 'execute', 'run', 'shell'];
      const hasOnlyUnrecognizedTools = toolCalls.length > 0 &&
        toolCalls.every(tc => !KNOWN_TOOLS.includes((tc.name || '').toLowerCase())) &&
        !textContent.trim();

      if (hasOnlyUnrecognizedTools) {
        emit('thinking', { step: 'retry', text: 'Retrying with plain-text prompt...', icon: '🔄' });
        let retryOutput = '';
        const noToolMsg = message + '\n\nIMPORTANT: Respond with plain text only. Do NOT output JSON, tool calls, or skill calls. Write your answer directly as readable text.';
        try {
          const retryResult = await containerManager.execInContainerStream(
            containerName, noToolMsg, systemContext, modelConfig,
            (chunk) => { retryOutput += chunk; }
          );
          const { toolCalls: rtc, text: rtext } = extractToolCalls(retryResult.stdout.trim());
          const retryResults = [];
          for (const tc of rtc) {
            const name = (tc.name || '').toLowerCase();
            const args = tc.arguments || {};
            if (name === 'write' || name === 'create' || name === 'write_to_file') {
              let filePath = args.file_path || args.path || args.filePath || '';
              const content = args.content || '';
              if (filePath && !filePath.startsWith('/')) filePath = WORKSPACE + filePath;
              // Redirect files outside output/ to output/ subdirectory
              if (filePath.startsWith(WORKSPACE) && !filePath.startsWith(WORKSPACE + 'output/') && !filePath.startsWith(WORKSPACE + 'input/')) {
                filePath = WORKSPACE + 'output/' + filePath.replace(WORKSPACE, '');
              }
              if (filePath && filePath.startsWith(WORKSPACE) && content) {
                const shortPath = filePath.replace(WORKSPACE, '');
                try {
                  await containerManager.writeFileInContainer(containerName, filePath, content);
                  emit('tool_result', { name: 'Write', path: shortPath, success: true });
                  const lang = shortPath.split('.').pop() || '';
                  retryResults.push(`Created \`${shortPath}\`:\n\`\`\`${lang}\n${content}\n\`\`\``);
                } catch (err) {
                  retryResults.push(`Failed to create \`${shortPath}\`: ${err.message}`);
                }
              }
            }
          }
          processed = [rtext, ...retryResults].filter(Boolean).join('\n\n') ||
            'I was unable to complete that request. Please try rephrasing your question.';
        } catch (_) {
          processed = 'I was unable to complete that request. Please try rephrasing your question.';
        }
      } else {
        // Normal Ollama processing: execute FILE: writes and COMMAND: runs
        const results = [];
        for (const tc of toolCalls) {
          const name = (tc.name || '').toLowerCase();
          const args = tc.arguments || {};

          if (name === 'write' || name === 'create' || name === 'write_to_file') {
            let filePath = args.file_path || args.path || args.filePath || '';
            const content = args.content || '';
            if (filePath && !filePath.startsWith('/')) filePath = WORKSPACE + filePath;
            // Redirect files outside output/ to output/ subdirectory
            if (filePath.startsWith(WORKSPACE) && !filePath.startsWith(WORKSPACE + 'output/') && !filePath.startsWith(WORKSPACE + 'input/')) {
              filePath = WORKSPACE + 'output/' + filePath.replace(WORKSPACE, '');
            }
            if (filePath && filePath.startsWith(WORKSPACE) && content) {
              const shortPath = filePath.replace(WORKSPACE, '');
              emit('thinking', { step: 'writing', text: `Writing file: ${shortPath}`, icon: '💾' });
              try {
                await containerManager.writeFileInContainer(containerName, filePath, content);
                emit('tool_result', { name: 'Write', path: shortPath, success: true });
                const lang = shortPath.split('.').pop() || '';
                results.push(`Created \`${shortPath}\`:\n\`\`\`${lang}\n${content}\n\`\`\``);
              } catch (err) {
                emit('tool_result', { name: 'Write', path: shortPath, success: false, error: err.message });
                results.push(`Failed to create \`${shortPath}\`: ${err.message}`);
              }
            }
          } else if (name === 'bash' || name === 'execute' || name === 'run' || name === 'shell') {
            const command = args.command || args.cmd || '';
            if (command) {
              const shortCmd = command.length > 60 ? command.substring(0, 60) + '...' : command;
              emit('thinking', { step: 'running', text: `Running: ${shortCmd}`, icon: '⚡' });
              try {
                const out = await containerManager.runCommandInContainer(containerName, command);
                const truncated = out.length > 2000 ? out.substring(0, 2000) + '\n... (truncated)' : out;
                emit('tool_result', { name: 'Bash', command: shortCmd, success: true, output: out.length > 500 ? out.substring(0, 500) + '...' : out });
                results.push(`Ran \`${command}\`:\n\`\`\`\n${truncated}\n\`\`\``);
              } catch (err) {
                emit('tool_result', { name: 'Bash', command: shortCmd, success: false, error: err.message });
                results.push(`Command \`${command}\` failed: ${err.message}`);
              }
            }
          }
        }
        processed = [textContent, ...results].filter(Boolean).join('\n\n') || streamResult.stdout.trim() || 'No response received.';
      }
    }

    // Build metadata to persist with the assistant message
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const elapsedNum = parseFloat(elapsed);

    // If no token usage from stream-json, estimate from response length (~4 chars/token)
    if (!tokenUsage && processed) {
      const estimatedOutput = Math.ceil(processed.length / 4);
      tokenUsage = { input_tokens: 0, output_tokens: estimatedOutput, total_tokens: estimatedOutput, estimated: true };
    }

    const metadata = {
      elapsed_seconds: elapsedNum,
      tokens: tokenUsage,
      activity_steps: activitySteps.length > 0 ? activitySteps : null,
      model: modelConfig ? {
        identifier: modelConfig.model_identifier,
        provider: modelConfig.provider
      } : null,
      // Execution plan — always present so admin can query team vs single-agent usage
      team: res._teamFallback ? {
        used: false,
        fallback: true,
        fallback_reason: res._teamFallback.reason,
        fallback_error: res._teamFallback.error,
        intended_agent_count: res._teamFallback.agent_count,
      } : {
        used: false,
        fallback: false,
        planned_team: runAsTeam || false,
      },
      plan: {
        tier:             execPlan.tier,
        intent:           intentPlan?.intent || execPlan.intent,
        reason:           intentPlan ? 'intent_based_plan' : execPlan.reason,
        turn_mode:        turnMode || 'NEW',
        phases:           intentPlan?.phases?.length || 1,
        generator:        intentPlan?._meta?.generator || null,
        validator:        intentPlan?._meta?.validator || null,
        capability_flags: execPlan.capabilityFlags,
      },
      skills: enabledSkills || [],
      plugins: activePlugins || [],
      mcp_servers: mcpNamesForPlan || [],
    };

    // Save assistant response with metadata and update conversation
    await pool.query(
      'INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
      [convId, 'assistant', processed, JSON.stringify(metadata)]
    );
    await pool.query(
      'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
      [convId]
    );

    // Snapshot files used in this conversation — only NEW or MODIFIED files since request started
    snapshotConversationFiles(convId, userId, workspaceBeforeSnapshot).catch(() => {});

    emit('done', { reply: processed, conversationId: convId, elapsed: elapsedNum, tokens: tokenUsage, activity_steps: activitySteps });

  } catch (err) {
    console.error('[Stream] Error:', err.message || err);
    emit('error', { message: 'An unexpected error occurred. Please try again.' });
  } finally {
    cleanup();
    if (!res.writableEnded) res.end();
  }
});

// --- Stop Agent ---
app.post('/api/chat/stop', authMiddleware, async (req, res) => {
  const userId = req.userId;
  console.log(`[Stop] User ${userId} requested agent stop`);
  const stopped = containerManager.stopStream(userId);
  if (stopped) {
    res.json({ success: true, message: 'Agent stopped.' });
  } else {
    res.json({ success: false, message: 'No active agent to stop.' });
  }
});

// ============================================================
// === ADMIN API ===
// ============================================================

async function adminMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    const result = await pool.query('SELECT id, is_admin FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows[0]?.is_admin) return res.status(403).json({ error: 'Admin access required' });
    req.userId = decoded.userId;
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// --- Admin Login (promotes an existing user to admin or creates admin) ---
app.post('/api/admin/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.is_admin) return res.status(403).json({ error: 'Not an admin account' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, userId: user.id, email: user.email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Create/promote admin user ---
app.post('/api/admin/setup', async (req, res) => {
  try {
    const { email, password, setupKey } = req.body;
    // Require ADMIN_SETUP_KEY env var to prevent unauthorized setup
    const key = process.env.ADMIN_SETUP_KEY || 'ez-admin-setup';
    if (setupKey !== key) return res.status(403).json({ error: 'Invalid setup key' });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [email]);
      return res.json({ success: true, message: 'User promoted to admin' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (email, password_hash, is_admin) VALUES ($1, $2, true)', [email, hash]);
    res.json({ success: true, message: 'Admin user created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Platform overview KPIs ---
app.get('/api/admin/overview', adminMiddleware, async (req, res) => {
  try {
    const { rows: [kpis] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_admin = false OR is_admin IS NULL) AS total_users,
        (SELECT COUNT(*) FROM conversations) AS total_conversations,
        (SELECT COUNT(*) FROM messages) AS total_messages,
        (SELECT COUNT(*) FROM messages WHERE role = 'user') AS user_messages,
        (SELECT COUNT(*) FROM messages WHERE role = 'assistant') AS assistant_messages,
        (SELECT COALESCE(SUM((metadata->>'elapsed_seconds')::numeric), 0) FROM messages WHERE metadata->>'elapsed_seconds' IS NOT NULL) AS total_response_seconds,
        (SELECT COALESCE(AVG((metadata->>'elapsed_seconds')::numeric), 0) FROM messages WHERE metadata->>'elapsed_seconds' IS NOT NULL) AS avg_response_seconds,
        (SELECT COALESCE(SUM((metadata->'tokens'->>'total_tokens')::bigint), 0) FROM messages WHERE metadata->'tokens' IS NOT NULL) AS total_tokens,
        (SELECT COALESCE(SUM((metadata->'tokens'->>'input_tokens')::bigint), 0) FROM messages WHERE metadata->'tokens' IS NOT NULL) AS total_input_tokens,
        (SELECT COALESCE(SUM((metadata->'tokens'->>'output_tokens')::bigint), 0) FROM messages WHERE metadata->'tokens' IS NOT NULL) AS total_output_tokens,
        (SELECT COUNT(*) FROM conversation_files) AS total_files,
        (SELECT COALESCE(SUM(size), 0) FROM conversation_files WHERE folder = 'input') AS total_input_bytes,
        (SELECT COALESCE(SUM(size), 0) FROM conversation_files WHERE folder = 'output') AS total_output_bytes,
        (SELECT COUNT(*) FROM conversation_shares) AS total_shares,
        (SELECT COUNT(DISTINCT user_id) FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE m.created_at > NOW() - INTERVAL '24 hours') AS active_users_24h,
        (SELECT COUNT(DISTINCT user_id) FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE m.created_at > NOW() - INTERVAL '7 days') AS active_users_7d
    `);
    res.json(kpis);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Daily activity (messages + new users + new convs) for last N days ---
app.get('/api/admin/activity/daily', adminMiddleware, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const { rows } = await pool.query(`
      SELECT
        d::date AS date,
        COALESCE(msg.cnt, 0) AS messages,
        COALESCE(msg.tokens, 0) AS tokens,
        COALESCE(msg.avg_secs, 0) AS avg_response_secs,
        COALESCE(usr.cnt, 0) AS new_users,
        COALESCE(conv.cnt, 0) AS new_conversations
      FROM generate_series(NOW() - INTERVAL '1 day' * ($1-1), NOW(), '1 day') d
      LEFT JOIN (
        SELECT DATE(m.created_at) AS day, COUNT(*) AS cnt,
               COALESCE(SUM((m.metadata->'tokens'->>'total_tokens')::bigint), 0) AS tokens,
               COALESCE(AVG((m.metadata->>'elapsed_seconds')::numeric), 0) AS avg_secs
        FROM messages m WHERE m.created_at >= NOW() - INTERVAL '1 day' * $1 AND m.role = 'assistant'
        GROUP BY 1
      ) msg ON msg.day = d::date
      LEFT JOIN (
        SELECT DATE(created_at) AS day, COUNT(*) AS cnt FROM users
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1 GROUP BY 1
      ) usr ON usr.day = d::date
      LEFT JOIN (
        SELECT DATE(created_at) AS day, COUNT(*) AS cnt FROM conversations
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1 GROUP BY 1
      ) conv ON conv.day = d::date
      ORDER BY d
    `, [days]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Model usage stats ---
app.get('/api/admin/models/usage', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(metadata->'model'->>'identifier', 'unknown') AS model_identifier,
        COALESCE(metadata->'model'->>'provider', 'unknown') AS provider,
        COUNT(*) AS message_count,
        COALESCE(SUM((metadata->'tokens'->>'total_tokens')::bigint), 0) AS total_tokens,
        COALESCE(SUM((metadata->'tokens'->>'input_tokens')::bigint), 0) AS input_tokens,
        COALESCE(SUM((metadata->'tokens'->>'output_tokens')::bigint), 0) AS output_tokens,
        COALESCE(AVG((metadata->>'elapsed_seconds')::numeric), 0) AS avg_response_secs,
        COALESCE(MAX((metadata->>'elapsed_seconds')::numeric), 0) AS max_response_secs,
        COUNT(DISTINCT c.user_id) AS unique_users
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.role = 'assistant' AND m.metadata IS NOT NULL
      GROUP BY 1, 2
      ORDER BY message_count DESC
    `);
    // Also get current model preferences
    const { rows: prefs } = await pool.query(`
      SELECT mc.name, mc.model_identifier, mc.provider, COUNT(*) AS users_count
      FROM user_model_preferences ump
      JOIN model_configs mc ON ump.model_config_id = mc.id
      GROUP BY mc.id, mc.name, mc.model_identifier, mc.provider
      ORDER BY users_count DESC
    `);
    res.json({ usage: rows, preferences: prefs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: All users with stats ---
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
    const offset = parseInt(req.query.offset || '0', 10);
    const sort = ['total_messages','total_tokens','total_conversations','last_active','created_at'].includes(req.query.sort)
      ? req.query.sort : 'last_active';

    const { rows } = await pool.query(`
      SELECT
        u.id, u.email, u.is_admin,
        COALESCE(u.created_at, NOW()) AS created_at,
        COUNT(DISTINCT c.id) AS total_conversations,
        COUNT(DISTINCT m.id) AS total_messages,
        COALESCE(SUM((m.metadata->'tokens'->>'total_tokens')::bigint), 0) AS total_tokens,
        COALESCE(AVG((m.metadata->>'elapsed_seconds')::numeric), 0) AS avg_response_secs,
        MAX(m.created_at) AS last_active,
        mc.name AS current_model,
        mc.provider AS current_provider,
        COALESCE(ump.auto_select, false) AS auto_select,
        COUNT(DISTINCT cf.id) AS total_files,
        COALESCE(SUM(cf.size) FILTER (WHERE cf.folder = 'input'), 0) AS input_bytes,
        COALESCE(SUM(cf.size) FILTER (WHERE cf.folder = 'output'), 0) AS output_bytes
      FROM users u
      LEFT JOIN conversations c ON c.user_id = u.id
      LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'assistant'
      LEFT JOIN user_model_preferences ump ON ump.user_id = u.id
      LEFT JOIN model_configs mc ON mc.id = ump.model_config_id
      LEFT JOIN conversation_files cf ON cf.user_id = u.id
      WHERE u.is_admin = false OR u.is_admin IS NULL
      GROUP BY u.id, u.email, u.is_admin, u.created_at, mc.name, mc.provider, ump.auto_select
      ORDER BY ${sort === 'last_active' ? 'last_active DESC NULLS LAST' :
                sort === 'created_at' ? 'u.created_at DESC' :
                sort + ' DESC'}
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const { rows: [{ total }] } = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE is_admin = false OR is_admin IS NULL`);
    res.json({ users: rows, total: parseInt(total), limit, offset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Single user drill-down ---
app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    // User info
    const { rows: [user] } = await pool.query(`
      SELECT u.id, u.email, COALESCE(u.created_at, NOW()) AS created_at,
             mc.name AS current_model, mc.provider AS current_provider,
             COALESCE(ump.auto_select, false) AS auto_select
      FROM users u
      LEFT JOIN user_model_preferences ump ON ump.user_id = u.id
      LEFT JOIN model_configs mc ON mc.id = ump.model_config_id
      WHERE u.id = $1
    `, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Conversations with stats
    const { rows: conversations } = await pool.query(`
      SELECT c.id, c.title, c.created_at, c.updated_at,
             COUNT(m.id) AS message_count,
             COALESCE(SUM((m.metadata->'tokens'->>'total_tokens')::bigint), 0) AS total_tokens,
             COALESCE(AVG((m.metadata->>'elapsed_seconds')::numeric), 0) AS avg_secs,
             MAX(m.created_at) AS last_message_at,
             EXISTS(SELECT 1 FROM conversation_shares cs WHERE cs.conversation_id = c.id) AS is_shared
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id AND m.role = 'assistant'
      WHERE c.user_id = $1
      GROUP BY c.id ORDER BY c.updated_at DESC
    `, [userId]);

    // Model usage for this user
    const { rows: modelUsage } = await pool.query(`
      SELECT COALESCE(m.metadata->'model'->>'identifier', 'unknown') AS model,
             COALESCE(m.metadata->'model'->>'provider', 'unknown') AS provider,
             COUNT(*) AS cnt,
             COALESCE(SUM((m.metadata->'tokens'->>'total_tokens')::bigint), 0) AS tokens
      FROM messages m JOIN conversations c ON m.conversation_id = c.id
      WHERE c.user_id = $1 AND m.role = 'assistant' AND m.metadata IS NOT NULL
      GROUP BY 1, 2 ORDER BY cnt DESC
    `, [userId]);

    // Daily activity
    const { rows: daily } = await pool.query(`
      SELECT DATE(m.created_at) AS date, COUNT(*) AS messages,
             COALESCE(SUM((m.metadata->'tokens'->>'total_tokens')::bigint), 0) AS tokens
      FROM messages m JOIN conversations c ON m.conversation_id = c.id
      WHERE c.user_id = $1 AND m.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `, [userId]);

    // File stats
    const { rows: files } = await pool.query(`
      SELECT folder,
             COUNT(*) AS file_count,
             COALESCE(SUM(size), 0) AS total_bytes,
             MAX(attached_at) AS last_uploaded
      FROM conversation_files WHERE user_id = $1 GROUP BY folder
    `, [userId]);

    // Skills enabled
    const { rows: skills } = await pool.query(`
      SELECT skill_name, enabled FROM user_skills WHERE user_id = $1 AND enabled = true ORDER BY skill_name
    `, [userId]);

    res.json({ user, conversations, modelUsage, daily, files, skills });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Response time distribution ---

app.get('/api/admin/storage', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.email,
        COUNT(cf.id) AS total_files,
        COALESCE(SUM(cf.size) FILTER (WHERE cf.folder = 'input'), 0) AS input_bytes,
        COALESCE(SUM(cf.size) FILTER (WHERE cf.folder = 'output'), 0) AS output_bytes,
        COALESCE(SUM(cf.size), 0) AS total_bytes,
        COUNT(cf.id) FILTER (WHERE cf.folder = 'input') AS input_files,
        COUNT(cf.id) FILTER (WHERE cf.folder = 'output') AS output_files,
        MAX(cf.attached_at) AS last_activity
      FROM users u
      LEFT JOIN conversation_files cf ON cf.user_id = u.id
      WHERE u.is_admin = false OR u.is_admin IS NULL
      GROUP BY u.id, u.email
      HAVING COALESCE(SUM(cf.size), 0) > 0
      ORDER BY total_bytes DESC
    `);
    const { rows: [totals] } = await pool.query(`
      SELECT
        COALESCE(SUM(size) FILTER (WHERE folder = 'input'), 0) AS total_input_bytes,
        COALESCE(SUM(size) FILTER (WHERE folder = 'output'), 0) AS total_output_bytes,
        COALESCE(SUM(size), 0) AS grand_total_bytes,
        COUNT(*) AS total_files
      FROM conversation_files
    `);
    res.json({ users: rows, totals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Skills usage across platform ---
app.get('/api/admin/skills', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT skill_name,
             COUNT(*) FILTER (WHERE enabled = true) AS enabled_by,
             COUNT(*) FILTER (WHERE enabled = false) AS disabled_by,
             COUNT(*) AS total_users
      FROM user_skills
      GROUP BY skill_name
      ORDER BY enabled_by DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin: Recent activity feed ---
app.get('/api/admin/activity/recent', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        m.id, u.email, c.title AS conversation_title,
        m.role, m.created_at,
        LENGTH(m.content) AS content_length,
        (m.metadata->>'elapsed_seconds')::numeric AS elapsed_secs,
        (m.metadata->'tokens'->>'total_tokens')::bigint AS tokens,
        m.metadata->'model'->>'identifier' AS model,
        m.metadata->'model'->>'provider' AS provider
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      JOIN users u ON c.user_id = u.id
      ORDER BY m.created_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// === END ADMIN API ===
// ============================================================

// ============================================================
// === AGENT TEAM + INFRASTRUCTURE ADMIN API ==================
// ============================================================

// --- Admin: Agent team usage stats ---



app.post('/api/chat/agent-team', authMiddleware, chatLimiter, async (req, res) => {
  const userId = req.userId;
  const { message, conversationId, enabledSkills, enabledPlugins, agentCount } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required.' });

  try {
    let convId = conversationId ? parseInt(conversationId, 10) : null;
    if (!convId) {
      const title  = message.substring(0, 50) + (message.length > 50 ? '...' : '');
      const result = await pool.query('INSERT INTO conversations (user_id, title) VALUES ($1,$2) RETURNING id', [userId, title]);
      convId = result.rows[0].id;
    }
    await pool.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1,$2,$3)', [convId, 'user', message]);

    const containerName = await containerManager.ensureContainer(userId);

    // Build system context
    let systemContext = CAPABLE_SYSTEM_PROMPT;
    const skillsPrompt = getEnabledSkillsPrompt(enabledSkills);
    if (skillsPrompt) systemContext += skillsPrompt;
    const activePlugins = enabledPlugins && Array.isArray(enabledPlugins) ? enabledPlugins : [];
    if (activePlugins.length) systemContext += pluginManager.getEnabledPluginsPrompt(activePlugins);

    // Resolve model
    const modelRes = await pool.query(`
      SELECT mc.api_endpoint, mc.model_identifier, mc.provider, mc.default_api_key, mc.is_capable, mc.mcp_capable, ump.user_api_key
      FROM user_model_preferences ump
      JOIN model_configs mc ON ump.model_config_id = mc.id
      WHERE ump.user_id = $1 AND mc.is_active = true
    `, [userId]);
    const modelRow = modelRes.rows[0];
    const modelConfig = modelRow ? {
      api_endpoint: modelRow.api_endpoint, model_identifier: modelRow.model_identifier,
      provider: modelRow.provider, is_capable: modelRow.is_capable, mcp_capable: modelRow.mcp_capable,
      api_key: modelRow.user_api_key || modelRow.default_api_key || 'dummy-key',
    } : null;

    // Auto-detect optimal agent count from message complexity.
    // Callers may pass agentCount as a hint, but auto-detection overrides unless
    // the caller explicitly passes agentCount AND it's higher than the auto value.
    const { intent: _ri, tier: _rt } = analyseRequest(message, enabledSkills || []);
    const { agentCount: autoCount } = shouldUseAgentTeam(message, _ri, _rt, enabledSkills || []);
    const teamCount = Math.min(Math.max(
      typeof agentCount === 'number' ? Math.max(agentCount, autoCount) : autoCount,
      2), 5);
    console.log(`[AgentTeam REST] intent=${_ri}, autoCount=${autoCount}, teamCount=${teamCount}`);

    let teamReply = '';
    const teamResult = await agentTeamManager.runTeam(containerName, {
      task: message, systemContext, modelConfig, agentCount: teamCount, userId,
    });
    teamReply = teamResult.stdout.trim() || '(no output)';

    await pool.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1,$2,$3)', [convId, 'assistant', teamReply]);
    await pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [convId]);
    res.json({ reply: teamReply, conversationId: convId });
  } catch (err) {
    console.error('[AgentTeam] Error:', err.message || err);
    res.status(500).json({ error: 'Agent team execution failed.' });
  }
});

// --- Start server ---
const PORT = 5000;
runMigrations()
  .then(() => {
    containerManager.cleanupOrphaned();

    // Wire platform router — inject pool + runAgent helper.
    // Automatically uses team mode for complex tasks — same logic as the stream endpoint.
    // runAgentForPlatform not included in Community Edition
    // Platform channel integration not included in Community Edition
    console.log('[Platform] Chat platform webhook router initialised');

    // Periodic auto-sync removed — avoids unnecessary API calls every 6h.
    // Models sync on startup and via manual trigger: POST /api/models/sync

    app.listen(PORT, () => {
      console.log(`Backend Live on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
