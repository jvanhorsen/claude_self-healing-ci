/**
 * Shared interfaces for the channel server.
 */

/** Handler for incoming chat messages */
export type MessageHandler = (text: string, author: string) => void;

/**
 * Chat platform interface — implement this for Discord, Slack, Telegram, etc.
 * The MCP channel layer and Claude's instructions don't change at all.
 */
export interface ChatPlatform {
  /** Connect to the chat service */
  connect(): Promise<void>;
  /** Disconnect from the chat service */
  disconnect(): Promise<void>;
  /** Send a message to the CI channel */
  send(text: string): Promise<void>;
  /** Register a handler for incoming messages from authorized users */
  onMessage(handler: MessageHandler): void;
}

/** GitHub workflow run webhook payload (relevant fields) */
export interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    head_branch: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    repository: {
      full_name: string;
      clone_url: string;
    };
  };
}
