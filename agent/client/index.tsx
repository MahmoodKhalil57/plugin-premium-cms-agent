/**
 * The toolbar extension: loaded by the EmDash toolbar when the editor clicks
 * "Agent". Opens a chat panel on the current page with a history sidebar.
 *
 * Every chat is its own Think session on the worker. The first chat in a
 * browser mints a session token for the editor (core, session-only); later
 * chats are opened as children of an existing one, so the worker reuses that
 * token and the browser never holds it — only session tickets. Chat metadata
 * and a compact transcript are kept in localStorage per site, so the list
 * survives reloads and expired chats stay readable.
 */
import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { connectBridge, type BridgeStatus } from "./bridge.js";

const PLUGIN_ID = "premium-cms-agent";
const HISTORY_KEY = "emdash-agent:history";
const TRANSCRIPT_KEY = (id: string) => `emdash-agent:chat:${id}`;
const ROOT_ID = "emdash-agent-root";
const MAX_CHATS = 50;

interface Config {
	session: string;
	end: string;
	purpose: string;
	sessionSeconds: number;
}

interface Chat {
	id: string;
	ticket: string;
	host: string;
	expiresAt: string;
	tokenId: string;
	title: string;
	page: string;
	createdAt: string;
	updatedAt: string;
}

interface SavedMessage {
	role: string;
	text: string;
	tools: string[];
}

// ── Storage ──────────────────────────────────────────────────────────────

function loadChats(): Chat[] {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		const list = raw ? (JSON.parse(raw) as Chat[]) : [];
		return Array.isArray(list) ? list.filter((c) => c && typeof c.id === "string") : [];
	} catch {
		return [];
	}
}

function saveChats(chats: Chat[]): void {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(chats.slice(0, MAX_CHATS)));
	} catch {
		/* storage unavailable */
	}
}

function loadTranscript(id: string): SavedMessage[] {
	try {
		const raw = localStorage.getItem(TRANSCRIPT_KEY(id));
		return raw ? (JSON.parse(raw) as SavedMessage[]) : [];
	} catch {
		return [];
	}
}

function saveTranscript(id: string, messages: SavedMessage[]): void {
	try {
		localStorage.setItem(TRANSCRIPT_KEY(id), JSON.stringify(messages.slice(-200)));
	} catch {
		/* storage unavailable */
	}
}

function isLive(chat: Chat): boolean {
	return Date.parse(chat.expiresAt) > Date.now() + 60_000;
}

// ── Server calls ─────────────────────────────────────────────────────────

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method,
		credentials: "same-origin",
		headers: { "X-EmDash-Request": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		data?: T & { success?: boolean; error?: string };
		error?: { message?: string } | string;
	};
	if (!res.ok || json.success === false) {
		const err = json.error;
		throw new Error(typeof err === "string" ? err : (err?.message ?? `${method} ${path} failed (${res.status})`));
	}
	const data = (json.data ?? json) as T & { success?: boolean; error?: string };
	if (data.success === false) throw new Error(data.error ?? "request failed");
	return data;
}

type Opened = { sessionId: string; ticket: string; host: string; expiresAt: string };

/** Open a chat: as a child of a live chat when one exists (token reused on the worker), else with a freshly minted token. */
async function openChat(config: Config, chats: Chat[]): Promise<Chat> {
	const parent = chats.find(isLive);
	const now = new Date().toISOString();
	if (parent) {
		const opened = await api<Opened>("POST", config.session, { parent: parent.id, pageUrl: location.href });
		return { ...opened, id: opened.sessionId, tokenId: parent.tokenId, title: "New chat", page: location.pathname, createdAt: now, updatedAt: now };
	}
	const minted = await api<{ id: string; token: string; expiresAt: string }>("POST", "/_emdash/api/auth/session-tokens", {
		purpose: config.purpose,
		expiresInSeconds: config.sessionSeconds,
	});
	try {
		const opened = await api<Opened>("POST", config.session, {
			token: minted.token,
			tokenId: minted.id,
			expiresAt: minted.expiresAt,
			pageUrl: location.href,
		});
		return { ...opened, id: opened.sessionId, tokenId: minted.id, title: "New chat", page: location.pathname, createdAt: now, updatedAt: now };
	} catch (error) {
		await api("DELETE", `/_emdash/api/auth/session-tokens/${encodeURIComponent(minted.id)}`).catch(() => undefined);
		throw error;
	}
}

/** Close a chat on the worker; revoke its token when no other chat still uses it. */
async function closeChat(config: Config, chat: Chat, remaining: Chat[]): Promise<void> {
	await api("POST", config.end, { sessionId: chat.id }).catch(() => undefined);
	if (!remaining.some((c) => c.tokenId === chat.tokenId)) {
		await api("DELETE", `/_emdash/api/auth/session-tokens/${encodeURIComponent(chat.tokenId)}`).catch(() => undefined);
	}
}

// ── Styles ───────────────────────────────────────────────────────────────

const CSS = `
#${ROOT_ID} { position: fixed; right: 16px; bottom: 76px; width: min(680px, calc(100vw - 32px)); height: min(640px, calc(100vh - 110px)); z-index: 999998; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #e6e6e6; }
#${ROOT_ID} * { box-sizing: border-box; }
#${ROOT_ID} .ea-shell { position: relative; display: flex; height: 100%; background: #171717; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.45); overflow: hidden; }
#${ROOT_ID} .ea-side { width: 200px; flex: none; display: flex; flex-direction: column; border-right: 1px solid rgba(255,255,255,0.08); background: #121212; }
#${ROOT_ID} .ea-side-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px 8px; }
#${ROOT_ID} .ea-side-title { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #9ca3af; }
#${ROOT_ID} .ea-list { flex: 1; overflow: auto; padding: 0 6px 8px; display: flex; flex-direction: column; gap: 2px; }
#${ROOT_ID} .ea-item { display: flex; align-items: center; gap: 4px; border-radius: 8px; padding: 6px 8px; cursor: pointer; color: #d1d5db; }
#${ROOT_ID} .ea-item:hover { background: rgba(255,255,255,0.06); }
#${ROOT_ID} .ea-item[data-active="true"] { background: rgba(59,130,246,0.18); color: #fff; }
#${ROOT_ID} .ea-item-main { flex: 1; min-width: 0; }
#${ROOT_ID} .ea-item-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
#${ROOT_ID} .ea-item-meta { font-size: 10px; color: #6b7280; }
#${ROOT_ID} .ea-item[data-expired="true"] .ea-item-title { color: #9ca3af; }
#${ROOT_ID} .ea-x { flex: none; background: none; border: none; color: #6b7280; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 4px; opacity: 0; }
#${ROOT_ID} .ea-item:hover .ea-x, #${ROOT_ID} .ea-item[data-confirm="true"] .ea-x { opacity: 1; }
#${ROOT_ID} .ea-x:hover { color: #fca5a5; background: rgba(255,255,255,0.08); }
#${ROOT_ID} .ea-confirm { display: flex; gap: 4px; }
#${ROOT_ID} .ea-mini { background: rgba(255,255,255,0.08); color: #ddd; border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 2px 6px; font: inherit; font-size: 11px; cursor: pointer; }
#${ROOT_ID} .ea-mini[data-danger="true"] { background: rgba(239,68,68,0.25); border-color: rgba(239,68,68,0.4); color: #fecaca; }
#${ROOT_ID} .ea-panel { display: flex; flex-direction: column; flex: 1; min-width: 0; }
#${ROOT_ID} .ea-head { display: flex; align-items: center; gap: 8px; padding: 10px 44px 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
#${ROOT_ID} .ea-title { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#${ROOT_ID} .ea-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; flex: none; }
#${ROOT_ID} .ea-dot[data-s="open"] { background: #22c55e; }
#${ROOT_ID} .ea-dot[data-s="connecting"] { background: #eab308; }
#${ROOT_ID} .ea-dot[data-s="rejected"], #${ROOT_ID} .ea-dot[data-s="closed"], #${ROOT_ID} .ea-dot[data-s="expired"] { background: #ef4444; }
#${ROOT_ID} .ea-spacer { flex: 1; }
#${ROOT_ID} button.ea-btn { background: rgba(255,255,255,0.08); color: #ddd; border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
#${ROOT_ID} button.ea-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }
#${ROOT_ID} button.ea-btn[disabled] { opacity: .5; cursor: default; }
#${ROOT_ID} button.ea-close { position: absolute; top: 8px; right: 8px; }
#${ROOT_ID} .ea-msgs { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
#${ROOT_ID} .ea-msg { max-width: 92%; padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
#${ROOT_ID} .ea-msg[data-role="user"] { align-self: flex-end; background: #2563eb; color: #fff; }
#${ROOT_ID} .ea-msg[data-role="assistant"] { align-self: flex-start; background: rgba(255,255,255,0.07); }
#${ROOT_ID} .ea-msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 4px; }
#${ROOT_ID} .ea-tool { align-self: flex-start; font-size: 11px; color: #9ca3af; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 3px 8px; }
#${ROOT_ID} .ea-tool[data-state="output-error"] { color: #fca5a5; }
#${ROOT_ID} .ea-shot { max-width: 100%; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); margin-top: 4px; display: block; }
#${ROOT_ID} .ea-empty { color: #9ca3af; text-align: center; margin: auto; padding: 24px; }
#${ROOT_ID} .ea-err { color: #fca5a5; padding: 6px 12px; font-size: 12px; }
#${ROOT_ID} .ea-note { color: #9ca3af; padding: 8px 12px; font-size: 12px; border-top: 1px solid rgba(255,255,255,0.08); }
#${ROOT_ID} form.ea-form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid rgba(255,255,255,0.08); }
#${ROOT_ID} textarea.ea-input { flex: 1; resize: none; min-height: 38px; max-height: 120px; background: #0f0f0f; color: #eee; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 8px 10px; font: inherit; }
#${ROOT_ID} textarea.ea-input:focus { outline: none; border-color: #3b82f6; }
#${ROOT_ID} button.ea-send { background: #3b82f6; color: #fff; border: none; border-radius: 10px; padding: 0 14px; font: inherit; font-weight: 600; cursor: pointer; }
#${ROOT_ID} button.ea-send[disabled] { opacity: .5; cursor: default; }
@media (max-width: 640px) { #${ROOT_ID} .ea-side { display: none; } }
`;

// ── Rendering helpers ────────────────────────────────────────────────────

type Part = { type: string; text?: string; toolName?: string; state?: string; output?: unknown; errorText?: string };
type Message = { id: string; role: string; parts: Part[] };

/** MCP tools arrive as `tool_<serverId>_<name>`; show the name. */
function toolLabel(part: Part): string {
	const raw = part.toolName ?? part.type.replace(/^tool-/, "");
	return raw.replace(/^tool_[A-Za-z0-9]+_/, "");
}

function isToolPart(part: Part): boolean {
	return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/** Just enough markdown for chat answers: paragraphs, **bold**, `code`, and bullet lines. */
function renderText(text: string) {
	const lines = text.split(/\n/);
	return lines.map((line, i) => {
		const bullet = /^\s*[-*]\s+/.test(line);
		const body = line.replace(/^\s*[-*]\s+/, "");
		const pieces: Array<string | { b?: string; c?: string }> = [];
		const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
		let last = 0;
		for (const m of body.matchAll(re)) {
			if (m.index! > last) pieces.push(body.slice(last, m.index));
			pieces.push(m[1] !== undefined ? { b: m[1] } : { c: m[2] });
			last = m.index! + m[0].length;
		}
		if (last < body.length) pieces.push(body.slice(last));
		return (
			<span key={i}>
				{bullet ? "• " : ""}
				{pieces.map((p, j) => (typeof p === "string" ? p : p.b !== undefined ? <strong key={j}>{p.b}</strong> : <code key={j}>{p.c}</code>))}
				{i < lines.length - 1 ? "\n" : null}
			</span>
		);
	});
}

function ToolPart({ part }: { part: Part }) {
	const name = toolLabel(part);
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

function compact(messages: Message[]): SavedMessage[] {
	return messages.map((m) => ({
		role: m.role,
		text: m.parts
			.filter((p) => p.type === "text" && p.text)
			.map((p) => p.text)
			.join(""),
		tools: m.parts.filter(isToolPart).map(toolLabel),
	}));
}

function relative(iso: string): string {
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86400)} d ago`;
}

// ── Components ───────────────────────────────────────────────────────────

function Sidebar({
	chats,
	activeId,
	onSelect,
	onNew,
	onDelete,
	busy,
}: {
	chats: Chat[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => void;
	busy: boolean;
}) {
	const [confirming, setConfirming] = useState<string | null>(null);
	return (
		<div className="ea-side">
			<div className="ea-side-head">
				<span className="ea-side-title">Chats</span>
				<button type="button" className="ea-btn" onClick={onNew} disabled={busy} title="Start a new chat">
					+ New
				</button>
			</div>
			<div className="ea-list">
				{chats.length === 0 ? (
					<div className="ea-item-meta" style={{ padding: "6px 8px" }}>
						No saved chats yet.
					</div>
				) : null}
				{chats.map((c) => (
					<div
						key={c.id}
						className="ea-item"
						data-active={c.id === activeId}
						data-expired={!isLive(c)}
						data-confirm={confirming === c.id}
						onClick={() => onSelect(c.id)}
						title={`${c.page} · ${new Date(c.createdAt).toLocaleString()}`}
					>
						<div className="ea-item-main">
							<div className="ea-item-title">{c.title}</div>
							<div className="ea-item-meta">
								{relative(c.updatedAt)}
								{isLive(c) ? "" : " · expired"}
							</div>
						</div>
						{confirming === c.id ? (
							<div className="ea-confirm" onClick={(e) => e.stopPropagation()}>
								<button
									type="button"
									className="ea-mini"
									data-danger="true"
									onClick={() => {
										setConfirming(null);
										onDelete(c.id);
									}}
								>
									Delete
								</button>
								<button type="button" className="ea-mini" onClick={() => setConfirming(null)}>
									Keep
								</button>
							</div>
						) : (
							<button
								type="button"
								className="ea-x"
								aria-label="Delete chat"
								title="Delete chat"
								onClick={(e) => {
									e.stopPropagation();
									setConfirming(c.id);
								}}
							>
								×
							</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

function Transcript({ messages }: { messages: SavedMessage[] }) {
	return (
		<>
			{messages.map((m, i) => (
				<div key={i} style={{ display: "contents" }}>
					{m.tools.map((t, j) => (
						<div key={`${i}-t${j}`} className="ea-tool" data-state="output-available">
							✓ {t}
						</div>
					))}
					{m.text ? (
						<div className="ea-msg" data-role={m.role}>
							{renderText(m.text)}
						</div>
					) : null}
				</div>
			))}
		</>
	);
}

/** A live chat: WebSocket to its Think session plus the browser bridge; transcript mirrored to localStorage. */
function LiveChat({ chat, onUpdate }: { chat: Chat; onUpdate: (patch: Partial<Chat>) => void }) {
	const [bridge, setBridge] = useState<BridgeStatus>("connecting");
	const [draft, setDraft] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const agent = useAgent({ agent: "SiteAgent", name: chat.id, host: chat.host, query: { ticket: chat.ticket } });
	const { messages, sendMessage, status, stop, connectionError } = useAgentChat({ agent });
	const list = messages as Message[];

	useEffect(() => {
		const b = connectBridge({ host: chat.host, sessionId: chat.id, ticket: chat.ticket, onStatus: setBridge });
		return () => b.close();
	}, [chat.host, chat.id, chat.ticket]);

	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
		if (list.length === 0) return;
		saveTranscript(chat.id, compact(list));
		const firstUser = list.find((m) => m.role === "user");
		const title = firstUser ? compact([firstUser])[0]!.text.replace(/\s+/g, " ").trim().slice(0, 60) : "";
		onUpdate({ updatedAt: new Date().toISOString(), ...(title && chat.title === "New chat" ? { title } : {}) });
	}, [list.length, status]);

	const busy = status === "submitted" || status === "streaming";
	const submit = () => {
		const text = draft.trim();
		if (!text || busy) return;
		setDraft("");
		void sendMessage({ text });
	};
	const bridgeLabel = useMemo(
		() =>
			({ open: "browser connected", connecting: "connecting browser…", closed: "browser reconnecting…", rejected: "browser session expired" })[
				bridge
			],
		[bridge],
	);

	return (
		<>
			<div className="ea-head">
				<span className="ea-dot" data-s={bridge} title={bridgeLabel} />
				<span className="ea-title">{chat.title}</span>
				<span className="ea-spacer" />
				{busy ? (
					<button type="button" className="ea-btn" onClick={() => stop()}>
						Stop
					</button>
				) : null}
			</div>
			<div className="ea-msgs" ref={listRef}>
				{list.length === 0 ? (
					<div className="ea-empty">
						Ask about this page — the assistant can read it, take screenshots, change the content it renders and hand code changes to the
						GitHub agent, all through your own access.
					</div>
				) : null}
				{list.map((m) =>
					m.parts.map((part, i) =>
						part.type === "text" && part.text ? (
							<div key={`${m.id}-${i}`} className="ea-msg" data-role={m.role}>
								{renderText(part.text)}
							</div>
						) : isToolPart(part) ? (
							<ToolPart key={`${m.id}-${i}`} part={part} />
						) : null,
					),
				)}
			</div>
			{connectionError ? (
				<div className="ea-err">Chat connection lost ({connectionError.reason || connectionError.message}). Reopen the panel to reconnect.</div>
			) : null}
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
		</>
	);
}

function ExpiredChat({ chat }: { chat: Chat }) {
	const saved = useMemo(() => loadTranscript(chat.id), [chat.id]);
	return (
		<>
			<div className="ea-head">
				<span className="ea-dot" data-s="expired" title="session expired" />
				<span className="ea-title">{chat.title}</span>
			</div>
			<div className="ea-msgs">
				{saved.length ? <Transcript messages={saved} /> : <div className="ea-empty">Nothing was saved for this chat.</div>}
			</div>
			<div className="ea-note">This chat's session has expired; it is read-only. Start a new chat to continue.</div>
		</>
	);
}

function Panel({ config, onClose }: { config: Config; onClose: () => void }) {
	const [chats, setChats] = useState<Chat[]>(() => loadChats());
	const [activeId, setActiveId] = useState<string | null>(() => loadChats().find(isLive)?.id ?? null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const persist = (next: Chat[]) => {
		setChats(next);
		saveChats(next);
	};

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const chat = await openChat(config, chats);
			persist([chat, ...chats]);
			setActiveId(chat.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		if (!activeId) void create();
	}, []);

	const remove = (id: string) => {
		const chat = chats.find((c) => c.id === id);
		const remaining = chats.filter((c) => c.id !== id);
		persist(remaining);
		try {
			localStorage.removeItem(TRANSCRIPT_KEY(id));
		} catch {
			/* ignore */
		}
		if (activeId === id) setActiveId(remaining.find(isLive)?.id ?? remaining[0]?.id ?? null);
		if (chat) void closeChat(config, chat, remaining);
	};

	const update = (id: string, patch: Partial<Chat>) => {
		setChats((prev) => {
			const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
			saveChats(next);
			return next;
		});
	};

	const active = chats.find((c) => c.id === activeId) ?? null;

	return (
		<div className="ea-shell" data-emdash-agent="">
			<Sidebar chats={chats} activeId={activeId} onSelect={setActiveId} onNew={() => void create()} onDelete={remove} busy={busy} />
			<div className="ea-panel">
				{active ? (
					isLive(active) ? (
						<LiveChat key={active.id} chat={active} onUpdate={(patch) => update(active.id, patch)} />
					) : (
						<ExpiredChat key={active.id} chat={active} />
					)
				) : (
					<>
						<div className="ea-head">
							<span className="ea-dot" data-s={error ? "rejected" : "connecting"} />
							<span className="ea-title">Site agent</span>
						</div>
						<div className="ea-empty">{error ?? (busy ? "Opening a session…" : "Start a new chat.")}</div>
					</>
				)}
			</div>
			<button type="button" className="ea-btn ea-close" onClick={onClose} aria-label="Close">
				×
			</button>
		</div>
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
