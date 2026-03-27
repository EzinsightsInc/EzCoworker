<div align="center">

<img src="https://ezinsights.ai/wp-content/uploads/2020/09/EzInsights-logo.png" width="72" alt="ezinsights.ai"/>

# EzCoworker Community Edition

### Your AI Agents. Your Infrastructure. Your Rules.

A powerful self-hosted AI agent platform powered by **Claude Code CLI** — free for internal business use.  
Connect any LLM, run agents in isolated Docker containers, and process real files on your own servers.

[![🌐 Full Details & Docs](https://img.shields.io/badge/🌐_Full_Details_%26_Docs-Visit_the_Site-3498db?style=for-the-badge)](https://ezinsightsinc.github.io/EzCoworker/)
[![⭐ Star on GitHub](https://img.shields.io/badge/⭐_Star_This_Repo-GitHub-24292e?style=for-the-badge&logo=github)](https://github.com/EzinsightsInc/EzCoworker)
[![License: IBU-1.0](https://img.shields.io/badge/License-IBU_1.0-ffb940?style=for-the-badge)](./LICENSE)
[![By ezinsights.ai](https://img.shields.io/badge/By-ezinsights.ai-3498db?style=for-the-badge)](https://ezinsights.ai)

---

**6+ LLM Providers** &nbsp;·&nbsp; **100% Self-Hosted** &nbsp;·&nbsp; **MCP Tool Support** &nbsp;·&nbsp; **Docker Isolated Agents** &nbsp;·&nbsp; **22 Models** &nbsp;·&nbsp; **IBU Licensed**

</div>

---

> 👉 **This README is a quick overview. For the full feature breakdown, comparison tables, architecture diagrams, demo videos, quickstart guide, and edition details — visit the site:**
>
> ## **[https://ezinsightsinc.github.io/EzCoworker/](https://ezinsightsinc.github.io/EzCoworker/)**

---

## What is EzCoworker?

EzCoworker is a complete, production-ready AI agent platform that runs entirely on your own servers. Every agent runs in its own isolated Docker container. Your data never leaves your infrastructure. No per-seat SaaS fees. No vendor lock-in.

**Community Edition** is free for internal business use.  
**Enterprise Edition** adds a full Data Intelligence & SDLC automation suite — built on the ezinsights.ai framework — that no commercial coworker product comes close to matching.

---

## ⚡ Community — What You Get Free

```
✓  Any LLM — Ollama local, Anthropic, OpenAI, Gemini, Groq, OpenRouter
✓  22 models auto-discovered at startup
✓  Isolated Docker agent containers — one per user, zero cross-contamination
✓  MCP tool integration + custom skills system
✓  File workspace — upload, process, download any file type
✓  Multi-user platform with full admin dashboard
✓  Intent-based model routing — right model for every task
✓  Vision & reasoning model support
✓  Conversation sharing with public links
✓  One-command Docker Compose deploy
```

## 🏢 Enterprise — Unique in Market

```
★  CEO Command Center — conversational executive intelligence
★  KPI Intelligence Dashboard — live AI-driven metrics & anomaly alerts
★  Channel Integrations — Slack, Teams, Zoho Cliq, Discord
★  IDE Integration — VS Code & JetBrains sidebar agent
★  Knowledge Graph Server — org-wide entity & relationship intelligence
★  Database Semantic Layer — natural language to SQL over any warehouse
★  Smart Data Intelligence Agents — Profiler, Lineage, Quality, Enrichment, Insight
★  Code Migration Agents — autonomous large-scale codebase migrations
★  Code Review Agents — OWASP, perf, arch — inline PR comments via webhook
★  Design Generation Agents — wireframe to production-ready component
★  Code Generation Agents — self-validating, ticket-linked pull requests
★  Test Automation Agents — unit, integration & E2E generation
★  Multi-Agent Orchestration — parallel agents coordinated by a planner
```

> Contact **[sales@ezinsights.ai](mailto:sales@ezinsights.ai)** for Enterprise pricing and onboarding.

---

## 🚀 Quick Start

```bash
# Clone the repo
git clone https://github.com/EzinsightsInc/EzCoworker.git
cd EzCoworker

# Build the agent container (~5 min first time)
docker build -f agent.Dockerfile -t claude-agent-image-community .

# Configure API keys
cp .env.example .env   # add ANTHROPIC_API_KEY, OPENAI_API_KEY etc.

# Launch everything
docker-compose up -d --build
```

```
✓  frontend   →  http://localhost:3600
✓  backend    →  http://localhost:5600
✓  litellm    →  http://localhost:4000
✓  postgres   →  ready
✓  22 models discovered  (anthropic · openai · gemini · groq · ollama)
```

**Open http://localhost:3600 and you're running.**

---

## 📜 License

Released under the **Internal Business Use License (IBU-1.0)**.

- ✅ Free to deploy for internal business use
- ✅ Modify for your own organisation's needs
- ❌ No resale, SaaS hosting, or redistribution without approval
- ❌ No white-labelling or OEM embedding without approval

See [LICENSE](./LICENSE) for full terms. Commercial use enquiries: [sales@ezinsights.ai](mailto:sales@ezinsights.ai)

---

<div align="center">

**For the full story — features, comparisons, architecture, demos, and edition details:**

## 👉 [ezinsightsinc.github.io/EzCoworker](https://ezinsightsinc.github.io/EzCoworker/)

---

Built with ❤️ by the [ezinsights.ai](https://ezinsights.ai) team &nbsp;·&nbsp; [sales@ezinsights.ai](mailto:sales@ezinsights.ai)

</div>
