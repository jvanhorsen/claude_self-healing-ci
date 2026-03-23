# self-heal-ci

**A tech demo showing how Claude Code Channels can add a real-time conversational layer and human-in-the-loop control to CI automation.**

Most CI automations are black boxes — they run, they pass or fail, and you get an email with a log. Tools like [claude-code-action](https://github.com/anthropics/claude-code-action) and [GitHub Agentic Workflows](https://github.blog/changelog/2025-05-19-github-agentic-workflows-public-preview/) can even auto-fix failures, but they still run fire-and-forget in a cloud runner with no way to interact mid-flight.

This project demonstrates a different pattern: using [Claude Code Channels](https://code.claude.com/docs/en/channels-reference) to turn that same CI-fix workflow into a **two-way conversation** where you can watch Claude work, course-correct in real time from Discord, and approve destructive actions from your phone.

> **Note:** Claude Code Channels are in [research preview](https://code.claude.com/docs/en/channels) and require Claude Code v2.1.80+.

---

## Why This Exists

GitHub Actions can already trigger Claude to fix a broken build. So why build this?

This repo isn't really about CI. It's a **reference implementation for the channels pattern** — the idea that any webhook-driven automation becomes more powerful when you add:

| Capability | Cloud-side CI fix | This approach |
|---|---|---|
| Auto-diagnose and fix | Yes | Yes |
| Run in your local environment (Docker, VPN, private registries) | No | Yes |
| Watch the AI work in real time | No | Yes |
| Course-correct mid-fix ("try looking at the config file") | No | Yes |
| Approve destructive actions from your phone | No | Yes |
| Conversational escalation when it can't fix it | No | Yes |

CI failure is just the demo. The same pattern works for Sentry alerts, PagerDuty incidents, Stripe webhooks, staging environment monitors — anything that can POST to an HTTP endpoint can become a conversational automation with human-in-the-loop control.

## How It Works

```
GitHub Actions (failure webhook)
        │
        ▼
  self-heal-ci (MCP channel server, runs locally)
        │
   ┌────┴────┐
   ▼         ▼
Claude     Discord
Code       #ci-autopilot
(local)    (your phone)
```

1. GitHub Actions completes a workflow run and sends a webhook
2. The channel server filters for failures and forwards them to Claude Code
3. Claude checks out the branch, reads the logs, diagnoses the error, and applies a fix
4. If local tests pass, Claude commits and pushes — **but only after you approve in Discord**
5. The full cycle is reported to Discord, and you can reply with follow-up instructions at any point

### The Interesting Part: Permission Relay

When Claude wants to run something like `git push`, it doesn't just do it. Claude Code surfaces a permission prompt with a 5-letter code, and the channel server forwards it to Discord:

```
🔐 Permission Request
Claude wants to run Bash: git push origin feature-auth
Reply "yes xkrmn" or "no xkrmn"
```

You reply from your phone. The verdict is relayed back. The local terminal dialog also stays open — whichever answer arrives first is applied. This is the core UX innovation that cloud-side automations can't replicate.

### Interactive Debugging

When Claude can't fix something, it doesn't just push a partial fix and leave. It tells you in Discord what it's stuck on, and you can reply with context:

> **Claude:** "Tests still failing — the `UserService` mock expects a `tenantId` field that doesn't exist in the type definition. This might be intentional. Should I add it to the interface or update the test?"
>
> **You:** "We added multi-tenancy last week. Add tenantId to the User interface and default it to 'default' in the test fixtures."
>
> **Claude:** "Done. Tests passing. PR #248 updated."

That back-and-forth is impossible with fire-and-forget CI automations.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Claude Code](https://code.claude.com) v2.1.80+ (logged in via claude.ai)
- [gh CLI](https://cli.github.com/) authenticated (`gh auth login`)
- A Discord bot ([create one here](https://discord.com/developers/applications))

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/self-heal-ci.git
cd self-heal-ci
bun install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `DISCORD_CHANNEL_ID` | Yes | Channel ID for CI reports |
| `ALLOWED_DISCORD_USERS` | Yes | Comma-separated Discord user IDs |
| `GITHUB_WEBHOOK_SECRET` | No | HMAC secret for webhook verification |
| `WEBHOOK_PORT` | No | HTTP port (default: 9090) |

### 3. Set up Discord bot

1. Create an application at [discord.com/developers](https://discord.com/developers/applications)
2. Go to **Bot** → copy the token → paste into `.env`
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to **OAuth2** → URL Generator → select `bot` scope → permissions: Send Messages, Read Messages, Add Reactions
5. Open the generated URL to invite the bot to your server
6. Create a `#ci-autopilot` channel (or use an existing one)
7. Copy the channel ID (Developer Mode → right-click → Copy ID)

### 4. Set up GitHub webhook

1. Go to your repo → **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL**: your tunnel URL + `/github` (see below)
3. **Content type**: `application/json`
4. **Secret**: the value from your `.env` (generate one with `openssl rand -hex 20`)
5. **Events**: select **Workflow runs** only

Since this runs locally, you need a tunnel to receive webhooks:

```bash
# Option A: ngrok
ngrok http 9090

# Option B: cloudflared (no account needed)
cloudflared tunnel --url http://localhost:9090
```

### 5. Launch

Navigate to the root of the repo you want to monitor, then copy the `.mcp.json` from this project into it (or merge with your existing one):

```bash
cp /path/to/self-heal-ci/.mcp.json ./
```

Start Claude Code with the channel:

```bash
claude --dangerously-load-development-channels server:self-heal-ci
```

### 6. Test it

Send a simulated failure webhook:

```bash
bun run test:webhook
```

Or trigger a real failure:

```bash
git checkout -b test-self-heal
echo "const x: number = 'oops'" >> src/index.ts
git add src/index.ts && git commit -m "test: break the build"
git push origin test-self-heal
```

Check your Discord channel — you should see Claude investigating and (hopefully) fixing the issue.

---

## Project Structure

```
self-heal-ci/
├── src/
│   ├── server.ts          # Main entry point — wires everything together
│   ├── config.ts          # Environment variable loader with validation
│   ├── discord.ts         # Discord bot (implements ChatPlatform interface)
│   ├── webhook.ts         # GitHub webhook HTTP server
│   └── instructions.ts    # Claude's system prompt (diagnosis + fix strategy)
├── test/
│   └── fixtures/
│       └── failure.json   # Sample webhook payload for testing
├── .env.example           # Environment variable template
├── .mcp.json              # MCP server configuration for Claude Code
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

### Swappable chat platform

The Discord integration implements a `ChatPlatform` interface with four methods: `send`, `onMessage`, `connect`, `disconnect`. To use Slack or Telegram instead, create a new module that implements the same interface and swap the import in `server.ts`. The MCP channel layer and Claude's instructions don't change at all — that's the point.

### Safety guardrails

Claude's instructions (in `src/instructions.ts`) enforce strict boundaries: no force pushes, no direct pushes to main/master, only touch files related to the failure, always verify locally before pushing, always report back to Discord even when it can't fix the issue. The permission relay adds a second layer — even if the instructions allowed something risky, you'd still have to approve it.

### Escalation path

If Claude can't fix an issue after one attempt, it reports its diagnosis, what it tried, and why it didn't work. You can reply in Discord with follow-up instructions and Claude will execute them. The session stays alive and listening — it's a conversation, not a batch job.

---

## Adapt This Pattern

The channel server structure here is designed to be forked and adapted. Some ideas for other webhook sources that would work with minimal changes:

- **Sentry/Datadog** — error spike webhook triggers Claude to read logs, trace the error, and propose a fix
- **Stripe** — payment failure webhook triggers Claude to check your integration code and flag potential issues
- **PagerDuty** — incident webhook triggers Claude to pull runbooks and start diagnosis, with you approving remediation steps from your phone
- **Cron / health checks** — scheduled pings that trigger Claude to proactively run your test suite and report drift

The webhook receiver (`src/webhook.ts`) is the only file you'd need to modify for a different event source. Everything else — the MCP channel wiring, Discord integration, permission relay — stays the same.

---

## Limitations

- **Research preview**: Custom channels require `--dangerously-load-development-channels` until added to the approved allowlist
- **Local execution**: The repo must be cloned locally — this runs on your machine, not in the cloud
- **Tunnel required**: GitHub needs a public URL to send webhooks to your local port
- **Single repo per session**: Run multiple Claude Code sessions for multiple repos
- **Auth**: Requires claude.ai login (not API keys). Team/Enterprise orgs must enable channels in admin settings

## Contributing

PRs welcome. Some areas that would be particularly valuable:

- **Slack / Telegram integration** — implement `ChatPlatform` for other platforms
- **Additional webhook sources** — Sentry, PagerDuty, Stripe, etc.
- **Multi-repo routing** — route webhooks to different local clones based on `repository.full_name`
- **Fix history** — log diagnoses and fixes to build a pattern database over time
- **Demo video / GIF** — a screen recording of the full flow would help people understand the UX

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

This tool writes code and pushes to git branches on your behalf. It is designed as a **first responder and tech demo**, not a replacement for code review. All fixes go through your normal PR review process. The permission relay ensures you approve every destructive action. Use at your own risk.
