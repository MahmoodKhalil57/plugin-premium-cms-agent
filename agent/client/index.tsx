/**
 * The toolbar extension: loaded by the EmDash toolbar when the editor clicks
 * "Agent". Opens a chat panel on the current page, mints a session token for
 * the editor (core, session-only), asks the plugin to open a session on the
 * worker, then talks to the Think agent over its WebSocket and keeps the
 * browser bridge connected so the agent can see this tab.
 */
import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { connectBridge, type BridgeStatus } from "./bridge.js";

const PLUGIN_ID = "premium-cms-agent";
const STORAGE_KEY = "emdash-agent-session";
const ROOT_ID = "emdash-agent-root";

interface Config {
	session: string;
	end: string;
	purpose: string;
	sessionSeconds: number;
}

interface SessionInfo {
	sessionId: string;
	ticket: string;
	host: string;
	expiresAt: string;
	tokenId: string;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: { "X-EmDash-Request": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T & { success?: boolean; error?: string }; error?: { message?: string } | string };
	if (!res.ok || json.success === false) {
		const err = json.error;
		throw new Error(typeof err === "string" ? err : (err?.message ?? `${method} ${path} failed (${res.status})`));
	}
	const data = (json.data ?? json) as T & { success?: boolean; error?: string };
	if (data.success === false) throw new Error(data.error ?? "request failed");
	return data;
}

function storedSession(): SessionInfo | null {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const info = JSON.parse(raw) as SessionInfo;
		if (!info.sessionId || Date.parse(info.expiresAt) < Date.now() + 60_000) return null;
		return info;
	} catch {
		return null;
	}
}

async function openSession(config: Config): Promise<SessionInfo> {
	const existing = storedSession();
	if (existing) return existing;
	const minted = await api<{ id: string; token: string; expiresAt: string }>("POST", "/_emdash/api/auth/session-tokens", {
		purpose: config.purpose,
		expiresInSeconds: config.sessionSeconds,
	});
	try {
		const opened = await api<{ sessionId: string; ticket: string; host: string; expiresAt: string }>("POST", config.session, {
			token: minted.token,
			tokenId: minted.id,
			expiresAt: minted.expiresAt,
			pageUrl: location.href,
		});
		const info: SessionInfo = { ...opened, tokenId: minted.id };
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(info));
		return info;
	} catch (error) {
		await api("DELETE", `/_emdash/api/auth/session-tokens/${encodeURIComponent(minted.id)}`).catch(() => undefined);
		throw error;
	}
}

async function endSession(config: Config, info: SessionInfo): Promise<void> {
	sessionStorage.removeItem(STORAGE_KEY);
	await api("POST", config.end, { sessionId: info.sessionId }).catch(() => undefined);
	await api("DELETE", `/_emdash/api/auth/session-tokens/${encodeURIComponent(info.tokenId)}`).catch(() => undefined);
}

const CSS = `
#${ROOT_ID} { position: fixed; right: 16px; bottom: 76px; width: min(420px, calc(100vw - 32px)); height: min(640px, calc(100vh - 110px)); z-index: 999998; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e6e6e6; }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .ea-panel { display: flex; flex-direction: column; height: 100%; background: #171717; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.45); overflow: hidden; }
#${ROOT_ID} .ea-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
#${ROOT_ID} .ea-title { font-weight: 600; font-size: 13px; }
#${ROOT_ID} .ea-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
#${ROOT_ID} .ea-dot[data-s="open"] { background: #22c55e; }
#${ROOT_ID} .ea-dot[data-s="connecting"] { background: #eab308; }
#${ROOT_ID} .ea-dot[data-s="rejected"], #${ROOT_ID} .ea-dot[data-s="closed"] { background: #ef4444; }
#${ROOT_ID} .ea-spacer { flex: 1; }
#${ROOT_ID} button.ea-btn { background: rgba(255,255,255,0.08); color: #ddd; border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
#${ROOT_ID} button.ea-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }
#${ROOT_ID} button.ea-btn[disabled] { opacity: .5; cursor: default; }
#${ROOT_ID} .ea-msgs { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
#${ROOT_ID} .ea-msg { max-width: 92%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
#${ROOT_ID} .ea-msg[data-role="user"] { align-self: flex-end; background: #2563eb; color: #fff; }
#${ROOT_ID} .ea-msg[data-role="assistant"] { align-self: flex-start; background: rgba(255,255,255,0.07); }
#${ROOT_ID} .ea-tool { align-self: flex-start; font-size: 11px; color: #9ca3af; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 3px 8px; }
#${ROOT_ID} .ea-tool[data-state="output-error"] { color: #fca5a5; }
#${ROOT_ID} .ea-shot { max-width: 100%; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); margin-top: 4px; display: block; }
#${ROOT_ID} .ea-empty { color: #9ca3af; text-align: center; margin: auto; padding: 24px; }
#${ROOT_ID} .ea-err { color: #fca5a5; padding: 6px 12px; font-size: 12px; }
#${ROOT_ID} form.ea-form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(255,255,255,0.08); }
#${ROOT_ID} textarea.ea-input { flex: 1; resize: none; min-height: 38px; max-height: 120px; background: #0f0f0f; color: #eee; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 8px 10px; font: inherit; }
#${ROOT_ID} textarea.ea-input:focus { outline: none; border-color: #3b82f6; }
#${ROOT_ID} button.ea-send { background: #3b82f6; color: #fff; border: none; border-radius: 10px; padding: 0 14px; font: inherit; font-weight: 600; cursor: pointer; }
#${ROOT_ID} button.ea-send[disabled] { opacity: .5; cursor: default; }
`;

type Part = { type: string; text?: string; toolName?: string; state?: string; output?: unknown; errorText?: string };

function ToolPart({ part }: { part: Part }) {
	const name = part.toolName ?? part.type.replace(/^tool-/, "");
	const output = part.output as { content?: Array<{ type: string; data?: string; mimeType?: string }> } | undefined;
	const image = output?.content?.find((c) => c.type === "image" && c.data);
	const state = part.state ?? "";
	const icon = state === "output-available" ? "✓" : state === "output-error" ? "✕" : "…";
	return (
		<div className="ea-tool" data-state={state} title={part.errorText ?? state}>
			{icon} {name}
			{image ? <img className="ea-shot" alt={`${name} result`} src={`data:${image.mimeType ?? "image/png"};base64,${image.data}`} /> : null}
		</div>
	);
}

function Chat({ info, onEnd, onClose }: { info: SessionInfo; onEnd: () => void; onClose: () => void }) {
	const [bridge, setBridge] = useState<BridgeStatus>("connecting");
	const [draft, setDraft] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const agent = useAgent({ agent: "SiteAgent", name: info.sessionId, host: info.host, query: { ticket: info.ticket } });
	const { messages, sendMessage, status, stop, clearHistory, connectionError } = useAgentChat({ agent });

	useEffect(() => {
		const b = connectBridge({ host: info.host, sessionId: info.sessionId, ticket: info.ticket, onStatus: setBridge });
		return () => b.close();
	}, [info.host, info.sessionId, info.ticket]);

	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [messages]);

	const busy = status === "submitted" || status === "streaming";
	const submit = () => {
		const text = draft.trim();
		if (!text || busy) return;
		setDraft("");
		void sendMessage({ text });
	};
	const bridgeLabel = useMemo(
		() => ({ open: "browser connected", connecting: "connecting browser…", closed: "browser reconnecting…", rejected: "browser session expired" })[bridge],
		[bridge],
	);

	return (
		<div className="ea-panel" data-emdash-agent="">
			<div className="ea-head">
				<span className="ea-dot" data-s={bridge} title={bridgeLabel} />
				<span className="ea-title">Site agent</span>
				<span className="ea-spacer" />
				{busy ? (
					<button type="button" className="ea-btn" onClick={() => stop()}>
						Stop
					</button>
				) : null}
				<button type="button" className="ea-btn" onClick={() => clearHistory()} title="Start a new conversation in this session">
					New
				</button>
				<button type="button" className="ea-btn" onClick={onEnd} title="End the session and revoke its token">
					End
				</button>
				<button type="button" className="ea-btn" onClick={onClose} aria-label="Close">
					×
				</button>
			</div>
			<div className="ea-msgs" ref={listRef}>
				{messages.length === 0 ? (
					<div className="ea-empty">Ask about this page — the assistant can read it, take screenshots, and change the content it renders through your own access.</div>
				) : null}
				{(messages as Array<{ id: string; role: string; parts: Part[] }>).map((m) =>
					m.parts.map((part, i) =>
						part.type === "text" && part.text ? (
							<div key={`${m.id}-${i}`} className="ea-msg" data-role={m.role}>
								{part.text}
							</div>
						) : part.type.startsWith("tool-") || part.type === "dynamic-tool" ? (
							<ToolPart key={`${m.id}-${i}`} part={part} />
						) : null,
					),
				)}
			</div>
			{connectionError ? <div className="ea-err">Chat connection lost ({connectionError.reason || connectionError.message}). Reopen the panel to reconnect.</div> : null}
			<form
				className="ea-form"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<textarea
					className="ea-input"
					value={draft}
					placeholder="Ask about this page…"
					rows={1}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
				/>
				<button type="submit" className="ea-send" disabled={busy || !draft.trim()}>
					Send
				</button>
			</form>
		</div>
	);
}

function Panel({ config, onClose }: { config: Config; onClose: () => void }) {
	const [info, setInfo] = useState<SessionInfo | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		openSession(config).then(setInfo, (e) => setError(e instanceof Error ? e.message : String(e)));
	}, [config]);
	if (error) {
		return (
			<div className="ea-panel">
				<div className="ea-head">
					<span className="ea-title">Site agent</span>
					<span className="ea-spacer" />
					<button type="button" className="ea-btn" onClick={onClose} aria-label="Close">
						×
					</button>
				</div>
				<div className="ea-err">{error}</div>
			</div>
		);
	}
	if (!info) {
		return (
			<div className="ea-panel">
				<div className="ea-head">
					<span className="ea-dot" data-s="connecting" />
					<span className="ea-title">Site agent</span>
				</div>
				<div className="ea-empty">Opening a session…</div>
			</div>
		);
	}
	return (
		<Chat
			info={info}
			onClose={onClose}
			onEnd={() => {
				void endSession(config, info).finally(onClose);
			}}
		/>
	);
}

let root: Root | null = null;

function mount(config: Config): void {
	let host = document.getElementById(ROOT_ID);
	if (!host) {
		const style = document.createElement("style");
		style.textContent = CSS;
		document.head.appendChild(style);
		host = document.createElement("div");
		host.id = ROOT_ID;
		document.body.appendChild(host);
	}
	if (!root) root = createRoot(host);
	root.render(
		<Panel
			config={config}
			onClose={() => {
				root?.unmount();
				root = null;
				host?.remove();
			}}
		/>,
	);
}

declare global {
	interface Window {
		__emdashToolbarExtensions?: Record<string, { open: (config: unknown) => void }>;
	}
}

window.__emdashToolbarExtensions = window.__emdashToolbarExtensions || {};
window.__emdashToolbarExtensions[PLUGIN_ID] = {
	open(config: unknown) {
		const c = (config ?? {}) as Partial<Config>;
		mount({
			session: c.session ?? `/_emdash/api/plugins/${PLUGIN_ID}/session`,
			end: c.end ?? `/_emdash/api/plugins/${PLUGIN_ID}/session/end`,
			purpose: c.purpose ?? PLUGIN_ID,
			sessionSeconds: typeof c.sessionSeconds === "number" ? c.sessionSeconds : 8 * 3600,
		});
	},
};
