/**
 * The browser bridge: an MCP server whose tools run inside the editor's tab.
 *
 * One Durable Object per chat session. The editor's browser keeps a
 * WebSocket to it (`/browser/<session>/ws?ticket=…`); the agent calls it as
 * an ordinary MCP server (`POST /browser/<session>/mcp`, Bearer ticket). A
 * tool call is forwarded over the socket as `{ type: "call", id, tool, args }`
 * and the browser answers `{ type: "result", id, ok, result | error }`.
 * Nothing runs anywhere but that tab — which is what makes screenshots,
 * DOM/CSS snapshots, console output and clicks reflect exactly what the
 * editor sees.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

interface Env {
	AGENT_KEY: string;
}

interface BridgeState {
	ticket: string;
	expiresAt: string;
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const CALL_TIMEOUT_MS = 45_000;
const SCREENSHOT_TIMEOUT_MS = 90_000;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

function asText(v: unknown): string {
	if (typeof v === "string") return v;
	return JSON.stringify(v, null, 2) ?? "";
}

export class BrowserBridge extends DurableObject<Env> {
	private pending = new Map<string, Pending>();

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const leaf = url.pathname.split("/").pop();
		const state = (await this.ctx.storage.get<BridgeState>("state")) ?? null;
		const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
		const keyed = !!this.env.AGENT_KEY && bearer === this.env.AGENT_KEY;

		// Control plane (the worker itself, on the plugin's behalf).
		if (leaf === "init" && request.method === "POST") {
			if (!keyed) return json({ error: "unauthorized" }, 401);
			const body = (await request.json().catch(() => null)) as Partial<BridgeState> | null;
			if (!body || typeof body.ticket !== "string" || typeof body.expiresAt !== "string") {
				return json({ error: "ticket and expiresAt required" }, 400);
			}
			await this.ctx.storage.put("state", { ticket: body.ticket, expiresAt: body.expiresAt });
			return json({ ok: true });
		}
		if (leaf === "end" && request.method === "POST") {
			if (!keyed) return json({ error: "unauthorized" }, 401);
			await this.ctx.storage.delete("state");
			for (const ws of this.ctx.getWebSockets()) ws.close(1000, "session ended");
			this.failAll(new Error("session ended"));
			return json({ ok: true });
		}

		const valid = (ticket: string) => !!state && ticket.length > 0 && ticket === state.ticket && Date.parse(state.expiresAt) > Date.now();

		// The editor's browser.
		if (leaf === "ws") {
			if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a WebSocket" }, 426);
			if (!valid(url.searchParams.get("ticket") ?? "")) return json({ error: "invalid ticket" }, 401);
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);
			return new Response(null, { status: 101, webSocket: pair[0] });
		}

		// The agent (an MCP client).
		if (leaf === "mcp" && request.method === "POST") {
			if (!valid(bearer)) return json({ error: "invalid ticket" }, 401);
			const handler = createMcpHandler(() => this.createServer(), {
				legacy: "stateless",
				responseMode: "json",
				onerror: (error) => console.error("[browser-mcp]", error),
			});
			try {
				return await handler.fetch(request, { authInfo: { token: bearer, clientId: "site-agent", scopes: [] } });
			} finally {
				await handler.close().catch(() => {});
			}
		}
		return json({ error: "not found" }, 404);
	}

	webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
		if (typeof message !== "string") return;
		let msg: { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string };
		try {
			msg = JSON.parse(message);
		} catch {
			return;
		}
		if (msg.type !== "result" || typeof msg.id !== "string") return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		if (msg.ok) p.resolve(msg.result);
		else p.reject(new Error(msg.error || "the browser reported an error"));
	}

	webSocketClose(): void {
		if (this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN).length === 0) {
			this.failAll(new Error("the editor's browser disconnected"));
		}
	}

	webSocketError(): void {
		this.webSocketClose();
	}

	private failAll(error: Error): void {
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(error);
			this.pending.delete(id);
		}
	}

	/** Run one tool in the editor's tab and wait for its answer. */
	private call(tool: string, args: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		const ws = this.ctx.getWebSockets().find((s) => s.readyState === WebSocket.OPEN);
		if (!ws) {
			return Promise.reject(
				new Error("The editor's browser is not connected right now. Ask them to keep the page open and reopen the Agent panel."),
			);
		}
		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${tool} timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ type: "call", id, tool, args: args ?? {} }));
		});
	}

	private createServer(): McpServer {
		const server = new McpServer(
			{ name: "premium-cms-browser", version: "1.0.0" },
			{ capabilities: { tools: {} }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
		);
		const selector = z.string().min(1).max(500).describe("A CSS selector");

		server.registerTool(
			"browser_info",
			{ description: "What the editor is looking at: page URL, title, viewport, scroll position, and how many editable EmDash fields the page has." },
			async () => text(asText(await this.call("browser_info", {}))),
		);
		server.registerTool(
			"browser_editable_fields",
			{
				description:
					"The EmDash content rendered on the page: every element carrying a data-emdash-ref, with its collection, entry id, field and a text preview. Use it to map what the editor sees to the entries you can change with the site tools.",
			},
			async () => text(asText(await this.call("browser_editable_fields", {}))),
		);
		server.registerTool(
			"browser_text",
			{
				description: "The visible text of the page (or of the first element matching a selector). Cheaper than a snapshot when you only need to read.",
				inputSchema: z.object({ selector: selector.optional(), maxChars: z.number().int().min(100).max(100_000).optional() }),
			},
			async (input) => text(asText(await this.call("browser_text", input))),
		);
		server.registerTool(
			"browser_snapshot",
			{
				description: "The page's HTML (outerHTML of the document or of the first element matching a selector), trimmed to maxChars. Scripts are removed.",
				inputSchema: z.object({ selector: selector.optional(), maxChars: z.number().int().min(500).max(200_000).optional() }),
			},
			async (input) => text(asText(await this.call("browser_snapshot", input))),
		);
		server.registerTool(
			"browser_styles",
			{
				description: "Computed styles of the elements matching a selector (first 5), optionally only the listed properties. Also lists the page's stylesheets when asked.",
				inputSchema: z.object({
					selector,
					properties: z.array(z.string().max(60)).max(60).optional(),
					limit: z.number().int().min(1).max(5).optional(),
				}),
			},
			async (input) => text(asText(await this.call("browser_styles", input))),
		);
		server.registerTool(
			"browser_assets",
			{
				description: "The page's stylesheets and scripts (URLs and inline sizes). Pass `fetch` with one of the same-origin URLs to read its contents.",
				inputSchema: z.object({ fetch: z.string().url().optional(), maxChars: z.number().int().min(500).max(200_000).optional() }),
			},
			async (input) => text(asText(await this.call("browser_assets", input))),
		);
		server.registerTool(
			"browser_screenshot",
			{
				description: "A screenshot of what the editor sees (the viewport, the full page, or one element), rendered in their browser. Returns a PNG image.",
				inputSchema: z.object({ selector: selector.optional(), fullPage: z.boolean().optional() }),
			},
			async (input) => {
				const r = (await this.call("browser_screenshot", input, SCREENSHOT_TIMEOUT_MS)) as { data: string; width: number; height: number };
				return {
					content: [
						{ type: "image" as const, data: r.data, mimeType: "image/png" },
						{ type: "text" as const, text: `${r.width}×${r.height} px` },
					],
				};
			},
		);
		server.registerTool(
			"browser_evaluate",
			{
				description:
					"Run JavaScript in the editor's tab and return its result (JSON). Write it as a function body: use `return`, `await` is available. Page state only — persistent content changes go through the site tools.",
				inputSchema: z.object({ code: z.string().min(1).max(20_000) }),
			},
			async (input) => text(asText(await this.call("browser_evaluate", input))),
		);
		server.registerTool(
			"browser_console",
			{
				description: "Console output and uncaught errors captured in the editor's tab since the panel opened (newest last).",
				inputSchema: z.object({ limit: z.number().int().min(1).max(300).optional(), level: z.enum(["log", "info", "warn", "error"]).optional() }),
			},
			async (input) => text(asText(await this.call("browser_console", input))),
		);
		server.registerTool(
			"browser_click",
			{ description: "Click the first element matching a selector (or the nth, with index).", inputSchema: z.object({ selector, index: z.number().int().min(0).optional() }) },
			async (input) => text(asText(await this.call("browser_click", input))),
		);
		server.registerTool(
			"browser_type",
			{
				description: "Type into an input, textarea or contenteditable element matching a selector (replaces its value; submit presses Enter).",
				inputSchema: z.object({ selector, text: z.string().max(20_000), submit: z.boolean().optional() }),
			},
			async (input) => text(asText(await this.call("browser_type", input))),
		);
		server.registerTool(
			"browser_scroll",
			{
				description: "Scroll the page to a vertical position, or bring the first element matching a selector into view.",
				inputSchema: z.object({ selector: selector.optional(), y: z.number().optional() }),
			},
			async (input) => text(asText(await this.call("browser_scroll", input))),
		);
		server.registerTool(
			"browser_navigate",
			{
				description: "Navigate the editor's tab to another page of the same site (same origin only), or reload the current one with `reload: true`. The bridge reconnects after the page loads.",
				inputSchema: z.object({ url: z.string().max(2000).optional(), reload: z.boolean().optional() }),
			},
			async (input) => text(asText(await this.call("browser_navigate", input))),
		);
		return server;
	}
}
