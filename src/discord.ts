/**
 * Discord bot implementing the ChatPlatform interface.
 * Handles sending messages to a CI channel and relaying user replies.
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  type Message,
} from "discord.js";
import type { Config } from "./config.ts";
import type { ChatPlatform, MessageHandler } from "./types.ts";

export class DiscordBot implements ChatPlatform {
  private client: Client;
  private channel: TextChannel | null = null;
  private config: Config;
  private messageHandlers: MessageHandler[] = [];

  constructor(config: Config) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("messageCreate", (message: Message) => {
      this.handleIncomingMessage(message);
    });
  }

  async connect(): Promise<void> {
    await this.client.login(this.config.discordBotToken);

    // Wait for ready
    await new Promise<void>((resolve) => {
      this.client.once("ready", () => {
        console.error(`[discord] Logged in as ${this.client.user?.tag}`);
        resolve();
      });
    });

    // Fetch the target channel
    const ch = await this.client.channels.fetch(this.config.discordChannelId);
    if (!ch || !(ch instanceof TextChannel)) {
      throw new Error(
        `Channel ${this.config.discordChannelId} not found or is not a text channel`
      );
    }
    this.channel = ch;
    console.error(`[discord] Watching channel #${this.channel.name}`);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    console.error("[discord] Disconnected");
  }

  async send(text: string): Promise<void> {
    if (!this.channel) throw new Error("Not connected");

    // Discord has a 2000 char limit — split long messages
    const chunks = splitMessage(text, 1900);
    for (const chunk of chunks) {
      await this.channel.send(chunk);
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  private handleIncomingMessage(message: Message): void {
    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;

    // Ignore messages from other channels
    if (message.channelId !== this.config.discordChannelId) return;

    // Check if user is allowed
    if (!this.config.allowedDiscordUsers.includes(message.author.id)) {
      console.error(
        `[discord] Ignoring message from unauthorized user: ${message.author.tag}`
      );
      return;
    }

    const text = message.content.trim();
    if (!text) return;

    console.error(`[discord] Message from ${message.author.tag}: ${text}`);
    for (const handler of this.messageHandlers) {
      handler(text, message.author.tag);
    }
  }
}

/** Split a message into chunks that fit Discord's limit */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
