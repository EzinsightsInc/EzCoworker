# Estimation Reference

Detailed baseline estimates and techniques for software project estimation.

## Frontend Estimates

### Pages and Views

| Component | PoC | MVP | Production | Notes |
|-----------|-----|-----|------------|-------|
| Static page | 0.25d | 0.5d | 1d | Informational content |
| Landing page | 0.5d | 1-2d | 2-3d | Marketing, responsive |
| Form (simple) | 0.5d | 1-2d | 2-3d | 3-5 fields, validation |
| Form (complex) | 1d | 2-4d | 4-6d | Multi-step, conditional |
| Data table | 1d | 2-3d | 3-5d | Sort, filter, pagination |
| Dashboard | 1-2d | 3-5d | 5-8d | Multiple widgets, charts |
| Kanban board | 2d | 3-5d | 5-8d | Drag-drop, real-time |
| Calendar view | 1d | 2-4d | 4-6d | Events, interactions |
| Admin panel | 2-3d | 5-8d | 8-15d | Full CRUD, permissions |

### UI Components

| Component | Effort | Notes |
|-----------|--------|-------|
| Navigation bar | 0.5-1d | Responsive, active states |
| Sidebar menu | 0.5-1d | Collapsible, nested |
| Modal dialog | 0.25-0.5d | Reusable pattern |
| File upload | 1-2d | Progress, preview, validation |
| Image gallery | 1-2d | Lightbox, lazy loading |
| Search autocomplete | 1-2d | Debounce, highlighting |
| Data visualization | 2-4d | Charts, interactive |
| Rich text editor | 1-2d | Using library (Tiptap, Slate) |

### Frontend Infrastructure

| Task | Effort |
|------|--------|
| Project setup (Vite/Next.js) | 0.5-1d |
| Design system foundation | 2-4d |
| State management setup | 1-2d |
| API client layer | 1-2d |
| Auth flow (FE portion) | 2-3d |
| i18n setup | 1-2d |
| Testing setup | 0.5-1d |
| E2E test framework | 1-2d |

## Backend Estimates

### API Endpoints

| Type | PoC | MVP | Production | Notes |
|------|-----|-----|------------|-------|
| CRUD (simple) | 0.25d | 0.5d | 1d | Standard operations |
| CRUD (complex) | 0.5d | 1-2d | 2-3d | Relations, validation |
| List with filters | 0.5d | 1d | 2d | Pagination, sorting, search |
| File upload | 0.5d | 1-2d | 2-3d | Storage, validation |
| Report generation | 1d | 2-3d | 4-5d | Aggregation, export |
| Webhook handler | 0.5d | 1d | 2d | Validation, idempotency |
| GraphQL schema | 1d | 2-4d | 4-6d | Types, resolvers |

### Authentication & Authorization

| Feature | PoC | MVP | Production |
|---------|-----|-----|------------|
| JWT auth | 1d | 2-3d | 3-5d |
| OAuth2 (per provider) | 1d | 2-3d | 3-4d |
| SSO (SAML/OIDC) | 2d | 3-4d | 5-7d |
| Role-based access | 0.5d | 1-2d | 3-4d |
| API key auth | 0.5d | 1d | 1-2d |
| 2FA/MFA | 1d | 2-3d | 3-5d |
| Password reset | 0.5d | 1d | 1-2d |

### Integrations

| Integration | PoC | MVP | Production | Notes |
|-------------|-----|-----|------------|-------|
| REST API client | 0.5d | 1-2d | 2-3d | Per external API |
| Payment (Stripe) | 1d | 3-4d | 5-7d | Webhooks, error handling |
| Email service | 0.5d | 1d | 2d | Templates, tracking |
| SMS provider | 0.5d | 1d | 2d | Templates, delivery |
| Cloud storage | 0.5d | 1d | 2d | S3/GCS, signed URLs |
| Search (Elastic) | 1d | 2-4d | 4-6d | Indexing, relevance |
| Message queue | 1d | 2-3d | 3-4d | RabbitMQ/SQS |

### Background Jobs

| Task | PoC | MVP | Production |
|------|-----|-----|------------|
| Job queue setup | 0.5d | 1-2d | 2-3d |
| Scheduled job (each) | 0.25d | 0.5d | 1d |
| Email job | 0.5d | 1d | 2d |
| Report generation job | 1d | 2d | 3-4d |
| Data sync job | 1d | 2-3d | 4-5d |

## AI/ML Estimates

### LLM Integration

| Component | PoC | MVP | Production | Notes |
|-----------|-----|-----|------------|-------|
| Basic LLM API call | 0.5d | 1d | 2d | OpenAI/Anthropic |
| Prompt engineering | 1d | 2-3d | 3-5d | Iteration, testing |
| Streaming responses | 0.5d | 1d | 1-2d | |
| Token management | 0.25d | 0.5d | 1d | Counting, limits |
| Multi-model routing | 1d | 2d | 3-4d | Fallbacks, selection |

### RAG Pipeline

| Component | PoC | MVP | Production |
|-----------|-----|-----|------------|
| Document ingestion | 1d | 2-3d | 4-5d |
| Chunking strategy | 0.5d | 1-2d | 2-3d |
| Embedding generation | 0.5d | 1d | 2d |
| Vector DB setup | 0.5d | 1-2d | 2-3d |
| Retrieval logic | 1d | 2-3d | 3-5d |
| Context assembly | 0.5d | 1-2d | 2-3d |
| **Total RAG** | **4d** | **8-13d** | **15-21d** |

### Custom ML

| Component | PoC | MVP | Production |
|-----------|-----|-----|------------|
| Data collection | 2-5d | 5-10d | 10-20d |
| Data preprocessing | 1-2d | 3-5d | 5-10d |
| Model selection | 1d | 2-3d | 3-5d |
| Training pipeline | 2-3d | 5-7d | 7-14d |
| Evaluation | 1d | 2-3d | 3-5d |
| Model serving API | 1d | 2-3d | 4-6d |

## Database Estimates

| Task | PoC | MVP | Production |
|------|-----|-----|------------|
| Schema design | 0.5d | 1-2d | 2-4d |
| Migration (simple) | 0.25d | 0.25d | 0.5d |
| Migration (complex) | 0.5d | 1d | 1-2d |
| Seed data | 0.25d | 0.5d | 1d |
| Query optimization | - | 1d | 2-3d |
| Read replicas | - | 1d | 2-3d |

## Infrastructure Estimates

### Environment Setup

| Task | PoC | MVP | Production |
|------|-----|-----|------------|
| Local dev (Docker) | 0.5d | 1d | 1d |
| Staging environment | - | 1-2d | 2-3d |
| Production environment | - | 2-3d | 4-6d |
| Database setup | 0.5d | 1d | 2d |
| CDN setup | - | 0.5d | 1d |

### CI/CD

| Task | PoC | MVP | Production |
|------|-----|-----|------------|
| Basic pipeline | 0.5d | 1d | 2d |
| Multi-environment | - | 1-2d | 2-3d |
| Automated testing | 0.5d | 1d | 2d |
| Security scanning | - | 0.5d | 1d |

### Monitoring & Operations

| Task | PoC | MVP | Production |
|------|-----|-----|------------|
| Application logging | 0.5d | 1d | 2d |
| Metrics (Prometheus) | - | 1d | 2d |
| Alerting | - | 1d | 2d |
| Dashboards | - | 1d | 2d |

## QA Estimates

### Test Types

| Test Type | Effort per Feature |
|-----------|-------------------|
| Unit tests | 0.5-1d |
| Integration tests | 0.5-1d |
| E2E tests (per flow) | 0.5-1d |
| Performance tests | 1-2d |
| Security testing | 1-3d |

### QA Multipliers by Project Type

| Project Type | QA Multiplier |
|--------------|---------------|
| Internal tool | 0.15-0.2x |
| B2B SaaS | 0.25-0.35x |
| B2C application | 0.3-0.4x |
| Fintech/Healthcare | 0.4-0.6x |
| Safety-critical | 0.5-1.0x |

## Common Feature Packages

### User Management

| Scope | BE | FE | QA | Total |
|-------|----|----|-----|-------|
| Basic (register, login, profile) | 3d | 3d | 2d | 8d |
| Standard (+roles, admin) | 6d | 5d | 3d | 14d |
| Enterprise (+SSO, audit, teams) | 12d | 8d | 6d | 26d |

### E-commerce

| Scope | BE | FE | QA | Total |
|-------|----|----|-----|-------|
| Basic (catalog, cart, checkout) | 10d | 12d | 5d | 27d |
| Standard (+payments, orders) | 20d | 18d | 10d | 48d |
| Enterprise (+multi-vendor) | 40d | 30d | 20d | 90d |

### CMS

| Scope | BE | FE | QA | Total |
|-------|----|----|-----|-------|
| Basic (CRUD, categories) | 4d | 4d | 2d | 10d |
| Standard (+media, versions) | 10d | 8d | 5d | 23d |
| Advanced (+workflows) | 20d | 15d | 10d | 45d |

### Chat/Messaging

| Scope | BE | FE | QA | Total |
|-------|----|----|-----|-------|
| Basic (1:1 messaging) | 6d | 6d | 3d | 15d |
| Standard (+groups, files) | 12d | 12d | 6d | 30d |
| Advanced (+real-time, presence) | 25d | 20d | 12d | 57d |

## Estimation Techniques

### Three-Point Estimation (PERT)

For uncertain tasks, estimate:
- **O** = Optimistic (best case)
- **M** = Most likely
- **P** = Pessimistic (worst case)

```
Expected = (O + 4M + P) / 6
```

### Planning Poker Reference

| Points | Complexity | Example |
|--------|------------|---------|
| 1 | Trivial | Config change |
| 2 | Simple | Add form field |
| 3 | Moderate | CRUD endpoint |
| 5 | Complex | Feature with logic |
| 8 | Very complex | Integration |
| 13 | Highly complex | New subsystem |

### Velocity-Based Estimation

```
Remaining work (points) / Average velocity (points/sprint) = Sprints needed
```

Example:
- Backlog: 130 points
- Velocity: 26 points/sprint
- Estimate: 5 sprints
