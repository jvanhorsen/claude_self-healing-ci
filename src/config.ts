/** Environment configuration with validation */

interface Config {
  discordBotToken: string;
  discordChannelId: string;
  allowedDiscordUsers: string[];
  githubWebhookSecret: string | null;
  webhookPort: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    discordBotToken: requireEnv("DISCORD_BOT_TOKEN"),
    discordChannelId: requireEnv("DISCORD_CHANNEL_ID"),
    allowedDiscordUsers: requireEnv("ALLOWED_DISCORD_USERS")
      .split(",")
      .map((id) => id.trim()),
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || null,
    webhookPort: parseInt(process.env.WEBHOOK_PORT || "9090", 10),
  };
}

export type { Config };
