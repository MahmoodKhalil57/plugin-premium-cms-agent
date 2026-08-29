# Site Agent — PremiumCMS plugin

A chat assistant that lives in the EmDash toolbar. An editor opens it on the
page they are looking at; it can read that page through their own browser,
change the content it renders through the site's own tools — acting as that
editor — and explain what it did.

- **Only from the toolbar.** Every plugin route is session-only (a request
  authenticated by an API token is refused) and the plugin exposes no MCP
  tools, so the assistant cannot be reached from another agent or script —
  no loops.
- **Standard Think agent.** No prompts beyond a one-liner, no scripts: one
  bundled skill (`site-assistant`) and two MCP servers.
- **Your access, briefly.** The panel mints a short-lived personal token for
  the signed-in editor (`POST /_emdash/api/auth/session-tokens`, session-only,
  capped at the editor's own policies) and hands it to the worker for the
  site MCP connection. The browser only ever holds a session ticket. Ending
  the session revokes the token.

## How it fits together

```
toolbar "Agent" button ──loads──▶ worker/toolbar.js (chat panel + browser bridge)
        │                               │
        │ session token (core)          │ WebSocket (ticket)
        ▼                               ▼
plugin `session` route ──AGENT_KEY──▶ worker POST /session ─▶ SiteAgent (Think)
                                                               ├─ MCP "site":    <site>/_emdash/api/mcp  (Bearer = editor's session token)
                                                               └─ MCP "browser": worker/browser/<id>/mcp (tools run in the editor's tab)
```

Core provides two small pieces: `GET /_emdash/api/toolbar/extensions` (the
toolbar asks every plugin with a private `toolbar` route for a button) and
the session-token endpoint above.

## Browser bridge tools

`browser_info`, `browser_editable_fields` (every `data-emdash-ref` on the page
→ collection / entry / field), `browser_text`, `browser_snapshot`,
`browser_styles`, `browser_assets`, `browser_screenshot` (rendered in the
editor's browser), `browser_evaluate`, `browser_console`, `browser_click`,
`browser_type`, `browser_scroll`, `browser_navigate` (same origin). The bridge
is an ordinary MCP server (streamable HTTP, Bearer = session ticket) whose
tools happen to execute in the connected tab.

## Settings

Agent worker URL, agent key (`AGENT_KEY` on the worker), model, reasoning
effort, session length (1–24 h). The admin page lists recent sessions.

## The worker

`agent/` is a standalone Worker: `bun install && bun run deploy` (builds
`public/toolbar.js` with bun, then `wrangler deploy`), then
`wrangler secret put AGENT_KEY` with the key you paste into the plugin
settings. Needs Workers AI (Workers Paid). The platform runs one shared
instance at `https://premium-cms-agent.premiumcms.workers.dev`.

Routes: `POST /session` and `DELETE /session/:id` (AGENT_KEY),
`/agents/site-agent/:id` (chat, `?ticket=`), `/browser/:id/ws` (the tab,
`?ticket=`), `POST /browser/:id/mcp` (the agent, Bearer ticket), `/toolbar.js`.
