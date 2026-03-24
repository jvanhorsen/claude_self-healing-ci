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
Code       #ci-channel
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

## Prerequisites

- [Bun](https://bun.sh) v1.1+
- [Claude Code](https://code.claude.com) v2.1.80+ (logged in via claude.ai)
- [gh CLI](https://cli.github.com/) authenticated (`gh auth login`)
- A Discord bot ([Step 1 below](#step-1-create-a-discord-bot))
- A tunnel for receiving webhooks ([Step 4 below](#step-4-set-up-a-tunnel))

---

## Setup

### Step 1: Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**
2. Name it something like `self-heal-ci`
3. Go to the **Bot** tab:
   - Click **Reset Token** and copy the token — you'll need this for `.env`
   - Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent**
4. Go to **OAuth2** → **URL Generator**:
   - Under **Scopes**, check `bot`
   - Under **Bot Permissions**, check: `Send Messages`, `Read Messages/View Channels`, `Add Reactions`
   - Copy the generated URL at the bottom
5. Open that URL in your browser to invite the bot to your Discord server
6. Create a channel for CI reports (e.g., `#ci-autopilot`) or use an existing one
7. Get your IDs (enable Developer Mode in Discord Settings → App Settings → Advanced):
   - Right-click the channel → **Copy Channel ID**
   - Right-click your own username → **Copy User ID**

### Step 2: Clone and Install

```bash
git clone https://github.com/jvanhorsen/claude_self-healing-ci.git self-heal-ci
cd self-heal-ci
bun install
```

> **Don't have Bun?** Install it with: `curl -fsSL https://bun.sh/install | bash`

### Step 3: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Bot token from Step 1 |
| `DISCORD_CHANNEL_ID` | Yes | Channel ID from Step 1 |
| `ALLOWED_DISCORD_USERS` | Yes | Your Discord user ID from Step 1 (comma-separated for multiple users) |
| `GITHUB_WEBHOOK_SECRET` | Recommended | HMAC secret for webhook verification (generate with `openssl rand -hex 20`) |
| `WEBHOOK_PORT` | No | HTTP port for webhooks (default: `9090`) |

### Step 4: Set Up a Tunnel

Since this runs locally, GitHub needs a public URL to send webhooks to your machine. Pick one:

```bash
# Option A: cloudflared (no account needed)
brew install cloudflared
cloudflared tunnel --url http://localhost:9090

# Option B: ngrok
brew install ngrok
ngrok http 9090
```

Copy the public URL it gives you (e.g., `https://abc123.trycloudflare.com`). You'll need it for the next step.

> **Important:** Keep the tunnel running in its own terminal tab whenever you're using self-heal-ci.

### Step 5: Add a CI Workflow to Your Target Repo

Your target repo needs a GitHub Actions workflow that runs CI checks. An example is provided in `examples/ci-workflow.yml`. Copy and adapt it:

```bash
# In your target repo
mkdir -p .github/workflows
```

> **Tip:** On macOS, Finder hides dotfiles by default. Use the terminal to create `.github/workflows/`, or press `Cmd+Shift+.` in Finder to toggle visibility.

Create `.github/workflows/ci.yml` with your project's build/test commands. The example covers a Node.js project with lint, type-check, build, and test steps. Adapt to your stack.

When any workflow in the repo fails, GitHub automatically sends a `workflow_run` webhook — no special config needed in the workflow file itself.

### Step 6: Set Up the GitHub Webhook

1. Go to your target repo → **Settings** → **Webhooks** → **Add webhook**
2. **Payload URL**: your tunnel URL + `/github` (e.g., `https://abc123.trycloudflare.com/github`)
3. **Content type**: **`application/json`** (this is critical — `x-www-form-urlencoded` will not work)
4. **Secret**: the same value you put in `.env` for `GITHUB_WEBHOOK_SECRET` (leave blank if you didn't set one)
5. Under **Which events would you like to trigger this webhook?**, select **Let me select individual events**, then check only **Workflow runs**
6. Click **Add webhook**

### Step 7: Configure the MCP Channel Server

The MCP channel server needs to be registered in a `.mcp.json` file in your **target repo** (the repo Claude will monitor and fix), not in this project.

**Create the wrapper script:**

```bash
# In the self-heal-ci directory
cp src/wrapper.sh.example src/wrapper.sh
chmod +x src/wrapper.sh
```

Edit `src/wrapper.sh` and update the paths:
- Set the `cd` path to your self-heal-ci directory
- Set the `bun` path (run `which bun` to find it; if `bun` is in your PATH, just use `bun`)

**Create the MCP config in your target repo:**

```bash
# In your target repo
cp /path/to/self-heal-ci/.mcp.json.example .mcp.json
```

Edit `.mcp.json` and set the `command` path to your `wrapper.sh`:

```json
{
  "mcpServers": {
    "self-heal-ci": {
      "command": "/full/path/to/self-heal-ci/src/wrapper.sh",
      "args": [],
      "env": {}
    }
  }
}
```

> **Important:** The `.mcp.json` contains machine-specific paths. Add it to your target repo's `.gitignore` if the repo is shared.

### Step 8: Launch

Open a terminal in your **target repo** and start Claude Code with the channel flag:

```bash
claude --dangerously-load-development-channels server:self-heal-ci
```

You should see:
- `Listening for channel messages from: server:self-heal-ci` in the Claude Code header
- Your Discord bot come online and post a message in your channel

Verify the MCP server is connected by typing `/mcp` in the Claude Code session — `self-heal-ci` should show as **connected**.

### Step 9: Test It

**Quick test (simulated webhook):**

In a separate terminal, from the self-heal-ci directory:

```bash
bun run test:webhook
```

You should see the failure alert appear in Discord. (Note: if you have `GITHUB_WEBHOOK_SECRET` set, the test webhook won't pass signature verification — temporarily comment it out in `.env` for this test, or skip to the real test below.)

**Real test (trigger an actual CI failure):**

In your target repo:

```bash
git checkout -b test-self-heal
# Introduce an error — e.g., a type error, missing import, or failing test
git add . && git commit -m "test: break the build"
git push origin test-self-heal
```

Watch the flow:
1. GitHub Actions runs and fails
2. The webhook fires to your tunnel
3. Discord shows the failure alert
4. Claude Code starts investigating in your terminal
5. Claude reports findings to Discord
6. If Claude wants to push a fix, you'll get a permission prompt in Discord

---

## Project Structure

```
self-heal-ci/
├── src/
│   ├── server.ts            # Main entry — MCP channel server with Discord + webhook
│   ├── config.ts            # Environment variable loader with validation
│   ├── discord.ts           # Discord bot (implements ChatPlatform interface)
│   ├── webhook.ts           # GitHub webhook HTTP server
│   ├── types.ts             # Shared TypeScript interfaces
│   ├── instructions.ts      # Claude's system prompt (diagnosis + fix strategy)
│   ├── wrapper.sh.example   # Template for the launcher script
│   └── wrapper.sh           # Your local launcher (gitignored, machine-specific paths)
├── test/
│   ├── send-test-webhook.ts # Sends a simulated failure webhook
│   └── fixtures/
│       └── failure.json     # Sample webhook payload
├── examples/
│   └── ci-workflow.yml      # Example GitHub Actions CI workflow
├── .env.example             # Environment variable template
├── .mcp.json.example        # MCP server config template
├── package.json
├── tsconfig.json
└── README.md
```

## Architecture

### MCP Channel Server

The server uses the [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) to implement a Claude Code channel. It declares three capabilities:

- **`claude/channel`** — registers a notification listener so it can push events (CI failures, Discord messages) into Claude's context
- **`claude/channel/permission`** — opts in to permission relay, forwarding tool approval prompts to Discord
- **`tools`** — exposes a `reply` tool so Claude can send messages back to Discord

Claude Code spawns the server as a subprocess and communicates over stdio. The wrapper script (`src/wrapper.sh`) handles setting the working directory so Bun can find the `.env` file and `node_modules`.

### Swappable Chat Platform

The Discord integration implements a `ChatPlatform` interface with four methods: `send`, `onMessage`, `connect`, `disconnect`. To use Slack or Telegram instead, create a new module that implements the same interface and swap the import in `server.ts`. The MCP channel layer and Claude's instructions don't change at all — that's the point.

### Safety Guardrails

Claude's instructions (in `src/instructions.ts`) enforce strict boundaries: no force pushes, no direct pushes to main/master, only touch files related to the failure, always verify locally before pushing, always report back to Discord even when it can't fix the issue. The permission relay adds a second layer — even if the instructions allowed something risky, you'd still have to approve it.

### Escalation Path

If Claude can't fix an issue after one attempt, it reports its diagnosis, what it tried, and why it didn't work. You can reply in Discord with follow-up instructions and Claude will execute them. The session stays alive and listening — it's a conversation, not a batch job.

---

## Troubleshooting

### MCP server shows "failed" in `/mcp`

- **Port in use:** Run `lsof -ti:9090` to check. Kill stale processes with `lsof -ti:9090 | xargs kill -9`. Only one instance of the server can run at a time.
- **Wrapper script not found:** Make sure `src/wrapper.sh` exists, is executable (`chmod +x`), and the path in `.mcp.json` is correct.
- **Bun not in PATH:** Use the full path to bun in `wrapper.sh` (find it with `which bun` in a terminal where bun works).
- **Multiple Claude sessions:** If you have Claude Code open in both the self-heal-ci directory AND the target repo, and both have `.mcp.json`, they'll both try to start the server. Only the target repo needs it.
- **Process never starts:** If the debug log never appears, the `.mcp.json` format may be wrong. Use `claude mcp add-json` to add it: `claude mcp add-json self-heal-ci '{"command":"/path/to/wrapper.sh","args":[],"env":{}}'`

### Webhook not arriving

- **Wrong content type:** The GitHub webhook **must** be set to `application/json`, not `application/x-www-form-urlencoded` (GitHub's default).
- **Missing `/github` path:** The webhook URL must end with `/github` (e.g., `https://your-tunnel.com/github`).
- **Tunnel not running:** Make sure your tunnel is active and pointing to `localhost:9090`.
- **Signature mismatch:** If you set `GITHUB_WEBHOOK_SECRET`, make sure the same value is in both `.env` and GitHub's webhook settings.
- Check GitHub's **Settings → Webhooks → Recent Deliveries** for delivery status and response codes.

### Discord bot not responding

- **Message Content Intent:** Make sure it's enabled in the Discord Developer Portal under Bot → Privileged Gateway Intents.
- **Wrong channel ID:** Double-check `DISCORD_CHANNEL_ID` in `.env`. Enable Developer Mode in Discord to copy IDs.
- **User not authorized:** Your Discord user ID must be in `ALLOWED_DISCORD_USERS` in `.env`.

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
- **Local execution**: The target repo must be cloned locally — this runs on your machine, not in the cloud
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
