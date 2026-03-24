#!/usr/bin/env bun
/**
 * Self-heal-ci channel server.
 *
 * Uses the MCP SDK to connect to Claude Code over stdio.
 * Receives GitHub webhook failures and forwards them to Claude.
 * Bridges Discord for two-way conversation and permission relay.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { loadConfig } from "./config.ts";
import { DiscordBot } from "./discord.ts";
import { WebhookServer } from "./webhook.ts";
import { buildInstructions } from "./instructions.ts";
import type { WorkflowRunPayload } from "./types.ts";

// --- Logging (stderr only, stdout is MCP protocol) ---
const log = (...args: unknown[]) => console.error(...args);

// --- Load config and create services ---
const config = loadConfig();
const discord = new DiscordBot(config);
const webhook = new WebhookServer(config);

// --- Create the MCP server with channel + permission relay capabilities ---
const mcp = new Server(
  { name: "self-heal-ci", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      "You are a CI failure investigator. Events arrive as <channel> tags containing CI failure details.",
      "When you receive a CI failure, diagnose and fix it following the instructions in the message.",
      "Use the reply tool with chat_id 'discord' to report your progress and findings.",
      "When you need human input, use the reply tool to ask in Discord.",
    ].join(" "),
  }
);

// --- Reply tool: Claude calls this to send messages to Discord ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message to the Discord CI channel",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "The conversation to reply in (use 'discord')",
          },
          text: {
            type: "string",
            description: "The message to send",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text } = req.params.arguments as { chat_id: string; text: string };
    await discord.send(text);
    log("[server] Sent reply to Discord");
    return { content: [{ type: "text" as const, text: "sent" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// --- Permission relay: forward approval prompts to Discord ---
const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const permMsg = [
    `🔐 **Permission Request**`,
    `Claude wants to run **${params.tool_name}**: ${params.description}`,
    `\`${params.input_preview}\``,
    ``,
    `Reply **"yes ${params.request_id}"** or **"no ${params.request_id}"**`,
  ].join("\n");
  await discord.send(permMsg);
  log(`[server] Permission request forwarded: ${params.request_id}`);
});

// --- Connect MCP to Claude Code over stdio ---
await mcp.connect(new StdioServerTransport());
log("[server] MCP connected to Claude Code");

// --- Now start Discord and webhook services ---
await discord.connect();
await discord.send(
  "🟢 **self-heal-ci** is online and watching for CI failures."
);
log("[server] Discord connected");

// --- Discord → Claude: forward messages and permission verdicts ---
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

discord.onMessage(async (text: string, author: string) => {
  // Check if this is a permission verdict
  const m = PERMISSION_REPLY_RE.exec(text);
  if (m) {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: m[2].toLowerCase(),
        behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny",
      },
    });
    await discord.send(
      `✅ Permission ${m[1].toLowerCase().startsWith("y") ? "granted" : "denied"} for \`${m[2].toLowerCase()}\``
    );
    log(`[server] Permission verdict: ${m[1]} ${m[2]}`);
    return;
  }

  // Normal message — forward to Claude as channel event
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: `[${author}]: ${text}`,
      meta: { chat_id: "discord", sender: author },
    },
  });
  log(`[server] Forwarded Discord message from ${author}`);
});

// --- GitHub webhook → Claude: forward failures ---
webhook.onFailure(async (payload: WorkflowRunPayload) => {
  const run = payload.workflow_run;
  const repo = run.repository.full_name;

  // Notify Discord
  const discordMsg = [
    `🔴 **CI Failure** in \`${repo}\``,
    `**Workflow:** ${run.name}`,
    `**Branch:** \`${run.head_branch}\``,
    `**Commit:** \`${run.head_sha.slice(0, 7)}\``,
    `**Logs:** ${run.html_url}`,
    "",
    "Claude is investigating...",
  ].join("\n");
  await discord.send(discordMsg);

  // Send failure context to Claude
  const instructions = buildInstructions(repo);
  const claudeMsg = [
    instructions,
    "",
    "---",
    "",
    `A CI failure was just detected:`,
    `- Repository: ${repo}`,
    `- Workflow: ${run.name}`,
    `- Branch: ${run.head_branch}`,
    `- Commit: ${run.head_sha}`,
    `- Run ID: ${run.id}`,
    `- Logs: ${run.html_url}`,
    "",
    `Please investigate this failure. Start by fetching the logs with:`,
    `\`gh run view ${run.id} --repo ${repo} --log-failed\``,
    "",
    `Then diagnose and fix the issue following the workflow above.`,
    `Report your findings using the reply tool with chat_id "discord".`,
  ].join("\n");

  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: claudeMsg,
      meta: { chat_id: "discord", type: "ci_failure", repo },
    },
  });
  log(`[server] CI failure forwarded to Claude: ${run.name} on ${run.head_branch}`);
});

// Start webhook server
webhook.start();

log("[server] self-heal-ci is running");
log(`[server] Webhook endpoint: http://localhost:${config.webhookPort}/github`);

// Graceful shutdown
const shutdown = async () => {
  log("\n[server] Shutting down...");
  await discord.send("🔴 **self-heal-ci** is going offline.");
  webhook.stop();
  await discord.disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
