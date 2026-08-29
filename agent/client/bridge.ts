/**
 * The browser side of the bridge: a WebSocket to the session's BrowserBridge
 * object, answering tool calls with what this tab can see and do.
 */
import html2canvas from "html2canvas";

type Call = { type: "call"; id: string; tool: string; args: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

export type BridgeStatus = "connecting" | "open" | "closed" | "rejected";

interface ConsoleEntry {
	level: "log" | "info" | "warn" | "error";
	text: string;
	time: string;
}

const CONSOLE_LIMIT = 300;
const consoleLog: ConsoleEntry[] = [];
let consoleHooked = false;

function stringify(v: unknown, depth = 0): string {
	if (typeof v === "string") return v;
	if (v instanceof Error) return `${v.name}: ${v.message}`;
	try {
		return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? String(val) : val)) ?? String(v);
	} catch {
		return depth > 0 ? "[unserializable]" : String(v);
	}
}

function record(level: ConsoleEntry["level"], args: unknown[]): void {
	consoleLog.push({ level, text: args.map((a) => stringify(a)).join(" ").slice(0, 2000), time: new Date().toISOString() });
	if (consoleLog.length > CONSOLE_LIMIT) consoleLog.splice(0, consoleLog.length - CONSOLE_LIMIT);
}

/** Capture console output and uncaught errors from now on (idempotent). */
export function hookConsole(): void {
	if (consoleHooked) return;
	consoleHooked = true;
	for (const level of ["log", "info", "warn", "error"] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			record(level, args);
			original(...args);
		};
	}
	window.addEventListener("error", (e) => record("error", [e.message, `${e.filename}:${e.lineno}:${e.colno}`]));
	window.addEventListener("unhandledrejection", (e) => record("error", ["Unhandled rejection:", e.reason]));
}

function pick(selector: unknown, index = 0): Element {
	const sel = typeof selector === "string" ? selector : "";
	if (!sel) throw new Error("selector required");
	const all = document.querySelectorAll(sel);
	const el = all[index];
	if (!el) throw new Error(`no element matches ${sel}${index ? ` at index ${index}` : ""}`);
	return el;
}

function cap(s: string, max: unknown, fallback: number): string {
	const n = typeof max === "number" && Number.isFinite(max) ? max : fallback;
	return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

function describe(el: Element): Record<string, unknown> {
	const r = el.getBoundingClientRect();
	return {
		tag: el.tagName.toLowerCase(),
		id: el.id || undefined,
		class: el.className && typeof el.className === "string" ? el.className : undefined,
		text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
		rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
	};
}

/** Every `data-emdash-ref` on the page: the content that renders here. */
export function editableFields(): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	document.querySelectorAll("[data-emdash-ref]").forEach((el) => {
		let ref: unknown = null;
		try {
			ref = JSON.parse(el.getAttribute("data-emdash-ref") ?? "");
		} catch {
			ref = el.getAttribute("data-emdash-ref");
		}
		out.push({ ref, ...describe(el) });
	});
	return out;
}

const handlers: Record<string, Handler> = {
	browser_info: () => ({
		url: location.href,
		title: document.title,
		viewport: { width: innerWidth, height: innerHeight },
		scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
		pageHeight: document.documentElement.scrollHeight,
		userAgent: navigator.userAgent,
		editableFields: document.querySelectorAll("[data-emdash-ref]").length,
		editMode: document.getElementById("emdash-toolbar")?.getAttribute("data-edit-mode") === "true",
	}),

	browser_editable_fields: () => editableFields(),

	browser_text: (args) => {
		const root = args.selector ? pick(args.selector) : document.body;
		const text = ((root as HTMLElement).innerText ?? root.textContent ?? "").replace(/\n{3,}/g, "\n\n");
		return cap(text, args.maxChars, 20_000);
	},

	browser_snapshot: (args) => {
		const root = args.selector ? pick(args.selector) : document.documentElement;
		const clone = root.cloneNode(true) as Element;
		clone.querySelectorAll("script, #emdash-toolbar, #emdash-agent-root, [data-emdash-agent]").forEach((n) => n.remove());
		return cap(clone.outerHTML, args.maxChars, 60_000);
	},

	browser_styles: (args) => {
		const sel = String(args.selector ?? "");
		const limit = typeof args.limit === "number" ? args.limit : 5;
		const props = Array.isArray(args.properties) ? (args.properties as string[]) : null;
		const els = Array.from(document.querySelectorAll(sel)).slice(0, limit);
		if (els.length === 0) throw new Error(`no element matches ${sel}`);
		return els.map((el) => {
			const cs = getComputedStyle(el);
			const styles: Record<string, string> = {};
			const names = props ?? Array.from(cs).filter((n) => !n.startsWith("-webkit") && !n.startsWith("-moz"));
			for (const n of names) {
				const v = cs.getPropertyValue(n);
				if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px") styles[n] = v;
			}
			return { ...describe(el), styles };
		});
	},

	browser_assets: async (args) => {
		if (typeof args.fetch === "string") {
			const target = new URL(args.fetch, location.href);
			if (target.origin !== location.origin) throw new Error("only same-origin assets can be read");
			const res = await fetch(target.href, { credentials: "same-origin" });
			return { url: target.href, status: res.status, contentType: res.headers.get("content-type"), body: cap(await res.text(), args.maxChars, 60_000) };
		}
		return {
			stylesheets: Array.from(document.querySelectorAll('link[rel~="stylesheet"]')).map((l) => (l as HTMLLinkElement).href),
			inlineStyles: Array.from(document.querySelectorAll("style")).map((s, i) => ({ index: i, chars: (s.textContent ?? "").length, id: s.id || undefined })),
			scripts: Array.from(document.querySelectorAll("script")).map((s) => ({ src: (s as HTMLScriptElement).src || undefined, type: s.type || undefined, inlineChars: s.src ? undefined : (s.textContent ?? "").length })),
		};
	},

	browser_screenshot: async (args) => {
		const target = args.selector ? (pick(args.selector) as HTMLElement) : document.body;
		const full = args.fullPage === true || !!args.selector;
		const panel = document.getElementById("emdash-agent-root");
		const toolbar = document.getElementById("emdash-toolbar");
		const hidden = [panel, toolbar].filter((n): n is HTMLElement => !!n);
		hidden.forEach((n) => (n.style.visibility = "hidden"));
		try {
			const canvas = await html2canvas(target, {
				useCORS: true,
				logging: false,
				scale: Math.min(1, 1600 / Math.max(1, full ? target.scrollWidth : innerWidth)),
				...(full ? {} : { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight, windowWidth: innerWidth, windowHeight: innerHeight }),
			});
			return { data: canvas.toDataURL("image/png").split(",")[1], width: canvas.width, height: canvas.height };
		} finally {
			hidden.forEach((n) => (n.style.visibility = ""));
		}
	},

	browser_evaluate: async (args) => {
		const code = String(args.code ?? "");
		const fn = new Function(`return (async () => { ${code} })();`);
		const result = await fn();
		return JSON.parse(stringify(result === undefined ? null : result));
	},

	browser_console: (args) => {
		const level = typeof args.level === "string" ? args.level : null;
		const limit = typeof args.limit === "number" ? args.limit : 100;
		const items = level ? consoleLog.filter((e) => e.level === level) : consoleLog;
		return items.slice(-limit);
	},

	browser_click: (args) => {
		const el = pick(args.selector, typeof args.index === "number" ? args.index : 0) as HTMLElement;
		el.scrollIntoView({ block: "center" });
		el.click();
		return { clicked: describe(el) };
	},

	browser_type: (args) => {
		const el = pick(args.selector) as HTMLElement;
		const value = String(args.text ?? "");
		el.focus();
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
			setter ? setter.call(el, value) : (el.value = value);
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		} else if (el.isContentEditable) {
			el.textContent = value;
			el.dispatchEvent(new InputEvent("input", { bubbles: true }));
		} else {
			throw new Error("element is not an input, textarea or contenteditable");
		}
		if (args.submit === true) {
			el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			(el.closest("form") as HTMLFormElement | null)?.requestSubmit();
		}
		return { typed: value.length, into: describe(el) };
	},

	browser_scroll: (args) => {
		if (args.selector) {
			const el = pick(args.selector);
			el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
			return { scrolledTo: describe(el) };
		}
		window.scrollTo({ top: Number(args.y ?? 0), behavior: "instant" as ScrollBehavior });
		return { scroll: { x: Math.round(scrollX), y: Math.round(scrollY) } };
	},

	browser_navigate: (args) => {
		if (args.reload === true) {
			setTimeout(() => location.reload(), 50);
			return { reloading: location.href };
		}
		const target = new URL(String(args.url ?? ""), location.href);
		if (target.origin !== location.origin) throw new Error("only pages on this site can be opened");
		setTimeout(() => location.assign(target.href), 50);
		return { navigating: target.href };
	},
};

export interface BridgeOptions {
	host: string;
	sessionId: string;
	ticket: string;
	onStatus: (status: BridgeStatus) => void;
}

/** Keep a socket to the session's bridge open (reconnecting) until `close()`. */
export function connectBridge(opts: BridgeOptions): { close(): void } {
	hookConsole();
	let ws: WebSocket | null = null;
	let closed = false;
	let attempt = 0;
	const wsUrl = `${opts.host.replace(/^http/, "ws")}/browser/${opts.sessionId}/ws?ticket=${encodeURIComponent(opts.ticket)}`;

	const connect = () => {
		if (closed) return;
		opts.onStatus("connecting");
		ws = new WebSocket(wsUrl);
		ws.onopen = () => {
			attempt = 0;
			opts.onStatus("open");
			ws?.send(JSON.stringify({ type: "hello", url: location.href, title: document.title }));
		};
		ws.onmessage = async (event) => {
			let msg: Call;
			try {
				msg = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (msg.type !== "call") return;
			const reply = (payload: Record<string, unknown>) => ws?.send(JSON.stringify({ type: "result", id: msg.id, ...payload }));
			const handler = handlers[msg.tool];
			if (!handler) {
				reply({ ok: false, error: `unknown tool ${msg.tool}` });
				return;
			}
			try {
				reply({ ok: true, result: await handler(msg.args ?? {}) });
			} catch (error) {
				reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		};
		ws.onclose = (event) => {
			if (closed) return;
			if (event.code === 1008 || event.code === 4401) {
				opts.onStatus("rejected");
				return;
			}
			opts.onStatus("closed");
			attempt += 1;
			setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)));
		};
		ws.onerror = () => ws?.close();
	};
	connect();
	return {
		close() {
			closed = true;
			ws?.close(1000, "panel closed");
		},
	};
}
