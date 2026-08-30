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
  capped at the editor's own policies) and hands it to the instance's agent
  runtime for the site MCP connection. The browser only ever holds a session
  ticket. Ending the session revokes the token.

## Chats and history

The panel keeps a history sidebar: every chat is its own Think session, listed
in the browser's localStorage per site (switch, delete with confirmation; a
compact transcript is cached so expired chats stay readable). The first chat
in a browser mints the editor's session token; further chats are opened as
children of an existing one (`session` route with `parent`), so the worker
reuses that token and the browser never holds it. Deleting the last chat that
uses a token revokes it.

## Access model

The chat token is an ordinary API token of the editor: the site's MCP endpoint
authenticates it exactly like REST (policies ∩ the owner's current grants), so
the assistant can do whatever the editor can — including handing frontend
work to the GitHub agent through its MCP tools (`premium-github-agent__create_issue`
etc.). The only things tokens cannot do are mint other tokens and call this
plugin's routes, which are session-only.

## Skills, per role

Owners teach the assistant on the plugin's **Agent skills** page
(`/_emdash/admin/plugins/premium-cms-agent/skills`): a skill is a name, a
one-line description the model reads to decide when it applies, and markdown
instructions — the same shape as a bundled Think skill. Each skill is assigned
to roles (the site's roles, custom ones included; none = everyone) and can be
disabled without deleting it. When an editor opens a chat, the plugin sends
the enabled skills assigned to their role along with the session, and the
worker exposes them to the model next to the bundled `site-assistant` skill
(bounded: 30 skills, 24 KB each). Editors see the list; admins manage it
(routes `skills`, `skills/save`, `skills/delete`; the page uses the same
checks). The picker comes from `ctx.users.listRoles()` (core ≥ 0.35.41) and
the match from `ctx.user.roleId`; on an older core the built-in five roles
are offered.

## How it fits together

```
toolbar "Agent" button ──loads──▶ <site>/_emdash/agents/toolbar.js (chat panel + browser bridge)
        │                                     │
        │ session token (core)                │ WebSocket (ticket)
        ▼                                     ▼
plugin `session` route ──ctx.agents.session──▶ PluginAgent (Think, a Durable Object of the instance)
                                                ├─ MCP "site":    <site>/_emdash/api/mcp  (Bearer = editor's session token)
                                                └─ MCP "browser": <site>/_emdash/agents/browser/<id>/mcp (tools run in the editor's tab)
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

Model, reasoning effort, session length (1–24 h). The admin page lists recent
sessions.

## The runtime

There is nothing to deploy: the platform's instance bundle ships the agent
runtime (`@premium-cms/cloudflare/agents`) and the plugin uses it through
`ctx.agents` (capability `agents:run`). `ctx.agents.session(...)` opens a
Think session on a `PluginAgent` Durable Object of the instance (one per chat,
named `premium-cms-agent:<session id>`; further chats inherit the token from
their parent session), returns the ticket the panel connects with, and
`ctx.agents.endSession(...)` closes it and revokes the token.

Instance routes: `/_emdash/agents/toolbar.js` (the panel), `/_emdash/agents/chat/plugin-agent/<name>?ticket=`
(the chat WebSocket), `/_emdash/agents/browser/<name>/ws` (the tab, `?ticket=`)
and `POST /_emdash/agents/browser/<name>/mcp` (the agent, Bearer ticket). All
of them are served by the site's own Worker on Workers AI.
