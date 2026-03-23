/**
 * Sends a simulated GitHub workflow failure webhook to the local server.
 * Usage: bun run test:webhook
 */

const payload = await Bun.file("test/fixtures/failure.json").text();
const port = process.env.WEBHOOK_PORT || "9090";

console.log(`Sending test webhook to http://localhost:${port}/github ...`);

const response = await fetch(`http://localhost:${port}/github`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-GitHub-Event": "workflow_run",
  },
  body: payload,
});

console.log(`Response: ${response.status} ${await response.text()}`);
