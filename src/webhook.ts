/**
 * GitHub webhook HTTP server.
 * Receives workflow_run events, validates signatures, and forwards failures.
 */

import type { Config } from "./config.ts";
import type { WorkflowRunPayload } from "./types.ts";

type FailureHandler = (payload: WorkflowRunPayload) => void;

export class WebhookServer {
  private config: Config;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private failureHandlers: FailureHandler[] = [];

  constructor(config: Config) {
    this.config = config;
  }

  onFailure(handler: FailureHandler): void {
    this.failureHandlers.push(handler);
  }

  start(): void {
    this.server = Bun.serve({
      port: this.config.webhookPort,
      fetch: async (req) => {
        const url = new URL(req.url);

        // Health check
        if (url.pathname === "/health") {
          return new Response("ok", { status: 200 });
        }

        // GitHub webhook endpoint
        if (url.pathname === "/github" && req.method === "POST") {
          return this.handleGitHubWebhook(req);
        }

        return new Response("Not found", { status: 404 });
      },
    });

    console.error(
      `[webhook] Listening on http://localhost:${this.config.webhookPort}`
    );
  }

  stop(): void {
    this.server?.stop();
    console.error("[webhook] Stopped");
  }

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    const body = await req.text();

    // Verify signature if secret is configured
    if (this.config.githubWebhookSecret) {
      const signature = req.headers.get("x-hub-signature-256");
      if (!signature || !(await this.verifySignature(body, signature))) {
        console.error("[webhook] Invalid signature — rejecting");
        return new Response("Invalid signature", { status: 401 });
      }
    }

    // Only process workflow_run events
    const event = req.headers.get("x-github-event");
    if (event !== "workflow_run") {
      return new Response("Ignored event type", { status: 200 });
    }

    let payload: WorkflowRunPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Only act on completed + failed runs
    if (
      payload.action !== "completed" ||
      payload.workflow_run.conclusion !== "failure"
    ) {
      console.error(
        `[webhook] Ignoring: action=${payload.action}, conclusion=${payload.workflow_run.conclusion}`
      );
      return new Response("Not a failure", { status: 200 });
    }

    console.error(
      `[webhook] Failure detected: ${payload.workflow_run.name} on ${payload.workflow_run.head_branch}`
    );

    for (const handler of this.failureHandlers) {
      handler(payload);
    }

    return new Response("Accepted", { status: 202 });
  }

  private async verifySignature(
    body: string,
    signature: string
  ): Promise<boolean> {
    const secret = this.config.githubWebhookSecret!;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const expected =
      "sha256=" +
      Array.from(new Uint8Array(sig))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return signature === expected;
  }
}
