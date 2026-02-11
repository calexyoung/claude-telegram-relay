# eclare_bot Full Version — Implementation Plan

## Context

The free relay is running: text, voice transcription, images, documents, memory persistence, structured logging, and a health endpoint. This plan covers upgrading to the full version with 7 major feature areas. Each is designed as an independent module so they can be implemented incrementally.

**Current codebase state:**
- `src/relay.ts` — single-bot relay, Telegram long-polling, Claude CLI subprocess
- `src/supabase.ts`, `src/logger.ts`, `src/memory.ts` — working infrastructure
- `src/tts.ts`, `src/phone.ts` — coded, awaiting API keys
- `examples/smart-checkin.ts`, `examples/morning-briefing.ts` — placeholder data sources
- grammy + @supabase/supabase-js as only dependencies

---

## Feature 1: Specialized AI Agents with Telegram Forum Topics

### Concept
6 agents (Research, Content, Finance, Strategy, Critic + General orchestrator), each with a dedicated Telegram forum topic. Messages sent to a topic are routed to that agent's system prompt. The General topic acts as orchestrator and can invoke "board meetings" where all agents weigh in.

### Architecture
```
Telegram Forum (Group with Topics)
├── General (orchestrator)         → default system prompt
├── Research                       → research-focused prompt
├── Content                        → content/writing prompt
├── Finance                        → financial analysis prompt
├── Strategy                       → strategic planning prompt
└── Critic                         → devil's advocate prompt
```

### Implementation

**New files:**
- `src/agents/registry.ts` — Agent definitions: name, system prompt, topic ID mapping, allowed tools
- `src/agents/orchestrator.ts` — Board meeting logic: fans a prompt to all agents, collects responses, synthesizes
- `config/agents/*.md` — System prompt files for each agent (like profile.md but per-agent)

**Database changes:**
- Add `agent` column to `messages` table (TEXT, nullable, defaults to 'general')
- Each agent gets its own session ID tracked separately

**Changes to `src/relay.ts`:**
- Detect `message_thread_id` from ctx to identify which forum topic the message came from
- Look up agent config by topic ID from registry
- Override system prompt in `buildPrompt()` based on agent
- Track per-agent session IDs (map of agentName → sessionId)
- Add `/board` command: sends prompt to all 6 agents in parallel, collects responses, posts synthesis to General topic

**Setup required:**
- Convert bot chat to a Telegram Group with Forum Topics enabled
- Create 6 named topics
- Map topic IDs to agent names in config (or auto-detect by topic name)

**Env vars:**
- `TELEGRAM_FORUM_GROUP_ID` — the group chat ID (negative number)
- Topic IDs auto-detected via Telegram API or stored in `config/agents.json`

**Key grammy APIs:**
- `ctx.message.message_thread_id` — identifies the forum topic
- `ctx.api.createForumTopic(chatId, name)` — create topics programmatically
- `ctx.api.sendMessage(chatId, text, { message_thread_id })` — reply in specific topic

### Board Meeting Flow
1. User sends `/board How should we approach X?` in General topic
2. Orchestrator spawns 6 parallel Claude calls, one per agent system prompt
3. Each agent's response is posted to its own topic
4. Orchestrator synthesizes all 6 responses into a summary
5. Summary posted to General topic with inline keyboard: "Accept", "Discuss Further", "Pick Agent"

---

## Feature 2: VPS Deployment (24/7 Cloud Server)

### Concept
Move the bot from macOS launchd to a Linux VPS so it runs 24/7 independent of the user's laptop. Hybrid mode: free local processing when awake, paid API only when sleeping.

### Architecture
```
VPS (Ubuntu 24.04, Hostinger KVM2 ~$5/mo)
├── PM2 process manager
│   ├── telegram-bot (always-on)
│   ├── smart-checkin (cron: every 30min, 9am-6pm)
│   └── morning-briefing (cron: daily 9am)
├── Bun runtime
├── Claude Code CLI (Max plan or API key)
└── GitHub auto-deploy (webhook or cron pull)
```

### Implementation

**New files:**
- `deploy/ecosystem.config.cjs` — PM2 config for all 3 services
- `deploy/setup-vps.sh` — Automated VPS provisioning script:
  - Creates non-root user
  - Installs Bun, Node.js, PM2, Claude Code
  - Clones repo, installs deps
  - Copies .env from local machine (scp)
  - Starts PM2 services
  - Configures PM2 startup (survives reboot)
- `deploy/deploy.sh` — Deployment script: git pull, bun install, pm2 reload
- `.github/workflows/deploy.yml` — GitHub Actions: on push to main, SSH into VPS and run deploy.sh

**Changes to existing files:**
- `setup/configure-services.ts` — Update PM2 config generation to match deploy/ecosystem.config.cjs
- `src/relay.ts` — No changes needed (already platform-agnostic)

**Env vars:**
- `VPS_HOST` — VPS IP address (for deploy scripts, not the bot itself)
- `VPS_USER` — SSH user (default: deploy)

**Hybrid mode (optional):**
- Health check from VPS pings local machine's `/health` endpoint
- If local is up, VPS bot stays dormant (stops polling)
- If local goes down (laptop sleeps), VPS bot activates
- Coordination via a shared Supabase `bot_status` row

### Cost Estimate
- Hostinger KVM2: ~$5/mo (12-month plan)
- Claude Max plan: existing subscription
- Total: ~$5/mo additional

---

## Feature 3: Real Integrations via MCP

### Concept
Replace placeholder data sources in smart-checkin and morning-briefing with real integrations. Use MCP servers where available, direct API calls where not.

### Integration Map

| Data Source | Method | MCP Server | API Alternative |
|-------------|--------|------------|-----------------|
| Gmail | MCP | `@anthropic/gmail-mcp` | Gmail API + OAuth |
| Google Calendar | MCP | `@anthropic/gcal-mcp` | Google Calendar API |
| Notion | MCP | `@anthropic/notion-mcp` | Notion API |
| Weather | Direct API | N/A | OpenWeatherMap (free tier) |
| News/AI News | Claude tool | N/A | WebSearch tool via Claude |

### Implementation

**New files:**
- `src/integrations/gmail.ts` — `getUnreadEmails(): Promise<EmailSummary[]>`
  - Uses Gmail MCP if available, falls back to IMAP
  - Returns: sender, subject, snippet, urgency flag
- `src/integrations/calendar.ts` — `getTodayEvents(): Promise<CalendarEvent[]>`
  - Uses Google Calendar MCP if available
  - Returns: time, title, location, attendees
- `src/integrations/notion.ts` — `getActiveTasks(): Promise<NotionTask[]>`
  - Uses Notion MCP
  - Returns: task title, status, due date, project
- `src/integrations/weather.ts` — `getWeather(location): Promise<WeatherData>`
  - Direct API call to OpenWeatherMap
  - Returns: temp, conditions, forecast
- `src/integrations/index.ts` — Unified export, graceful degradation per-source

**Changes to existing files:**
- `examples/smart-checkin.ts` — Replace `getGoals()` and `getCalendarContext()` with imports from `src/integrations/`
- `examples/morning-briefing.ts` — Replace all 5 placeholder functions with real integrations

**MCP setup (in Claude CLI):**
```bash
claude mcp add gmail -- npx @anthropic/gmail-mcp
claude mcp add gcal -- npx @anthropic/gcal-mcp
claude mcp add notion -- npx @anthropic/notion-mcp
```

**Alternative approach (no MCP):**
- For smart-checkin/briefing scripts that run standalone (not through Claude CLI), MCP servers aren't directly usable
- Instead, call Claude CLI with MCP enabled and ask it to fetch the data
- Or use direct API clients (googleapis, notion-client npm packages)

**Env vars:**
- `OPENWEATHERMAP_API_KEY` — for weather
- `WEATHER_LOCATION` — city name or lat/lon
- `NOTION_API_KEY` — if using direct API
- `NOTION_DATABASE_ID` — tasks database
- Gmail and Calendar: OAuth tokens managed by MCP or stored in `~/.claude/`

**Fallback behavior:**
- Each integration function catches errors and returns empty/default data
- Morning briefing skips sections where data fetch fails
- Smart check-in still works with partial context

---

## Feature 4: Human-in-the-Loop with Telegram Inline Buttons

### Concept
When the bot wants to take an action (send email, update calendar, create task), it first asks for approval via Telegram inline keyboard buttons. The user taps "Approve" or "Deny" without typing.

### Architecture
```
Claude suggests action → Bot sends inline keyboard → User taps button
                                                          ↓
                                              Bot executes or cancels
```

### Implementation

**New file:**
- `src/actions.ts` — Action queue and execution engine

**Types:**
```typescript
interface PendingAction {
  id: string;
  type: "send_email" | "update_calendar" | "create_task" | "custom";
  description: string;  // Human-readable summary
  payload: Record<string, unknown>;  // Data for execution
  createdAt: string;
  status: "pending" | "approved" | "denied" | "executed";
}
```

**Key functions:**
- `queueAction(action)` — Stores in Supabase `actions` table, sends inline keyboard to user
- `executeAction(actionId)` — Looks up action, executes via appropriate integration
- `cancelAction(actionId)` — Marks as denied

**Database changes:**
- New `actions` table: id, type, description, payload (JSONB), status, created_at, executed_at

**Changes to `src/relay.ts`:**
- Add intent detection for action tags in Claude's response:
  ```
  [ACTION: send_email | TO: user@example.com | SUBJECT: ... | BODY: ...]
  [ACTION: create_task | TITLE: ... | DUE: ...]
  [ACTION: update_calendar | EVENT: ... | TIME: ...]
  ```
- `processIntents()` in `src/memory.ts` extended to detect `[ACTION: ...]` tags
- When detected, call `queueAction()` instead of executing immediately
- grammy callback query handler: `bot.callbackQuery(/^action_(approve|deny)_(.+)$/, ...)`

**Inline keyboard format:**
```typescript
ctx.reply(`Action requested:\n${description}`, {
  reply_markup: {
    inline_keyboard: [[
      { text: "Approve", callback_data: `action_approve_${actionId}` },
      { text: "Deny", callback_data: `action_deny_${actionId}` },
    ]]
  }
});
```

**Memory management instructions update:**
- Add to `buildPrompt()`:
  ```
  ACTION REQUESTS:
  When the user asks you to take an external action, include:
  [ACTION: type | KEY: value | KEY: value]
  The user will be asked to approve before execution.
  ```

---

## Feature 5: Voice & Phone Calls via ElevenLabs

### Concept
The bot speaks back via ElevenLabs TTS. For urgent matters, it can initiate an actual phone call via Twilio.

### Current State
- `src/tts.ts` — ElevenLabs TTS module (complete, needs API key)
- `src/phone.ts` — Outbound call initiation (complete, needs credentials)
- Voice handler in `src/relay.ts` — Wired to attempt TTS reply (complete)

### Remaining Implementation

**New file:**
- `src/voice/call-transcript.ts` — Post-call transcript processing

**Call transcript flow:**
1. After `initiatePhoneCall()` returns a `conversationId`
2. Poll ElevenLabs API: `GET /v1/convai/conversations/{id}`
3. Wait for status `completed`
4. Extract transcript from response
5. Send transcript to Claude for summarization
6. Store action items in `memory` table as goals
7. Send summary to Telegram

**Changes to `examples/smart-checkin.ts`:**
- After successful call, start transcript polling
- Pass transcript to Claude for action item extraction
- Post summary to Telegram

**Env vars (already in .env.example, just need values):**
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_AGENT_ID`
- `ELEVENLABS_PHONE_NUMBER_ID`
- `USER_PHONE_NUMBER`

**ElevenLabs Agent setup (manual, one-time):**
1. Create agent at elevenlabs.io > Conversational AI
2. Configure system prompt (use config/profile.md content)
3. Connect Twilio phone number
4. Copy Agent ID to .env

---

## Feature 6: Fallback AI Models

### Concept
When Claude CLI is unavailable (rate limits, outages, network issues), fall back to alternative AI providers: OpenRouter (access to many models) or local Ollama.

### Architecture
```
callClaude() fails
    |
Try OpenRouter API (cloud, paid per token)
    | (if fails)
Try Ollama (local, free, needs GPU)
    | (if fails)
Return error message
```

### Implementation

**New file:**
- `src/fallback.ts` — Fallback AI provider chain

**Key functions:**
- `callWithFallback(prompt, options)` — Tries Claude first, then OpenRouter, then Ollama
- `callOpenRouter(prompt)` — POST to `https://openrouter.ai/api/v1/chat/completions`
  - Model: `anthropic/claude-sonnet` or `google/gemini-2.0-flash` (cheapest capable)
  - Requires `OPENROUTER_API_KEY`
- `callOllama(prompt)` — POST to `http://localhost:11434/api/generate`
  - Model: configurable via `OLLAMA_MODEL` (default: `llama3.2`)
  - Requires Ollama running locally (no API key)

**Changes to `src/relay.ts`:**
- Replace `callClaude()` calls with `callWithFallback()`
- Or: wrap `callClaude()` to catch failures and try fallbacks
- Add metadata to response about which provider was used
- Log which provider served each request

**Env vars:**
- `OPENROUTER_API_KEY` — OpenRouter API key (optional)
- `OPENROUTER_MODEL` — Model ID (default: `anthropic/claude-sonnet-4`)
- `OLLAMA_MODEL` — Local model name (default: `llama3.2`)
- `OLLAMA_URL` — Ollama endpoint (default: `http://localhost:11434`)
- `FALLBACK_ENABLED` — Enable/disable fallback chain (default: true)

**Limitations:**
- Fallback models don't have Claude Code tools (Read, Write, Bash, etc.)
- Session continuity (`--resume`) only works with Claude CLI
- Fallback responses may be lower quality — log and flag in metadata

---

## Feature 7: Production Infrastructure

### Concept
Auto-deploy from GitHub, monitoring with alerts, watchdog process, uninstall scripts.

### Components

#### 7A. Auto-Deploy from GitHub

**New files:**
- `.github/workflows/deploy.yml` — GitHub Actions workflow
  ```yaml
  on:
    push:
      branches: [main]
  jobs:
    deploy:
      runs-on: ubuntu-latest
      steps:
        - SSH into VPS
        - Run deploy/deploy.sh
        - Verify health endpoint
  ```
- `deploy/deploy.sh` — Pull, install, restart
  ```bash
  cd ~/apps/telegram-bot
  git pull origin main
  bun install
  pm2 reload ecosystem.config.cjs
  curl -f http://localhost:3000/health || pm2 restart telegram-bot
  ```

#### 7B. Watchdog Monitoring

**New file:**
- `src/watchdog.ts` — Standalone process that monitors the bot

**Monitors:**
- `/health` endpoint availability (every 60s)
- Process memory usage (restart if >512MB)
- Response time (alert if >30s average)
- Error rate from Supabase logs table
- Last successful message time (alert if >2 hours during business hours)

**Alert methods:**
- Telegram message to owner (via direct API, not through bot)
- Optional: email via integration

**PM2 config:**
- Add `watchdog` to ecosystem.config.cjs
- Runs as separate process, restarts independently

#### 7C. Enhanced Health Endpoint

**Changes to `src/relay.ts`:**
- Expand `/health` response:
  ```json
  {
    "status": "ok",
    "uptime": 3600,
    "timestamp": "...",
    "sessionId": "...",
    "version": "1.0.0",
    "provider": "claude",
    "memory": { "rss": 52428800 },
    "lastMessage": "2026-02-11T00:25:00Z",
    "services": {
      "supabase": "connected",
      "elevenlabs": "configured",
      "phone": "not_configured"
    }
  }
  ```
- Add `/metrics` endpoint for Prometheus-compatible metrics (optional)

#### 7D. Uninstall Script

**New file:**
- `setup/uninstall.ts` — Clean teardown
  - Stop and unload all launchd/PM2 services
  - Remove plist files
  - Optionally delete `~/.claude-relay/` data directory
  - Optionally drop Supabase tables
  - Print confirmation of what was removed

---

## Implementation Order

Recommended sequence based on dependencies and value:

| Priority | Feature | Effort | Dependencies |
|----------|---------|--------|-------------|
| 1 | Feature 4: Human-in-the-loop | Medium | None (extends existing relay) |
| 2 | Feature 6: Fallback AI models | Medium | None |
| 3 | Feature 3: Real integrations | High | MCP servers or API keys |
| 4 | Feature 5: Voice & phone calls | Low | ElevenLabs/Twilio accounts (code exists) |
| 5 | Feature 1: Specialized agents | High | Telegram forum group setup |
| 6 | Feature 2: VPS deployment | Medium | VPS purchase |
| 7 | Feature 7: Production infra | Medium | VPS (Feature 2) |

Features 4 and 6 can be done first because they add resilience and capability to the existing single-bot setup without requiring external accounts. Feature 3 is high value but requires the most external setup (OAuth, API keys). Features 1, 2, and 7 are the "production upgrade" tier.

---

## New Files Summary

```
src/
├── agents/
│   ├── registry.ts          # Agent definitions + topic mapping
│   └── orchestrator.ts      # Board meeting logic
├── integrations/
│   ├── gmail.ts             # Email integration
│   ├── calendar.ts          # Calendar integration
│   ├── notion.ts            # Task management
│   ├── weather.ts           # Weather API
│   └── index.ts             # Unified export
├── voice/
│   └── call-transcript.ts   # Post-call processing
├── actions.ts               # Human-in-the-loop queue
├── fallback.ts              # OpenRouter/Ollama fallback
└── watchdog.ts              # Process monitor

config/
└── agents/
    ├── general.md
    ├── research.md
    ├── content.md
    ├── finance.md
    ├── strategy.md
    └── critic.md

deploy/
├── ecosystem.config.cjs     # PM2 config
├── setup-vps.sh             # VPS provisioning
└── deploy.sh                # Deployment script

setup/
└── uninstall.ts             # Clean teardown

.github/
└── workflows/
    └── deploy.yml           # Auto-deploy on push
```

## New Database Tables

```sql
-- Actions queue (human-in-the-loop)
CREATE TABLE actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','executed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);

-- Add agent column to messages
ALTER TABLE messages ADD COLUMN agent TEXT DEFAULT 'general';
```

## New Environment Variables

```bash
# Feature 1: Agents
TELEGRAM_FORUM_GROUP_ID=           # Forum group chat ID

# Feature 2: VPS
VPS_HOST=                          # VPS IP
VPS_USER=deploy                    # SSH user

# Feature 3: Integrations
OPENWEATHERMAP_API_KEY=            # Weather
WEATHER_LOCATION=                  # City or lat,lon
NOTION_API_KEY=                    # Notion direct API
NOTION_DATABASE_ID=                # Tasks database

# Feature 5: Voice (already in .env.example)
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_AGENT_ID=
ELEVENLABS_PHONE_NUMBER_ID=
USER_PHONE_NUMBER=

# Feature 6: Fallback
OPENROUTER_API_KEY=                # OpenRouter
OPENROUTER_MODEL=anthropic/claude-sonnet-4
OLLAMA_MODEL=llama3.2
OLLAMA_URL=http://localhost:11434
FALLBACK_ENABLED=true
```
