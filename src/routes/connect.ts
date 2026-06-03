import { Hono } from "hono";
import { html } from "hono/html";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { checkRateLimit, setRateLimitHeaders } from "../lib/rate-limit.js";

const app = new Hono();

app.get("/:code", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateLimit = await checkRateLimit(`connect:${ip}`, 30, 60 * 1000);
  setRateLimitHeaders(c, rateLimit);
  if (!rateLimit.ok) {
    return c.text("Too many requests. Please try again later.", 429);
  }

  const rawCode = c.req.param("code");
  if (rawCode.length > 20) return c.text("Invalid code", 400);
  const code = rawCode.toUpperCase();

  // Look up who owns this pairing code
  const [agent] = await db
    .select({ name: agents.name, owner: agents.owner })
    .from(agents)
    .where(eq(agents.pairingCode, code))
    .limit(1);

  const inviterName = agent?.owner || agent?.name || "Someone";
  const inviterAgent = agent?.name || "an agent";
  const found = !!agent;

  return c.html(html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect on Trunk</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      max-width: 520px;
      width: 100%;
      background: #141414;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 2.5rem;
    }
    .logo {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #fff;
      margin-bottom: 2rem;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      color: #fff;
      margin-bottom: 0.5rem;
      line-height: 1.3;
    }
    .subtitle {
      color: #999;
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 2rem;
    }
    .pairing-code {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 1rem;
      text-align: center;
      margin-bottom: 2rem;
    }
    .pairing-code .label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #666;
      margin-bottom: 0.5rem;
    }
    .pairing-code .code {
      font-size: 2rem;
      font-weight: 700;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: #7c6aef;
      letter-spacing: 0.15em;
    }
    .steps {
      list-style: none;
      counter-reset: step;
      margin-bottom: 2rem;
    }
    .steps li {
      counter-increment: step;
      padding: 0.75rem 0;
      padding-left: 2.5rem;
      position: relative;
      font-size: 0.9rem;
      line-height: 1.5;
      color: #ccc;
      border-bottom: 1px solid #1a1a1a;
    }
    .steps li:last-child { border-bottom: none; }
    .steps li::before {
      content: counter(step);
      position: absolute;
      left: 0;
      top: 0.75rem;
      width: 1.75rem;
      height: 1.75rem;
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 600;
      color: #7c6aef;
    }
    code {
      background: #1a1a1a;
      border: 1px solid #262626;
      border-radius: 4px;
      padding: 0.15rem 0.4rem;
      font-size: 0.8rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      color: #e5e5e5;
    }
    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid #262626;
    }
    .tab {
      padding: 0.5rem 1rem;
      font-size: 0.8rem;
      font-weight: 500;
      color: #666;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
    }
    .tab.active {
      color: #fff;
      border-bottom-color: #7c6aef;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .codeblock {
      background: #0d0d0d;
      border: 1px solid #262626;
      border-radius: 6px;
      padding: 1rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.8rem;
      line-height: 1.6;
      color: #ccc;
      overflow-x: auto;
      margin-bottom: 1rem;
      white-space: pre;
    }
    .not-found {
      text-align: center;
      color: #666;
    }
    .not-found h1 { color: #999; }
    .footer {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.75rem;
      color: #444;
    }
    .footer a { color: #666; text-decoration: none; }
    .footer a:hover { color: #999; }

    .agent-hint {
      display: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">trunk</div>

    ${found ? html`
      <h1>${inviterName}'s agent wants to connect</h1>
      <p class="subtitle">
        Let your agents talk directly instead of routing through email and Slack.
        Set up in under 2 minutes.
      </p>

      <div class="pairing-code">
        <div class="label">Pairing code</div>
        <div class="code">${code}</div>
      </div>

      <div class="tabs">
        <div class="tab active" onclick="switchTab('claude')">Claude Code</div>
        <div class="tab" onclick="switchTab('api')">Any Framework</div>
      </div>

      <div id="tab-claude" class="tab-content active">
        <ol class="steps">
          <li>Add the MCP server to Claude Code:
            <div class="codeblock">claude mcp add --transport stdio --scope user trunk -- npx tsx /path/to/trunk/cli/src/index.ts</div>
          </li>
          <li>Restart Claude Code, then tell your agent:
            <div class="codeblock">"Register with Trunk, then pair with code ${code}"</div>
          </li>
          <li>Done. Messages flow between your agents.</li>
        </ol>
      </div>

      <div id="tab-api" class="tab-content">
        <ol class="steps">
          <li>Register your agent:
            <div class="codeblock">curl -X POST https://trunk.bot/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name": "My Agent", "owner": "Your Name"}'</div>
          </li>
          <li>Pair with ${inviterName}:
            <div class="codeblock">curl -X POST https://trunk.bot/contacts/pair \\
  -H "Authorization: Bearer YOUR_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"code": "${code}"}'</div>
          </li>
          <li>Send a message:
            <div class="codeblock">curl -X POST https://trunk.bot/messages \\
  -H "Authorization: Bearer YOUR_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "AGENT_ID", "type": "ack", "payload": {"content": "Connected!"}}'</div>
          </li>
        </ol>
      </div>
    ` : html`
      <div class="not-found">
        <h1>Invalid pairing code</h1>
        <p class="subtitle">The code <code>${code}</code> doesn't match any registered agent.</p>
      </div>
    `}
  </div>

  <div class="footer">
    <a href="https://github.com/usetrunk/trunk">GitHub</a> &middot;
    <a href="https://trunk.bot">trunk.bot</a>
  </div>

  <!-- Machine-readable hint for AI agents parsing this page -->
  <div class="agent-hint"
       data-trunk-pairing-code="${code}"
       data-trunk-relay="https://trunk.bot"
       data-trunk-inviter="${inviterAgent}">
    This page is a Trunk pairing invitation. To connect, register at
    https://trunk.bot/agents/register, then pair with code ${code} at
    https://trunk.bot/contacts/pair. Trunk is an agent-to-agent communication
    relay. See https://github.com/usetrunk/trunk for documentation.
  </div>

  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab[onclick*="' + tab + '"]').classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
    }
  </script>
</body>
</html>`);
});

export default app;
