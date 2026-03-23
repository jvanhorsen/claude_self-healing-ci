/**
 * Main entry point — wires the webhook server, Discord bot, and
 * Claude Code channel together.
 *
 * This is an MCP channel server. When Claude Code loads it, incoming
 * messages are forwarded as user turns in the Claude conversation,
 * and Claude's responses are forwarded back to Discord.
 */

import { loadConfig } from "./config.ts";
import { DiscordBot } from "./discord.ts";
import { WebhookServer } from "./webhook.ts";
import { buildInstructions } from "./instructions.ts";
import type { WorkflowRunPayload } from "./types.ts";

// --- MCP Channel Protocol ---
// Claude Code communicates with channel servers via stdin/stdout JSON-RPC.
// We read from stdin and write to stdout.

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

let messageIdCounter = 0;

function sendToChannel(message: JsonRpcMessage): void {
  const line = JSON.stringify(message);
  process.stdout.write(line + "\n");
}

function sendUserMessage(text: string): void {
  sendToChannel({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: {
      role: "user",
      content: text,
    },
  });
}

function respondToRequest(id: number | string, result: unknown): void {
  sendToChannel({
    jsonrpc: "2.0",
    id,
    result,
  });
}

// --- Main ---

async function main() {
  const config = loadConfig();
  const discord = new DiscordBot(config);
  const webhook = new WebhookServer(config);

  // Connect Discord
  await discord.connect();
  await discord.send(
    "🟢 **self-heal-ci** is online and watching for CI failures."
  );

  // When Discord user sends a message, forward it to Claude as a user turn
  discord.onMessage((text: string, author: string) => {
    sendUserMessage(`[Discord — ${author}]: ${text}`);
  });

  // When a CI failure comes in, notify Discord and send to Claude
  webhook.onFailure((payload: WorkflowRunPayload) => {
    const run = payload.workflow_run;
    const repo = run.repository.full_name;

    const discordMsg = [
      `🔴 **CI Failure** in \`${repo}\``,
      `**Workflow:** ${run.name}`,
      `**Branch:** \`${run.head_branch}\``,
      `**Commit:** \`${run.head_sha.slice(0, 7)}\``,
      `**Logs:** ${run.html_url}`,
      "",
      "Claude is investigating...",
    ].join("\n");

    discord.send(discordMsg);

    // Build instructions and send the failure context to Claude
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
      `Report your findings to the chat channel as you go.`,
    ].join("\n");

    sendUserMessage(claudeMsg);
  });

  // Listen for Claude's responses on stdin (JSON-RPC from Claude Code)
  const decoder = new TextDecoder();
  let buffer = "";

  process.stdin.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });

    // Process complete lines
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const msg: JsonRpcMessage = JSON.parse(line);
        handleChannelMessage(msg, discord);
      } catch (e) {
        console.error("[server] Failed to parse stdin:", e);
      }
    }
  });

  // Start webhook server
  webhook.start();

  console.log("[server] self-heal-ci is running");
  console.log(
    `[server] Webhook endpoint: http://localhost:${config.webhookPort}/github`
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[server] Shutting down...");
    await discord.send(
      "🔴 **self-heal-ci** is going offline."
    );
    webhook.stop();
    await discord.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function handleChannelMessage(
  msg: JsonRpcMessage,
  discord: DiscordBot
): void {
  // Handle initialization
  if (msg.method === "initialize") {
    respondToRequest(msg.id!, {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: {
        name: "self-heal-ci",
        version: "0.1.0",
      },
    });
    return;
  }

  // Handle assistant messages — forward to Discord
  if (
    msg.method === "notifications/message" &&
    msg.params?.role === "assistant"
  ) {
    const content = msg.params.content as string;
    if (content) {
      discord.send(content);
    }
    return;
  }

  // Handle permission requests — forward to Discord for approval
  if (msg.method === "notifications/permission_request") {
    const params = msg.params as {
      tool: string;
      input: string;
      code: string;
    };
    const permMsg = [
      `🔐 **Permission Request**`,
      `Claude wants to run **${params.tool}**: \`${params.input}\``,
      `Reply **"yes ${params.code}"** or **"no ${params.code}"**`,
    ].join("\n");
    discord.send(permMsg);
    return;
  }

  // Respond to pings
  if (msg.method === "ping") {
    respondToRequest(msg.id!, {});
    return;
  }
}

main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
