# EzCoworker — Community Edition

> **AI Agent Platform** — Run powerful AI agents locally using any model. Built on Claude Code CLI, Docker, and your choice of LLM.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Required-blue.svg)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-brightgreen.svg)](https://nodejs.org/)

---

## What is EzCoworker?

EzCoworker is a self-hosted AI agent platform that lets you run intelligent agents on your own infrastructure using **any LLM** — local Ollama models, Anthropic Claude, OpenAI GPT, Google Gemini, Groq, or OpenRouter.

Each agent runs inside an isolated Docker container with access to a full workspace — it can read and write files, execute code, generate documents, process data, and use MCP (Model Context Protocol) tools.

```
┌─────────────────────────────────────────────────────────────┐
│                     EzCoworker Platform                      │
│                                                             │
│   ┌──────────┐    ┌──────────────┐    ┌─────────────────┐  │
│   │  Web UI  │───▶│   Backend    │───▶│  Agent Docker   │  │
│   │ (nginx)  │    │  (Node.js)   │    │   Container     │  │
│   │ Port 3600│    │  Port 5600   │    │  Claude Code    │  │
│   └──────────┘    └──────┬───────┘    └────────┬────────┘  │
│                          │                     │            │
│                   ┌──────▼───────┐    ┌────────▼────────┐  │
│                   │  PostgreSQL  │    │   LLM Provider  │  │
│                   │  (History,  │    │  Ollama / API   │  │
│                   │   Users)    │    │  Keys           │  │
│                   └─────────────┘    └─────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

- 🤖 **Any LLM** — Ollama (local), Anthropic, OpenAI, Google Gemini, Groq, OpenRouter
- 📁 **File workspace** — Upload files, agent reads/writes, download results
- 🔧 **MCP Support** — Connect any Model Context Protocol server as a tool
- 🔌 **Plugin system** — Extend agent capabilities with plugins
- 💬 **Conversation history** — Multi-turn context across sessions
- 📊 **Skills system** — Reusable agent instructions and workflows
- 👥 **Multi-user** — User accounts with individual workspaces
- 🛡️ **Isolated execution** — Each agent runs in a sandboxed Docker container
- 🌐 **Web UI** — Clean chat interface with file management
- ⚙️ **Admin panel** — User management, model configuration, storage

---

## How It Works

```
User Message
     │
     ▼
┌────────────────────────────────────────────────┐
│              Backend (Node.js)                  │
│                                                 │
│  1. Auth & rate limiting                        │
│  2. Load user skills + plugins + MCP config     │
│  3. Select best available model                 │
│  4. Build system context                        │
│  5. Fetch conversation history (last 10 turns)  │
└────────────────┬───────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────┐
│          Agent Docker Container                 │
│                                                 │
│  claude -p --model <model>                      │
│         --append-system-prompt <context>        │
│         --max-turns 40                          │
│         --mcp-config <servers>                  │
│                                                 │
│  Workspace:                                     │
│    /home/node/app/workspace/input/   ← uploads  │
│    /home/node/app/workspace/output/  ← results  │
└────────────────┬───────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────┐
│              LLM Provider                       │
│                                                 │
│  Ollama (local)  →  http://localhost:11434      │
│  Anthropic       →  https://api.anthropic.com   │
│  OpenAI          →  https://api.openai.com/v1   │
│  Google          →  Native Gemini support       │
│  Groq            →  https://api.groq.com        │
│  OpenRouter      →  https://openrouter.ai/api   │
└────────────────────────────────────────────────┘
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Docker Desktop | Latest | With WSL2 on Windows |
| Node.js | 20+ | For building agent image |
| Ollama | Latest | For local models (recommended) |
| 8GB RAM | Minimum | 16GB+ recommended |
| 20GB Disk | Minimum | For Docker images |

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/your-org/ezcoworker-community.git
cd ezcoworker-community
```

### 2. Build the agent image

```bash
docker build -f agent -t claude-agent-image-community .
```

> This installs Claude Code CLI, Python libraries (pandas, pdf tools, etc.), and all document processing tools. Takes 5–10 minutes on first build.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Required
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-secure-password
POSTGRES_DB=claudedb_community
JWT_SECRET=your-random-secret-here
ADMIN_SETUP_KEY=your-admin-key-here

# Ollama (if running locally)
OLLAMA_URL=http://host.docker.internal:11434

# At least one model provider required
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GROQ_API_KEY=gsk_...
```

### 4. Create data directories

**Windows:**
```powershell
mkdir C:\claude_data_community\users
mkdir C:\claude_data_community\skills
mkdir C:\claude_data_community\plugins
mkdir C:\claude_data_community\mcp-servers
```

**Linux/Mac:**
```bash
mkdir -p ~/claude_data_community/{users,skills,plugins,mcp-servers}
# Update HOST_USER_DATA_PATH etc. in .env to match
```

### 5. Start the platform

```bash
docker-compose up -d
```

### 6. Initial admin setup

Open your browser to `http://localhost:3600`

Set up the admin account:
```bash
curl -X POST http://localhost:5600/api/admin/setup \
  -H "Content-Type: application/json" \
  -d '{
    "setupKey": "your-admin-key-here",
    "email": "admin@yourcompany.com",
    "password": "your-password"
  }'
```

Then navigate to `http://localhost:3600/admin.html` to log in to the admin panel.

---

## Model Configuration

EzCoworker auto-discovers models on startup. Configure providers in `.env`:

### Local Models (Ollama — Free)

```env
OLLAMA_URL=http://host.docker.internal:11434
```

Pull models via Ollama:
```bash
ollama pull gpt-oss:20b
ollama pull qwen3-coder:30b
ollama pull qwen3.5:latest
```

### Commercial Models

| Provider | Env Var | Notes |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY=sk-ant-...` | Claude Sonnet/Haiku |
| OpenAI | `OPENAI_API_KEY=sk-...` | GPT-4o, GPT-4 |
| Google | `GOOGLE_API_KEY=AIza...` | Gemini 2.0 Flash/Pro |
| Groq | `GROQ_API_KEY=gsk_...` | Fast inference |
| OpenRouter | `OPENROUTER_API_KEY=sk-or-v1-...` | 100+ models |

Models are synced automatically every 6 hours, or manually via:
```
POST /api/models/sync
```

---

## Skills

Skills are markdown files that inject instructions into the agent's context. Place them in your skills directory:

```
C:\claude_data_community\skills\
  my-skill\
    SKILL.md    ← instructions for the agent
```

**Example SKILL.md:**
```markdown
---
name: data-analyst
description: Analyzes CSV data and produces charts and summaries
category: Analytics
---

# Data Analysis Skill

When analyzing data:
1. Always start by reading the file structure with head/tail
2. Check for null values and data types
3. Produce a summary statistics table
4. Save charts to /home/node/app/workspace/output/
```

Enable skills per-user in the UI or admin panel.

---

## MCP Servers

Connect any MCP (Model Context Protocol) server as a tool for your agents.

Create a config file in your MCP servers directory:

```json
// C:\claude_data_community\mcp-servers\my-tool.json
{
  "name": "my-tool",
  "type": "sse",
  "url": "https://my-mcp-server.com/mcp"
}
```

Or for stdio MCP servers:
```json
{
  "name": "filesystem",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
}
```

---

## Plugins

Plugins combine a skill (markdown instructions) with an optional MCP server config:

```
C:\claude_data_community\plugins\
  my-plugin\
    PLUGIN.md    ← agent instructions
    mcp.json     ← optional MCP server config
```

---

## File Workspace

Each user gets an isolated workspace inside their agent container:

```
/home/node/app/workspace/
  input/    ← files uploaded by the user
  output/   ← files created by the agent (downloadable)
```

Files in `output/` are automatically named with a datetime suffix to prevent overwrites:
```
report_20240320_143022.pdf
dashboard_20240320_143022.html
```

---

## Project Structure

```
ezcoworker-community/
├── agent                    ← Dockerfile for agent containers
├── agent-CLAUDE.md          ← Agent context file
├── docker-compose.yaml      ← Main compose file
├── .env.example             ← Environment template
├── backend/
│   ├── server.js            ← Main API server
│   ├── containerManager.js  ← Docker agent execution
│   ├── modelSync.js         ← LLM provider discovery
│   ├── pluginManager.js     ← Plugin/MCP management
│   ├── agentTeamManager.js  ← Agent execution (community: single agent)
│   ├── executionPlanner.js  ← Execution planning (community: passthrough)
│   ├── Dockerfile           ← Backend container
│   └── package.json
├── frontend/
│   ├── public/
│   │   ├── index.html       ← Main chat UI
│   │   ├── admin.html       ← Admin panel
│   │   └── share.html       ← Shared conversation view
│   ├── nginx.conf           ← Nginx config
│   └── Dockerfile.nginx
└── db/
    └── init.sql             ← Database schema
```

---

## Docker Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Docker Host                           │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  frontend-1 │  │  backend-1  │  │    postgres-1   │  │
│  │  nginx:3600 │  │  node:5600  │  │  postgres:5432  │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────┘  │
│         │                │                               │
│         │         ┌──────▼──────────────────────────┐    │
│         │         │  Docker Socket (creates agents) │    │
│         │         └──────┬──────────────────────────┘    │
│         │                │                               │
│         │    ┌───────────▼──────┐ ┌──────────────────┐  │
│         │    │claude-agent-user-│ │claude-agent-user-│  │
│         │    │       1          │ │       2          │  │
│         │    │  Claude Code CLI │ │  Claude Code CLI │  │
│         │    │  workspace/      │ │  workspace/      │  │
│         │    └──────────────────┘ └──────────────────┘  │
│         │                                                 │
│  ┌──────▼──────────────────────────────────────────────┐  │
│  │              Host Filesystem (volumes)              │  │
│  │  C:\claude_data_community\users\{id}\workspace\    │  │
│  │  C:\claude_data_community\skills\                  │  │
│  │  C:\claude_data_community\plugins\                 │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## API Reference

### Authentication
```
POST /api/auth/login          Login
POST /api/auth/register       Register new user
POST /api/auth/refresh        Refresh token
```

### Chat
```
POST /api/chat/stream         Stream agent response (SSE)
GET  /api/conversations       List conversations
GET  /api/conversations/:id   Get conversation messages
```

### Files
```
POST /api/files/upload        Upload file to workspace
GET  /api/files/list          List workspace files
GET  /api/files/download/:folder/:filename  Download file
DELETE /api/files/:folder/:filename         Delete file
```

### Models
```
GET  /api/models              List available models
POST /api/models/sync         Trigger model sync
PUT  /api/models/:id          Update model (admin)
```

### Skills
```
GET  /api/skills              List available skills
POST /api/skills/user         Enable skill for user
```

### Admin
```
GET  /api/admin/overview      System stats
GET  /api/admin/users         List users
GET  /api/admin/activity/daily  Daily activity
GET  /api/admin/storage       Storage usage
GET  /api/admin/skills        Skill usage stats
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `POSTGRES_USER` | ✅ | — | Database user |
| `POSTGRES_PASSWORD` | ✅ | — | Database password |
| `POSTGRES_DB` | ✅ | `claudedb_community` | Database name |
| `JWT_SECRET` | ✅ | — | JWT signing secret |
| `ADMIN_SETUP_KEY` | ✅ | — | One-time admin setup key |
| `OLLAMA_URL` | — | `http://host.docker.internal:11434` | Ollama endpoint |
| `ANTHROPIC_API_KEY` | — | — | Anthropic API key |
| `OPENAI_API_KEY` | — | — | OpenAI API key |
| `GOOGLE_API_KEY` | — | — | Google Gemini API key |
| `GROQ_API_KEY` | — | — | Groq API key |
| `OPENROUTER_API_KEY` | — | — | OpenRouter API key |
| `CONTEXT_MESSAGE_LIMIT` | — | `10` | Conversation history turns |
| `MAX_AGENT_TURNS` | — | `40` | Max agent tool-call rounds |
| `AGENT_IMAGE` | — | `claude-agent-image-community` | Agent Docker image name |
| `HOST_USER_DATA_PATH` | — | `C:/claude_data_community/users` | User workspace path on host |
| `HOST_SKILLS_PATH` | — | `C:/claude_data_community/skills` | Skills path on host |
| `HOST_PLUGINS_PATH` | — | `C:/claude_data_community/plugins` | Plugins path on host |
| `HOST_MCP_SERVERS_PATH` | — | `C:/claude_data_community/mcp-servers` | MCP servers path on host |

---

## Upgrading

```bash
git pull origin main
docker-compose down
docker build -f agent -t claude-agent-image-community .
docker-compose up -d
```

---

## Troubleshooting

### Agent container not starting
```bash
docker-compose logs backend --tail=20
docker ps -a --filter "name=claude-agent"
```

### Models not appearing
```bash
# Trigger manual model sync
curl -X POST http://localhost:5600/api/models/sync \
  -H "Authorization: Bearer <your-token>"
```

### Ollama models not found
Make sure Ollama is running and accessible:
```bash
curl http://localhost:11434/api/tags
```

### File uploads failing (413 error)
Check nginx config — `client_max_body_size` should be at least `100m`.

### Out of disk space
```bash
# Clean up stopped agent containers
docker container prune -f
# Clean up unused images
docker image prune -f
```

---

## Community vs Enterprise

| Feature | Community | Enterprise |
|---|---|---|
| Single agent execution | ✅ | ✅ |
| All LLM providers | ✅ | ✅ |
| MCP server support | ✅ | ✅ |
| Plugin system | ✅ | ✅ |
| File workspace | ✅ | ✅ |
| Skills system | ✅ | ✅ |
| Multi-user | ✅ | ✅ |
| Conversation history | ✅ | ✅ |
| Multi-agent parallel execution | ❌ | ✅ |
| Intent-based LLM planner | ❌ | ✅ |
| Smart model routing | ❌ | ✅ |
| Channel integrations (Zoho, Slack, WhatsApp, Discord) | ❌ | ✅ |
| Pre-built analytics skills | ❌ | ✅ |
| Full admin intelligence dashboard | ❌ | ✅ |
| Support & SLA | ❌ | ✅ |

👉 **[Contact us for Enterprise](mailto:hello@ezcoworker.com)**

---

## Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

---

## Security

- All agent containers run as non-root user `node`
- Each user has an isolated workspace with no cross-user access
- API keys are stored encrypted in the database
- JWT tokens expire after 24 hours
- Rate limiting on all API endpoints

Report security issues to: security@ezcoworker.com

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Acknowledgements

Built on top of:
- [Claude Code CLI](https://github.com/anthropics/claude-code) by Anthropic
- [Ollama](https://ollama.ai) for local model serving
- [Model Context Protocol](https://modelcontextprotocol.io) for tool integration
- [PostgreSQL](https://postgresql.org) for data persistence
- [nginx](https://nginx.org) for frontend serving

---

<p align="center">
  Made with ❤️ by the EzCoworker team
  <br>
  <a href="https://ezcoworker.com">Website</a> •
  <a href="https://docs.ezcoworker.com">Docs</a> •
  <a href="https://discord.gg/ezcoworker">Discord</a>
</p>
