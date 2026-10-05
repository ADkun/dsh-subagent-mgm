/**
 * Host half of the dsh-subagent-mgm bundle.
 *
 * Both behaviours live in the browser, but their switches must survive a page
 * reload there, so this half owns their durable side: the same-origin route
 * `/api/subagent-mgm/settings` (GET / POST / DELETE) backs the Settings page
 * and keeps the four switches in `<DSH_PROFILE_DIR|DSH_HOME|~/.dsh>/subagent-mgm.json`,
 * beside the profile that owns this row.
 *
 * Per field the effective value is: the saved file, else this row's own Config,
 * else the built-in default. Nothing on the host reads these values — the
 * browser half applies them to ordering and to the automatic sidebar panels.
 *
 * The same prefix also serves `/api/subagent-mgm/face?sessionId=…` (GET), read
 * only: the capability face of one subagent — the tools its last request
 * advertised, the model it ran on, the skills its preset sees, and the persona
 * its delegation wrote. Only the host can answer that, because another session's
 * tools and persona live in that session's durable log, not in any projection
 * the browser receives. See `faceFor`.
 *
 * `/api/subagent-mgm/models?sessionIds=a,b,c` (GET) answers the same question
 * for a whole batch, reduced to the model behind each id, so the catalog can
 * total its tree by model without one request per row. It reads one log per id,
 * so the batch is capped and each id's failure stays its own. See `modelsFor`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "subagent-mgm";

/** Order the subagent catalog by creation time, newest first (behaviour 1). */
const DEFAULT_NEWEST_FIRST = true;
/** Open a right-sidebar panel for a subagent that starts running (behaviour 2). */
const DEFAULT_AUTO_OPEN = true;
/** Close that panel again when the subagent stops running. */
const DEFAULT_AUTO_CLOSE = true;
/** Bring an already open panel forward; off means never steal focus. */
const DEFAULT_REVEAL = true;

const ROUTE_PATH = "/api/subagent-mgm";
const STORE_NAME = "subagent-mgm.json";
const MAX_BODY_BYTES = 64 * 1024;
/** Every switch this page owns, in page order. */
const FIELDS = ["newestFirst", "autoOpen", "autoClose", "reveal"];

/** Sub-path that answers with one subagent's capability face. */
const FACE_ROUTE = "/face";
/** Sub-path that answers with the model behind a batch of subagent ids. */
const MODELS_ROUTE = "/models";
/** One model answer costs one log read, so a batch never exceeds this many ids. */
const MAX_MODEL_BATCH = 64;
/** A session id is opaque, but it must never reach a log path unfenced. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Cap on the persona this route ships; a runaway prompt is not a persona. */
const MAX_PERSONA_CHARS = 20_000;
/**
 * The harness writes a persona prefix of its own when a delegation names none:
 * it names the model that run answers with. Recovering that line is honest, but
 * it is not a persona anybody chose, so the answer says which one it is.
 */
const GENERATED_PERSONA = /^You are a(n)? (coding )?agent powered by the .+ model\.$/;

/** Accept a JSON boolean or its string spelling; anything else is absent. */
function validFlag(value) {
	if (value === true || value === "true") return true;
	if (value === false || value === "false") return false;
	return undefined;
}

function settingsFile() {
	const directory =
		process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	return path.join(directory, STORE_NAME);
}

function defaults() {
	return {
		newestFirst: DEFAULT_NEWEST_FIRST,
		autoOpen: DEFAULT_AUTO_OPEN,
		autoClose: DEFAULT_AUTO_CLOSE,
		reveal: DEFAULT_REVEAL,
	};
}

/** Keep only fields that pass validation, so a hand-edited file cannot poison a page. */
function normalizeSettings(raw) {
	const normalized = {};
	if (raw === null || typeof raw !== "object") return normalized;
	for (const field of FIELDS) {
		const value = validFlag(raw[field]);
		if (value !== undefined) normalized[field] = value;
	}
	return normalized;
}

function readStored(file) {
	try {
		return normalizeSettings(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return {};
	}
}

/** Replace the store atomically: a crash mid-write leaves the previous file intact. */
function writeStored(file, settings) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(settings, undefined, 2)}\n`, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/** Split an authority into its three comparable parts, or null when unusable. */
function authorityOf(value, defaultScheme = "http") {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value.includes("://") ? value : `${defaultScheme}://${value}`);
		return {
			scheme: url.protocol.replace(/:$/, ""),
			hostname: url.hostname.toLowerCase(),
			port: url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80",
		};
	} catch {
		return null;
	}
}

const FORBIDDEN = { status: 403, message: "forbidden" };

/**
 * Refuse anything a browser page on another origin could have sent. The
 * connection service is the authority when it is installed; otherwise the
 * structural fence below stands on its own.
 */
function rejectionFor(req, connection) {
	if (connection !== undefined && typeof connection.admit === "function") {
		const admission = connection.admit(req);
		if (admission !== undefined && "rejection" in admission) return admission.rejection;
		return undefined;
	}
	const host = authorityOf(req.headers.host);
	if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return FORBIDDEN;
	if (req.headers["sec-fetch-site"] === "cross-site") return FORBIDDEN;
	for (const header of ["origin", "referer"]) {
		const value = req.headers[header];
		if (value === undefined) continue;
		const peer = authorityOf(value, host.scheme);
		if (peer === null) return FORBIDDEN;
		if (peer.scheme !== host.scheme || peer.hostname !== host.hostname || peer.port !== host.port) {
			return FORBIDDEN;
		}
	}
	return undefined;
}

function readJson(req) {
	return new Promise((resolve) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size <= MAX_BODY_BYTES) chunks.push(chunk);
		});
		req.on("end", () => {
			if (size === 0 || size > MAX_BODY_BYTES) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(parsed !== null && typeof parsed === "object" ? parsed : {});
			} catch {
				resolve({});
			}
		});
		req.on("error", () => resolve({}));
	});
}

/** A refusal the caller can act on, as opposed to a genuine server fault. */
class FaceError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** The last event of one type in a session log, or undefined. */
function lastEventOf(events, type) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (events[index]?.type === type) return events[index];
	}
	return undefined;
}

/** The first event of one type in a session log, or undefined. */
function firstEventOf(events, type) {
	for (const event of events) {
		if (event?.type === type) return event;
	}
	return undefined;
}

/** The plain text of one model-facing message, joined across its text blocks. */
function textOf(message) {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/**
 * The system prompt a session was composed with, or "".
 *
 * This is the *first* one in the log, not the newest: a session can be recomposed
 * mid-life — switching models rewrites the persona slot — and that later
 * composition says nothing about what a delegation handed its child. Both sides
 * of the comparison below have to be read at the same moment for the difference
 * between them to mean anything.
 */
function promptOf(events) {
	return textOf(firstEventOf(events, "system/message")?.data?.message);
}

/** Everything before the first blank line: a system prompt's leading section. */
function firstSection(text) {
	const cut = text.indexOf("\n\n");
	return (cut < 0 ? text : text.slice(0, cut)).trim();
}

/**
 * Align a child's system prompt against its parent's. Both are assembled from
 * ordered sections, so the shared prefix and suffix are the sections that did
 * not change and the middle is what each side's own composition put there.
 * @returns `{head, added, removed}` — shared leading lines, and each side's
 *   remainder with the shared suffix removed.
 */
function promptDifference(childText, parentText) {
	const child = childText.split("\n");
	const parent = parentText.split("\n");
	let head = 0;
	while (head < child.length && head < parent.length && child[head] === parent[head]) head += 1;
	let tail = 0;
	while (
		tail < child.length - head &&
		tail < parent.length - head &&
		child[child.length - 1 - tail] === parent[parent.length - 1 - tail]
	) {
		tail += 1;
	}
	return {
		head,
		added: child.slice(head, child.length - tail).join("\n"),
		removed: parent.slice(head, parent.length - tail).join("\n"),
	};
}

/**
 * The persona a child's composition was prefixed with, or undefined when the
 * log does not say. A delegation descriptor is authoritative, but one-shot
 * children never write one — for those the system prompt is the only witness.
 *
 * The fallback works because the persona is a *section*: `deployment:persona-prefix`
 * sits at order 0 and the harness identity at -1000, so a differing persona can
 * leave at most the first two lines (identity line, blank line) in common with
 * the parent. More than that and the difference is not the persona slot, so this
 * reports nothing rather than presenting some other section as a persona.
 *
 * Most children that name no persona still differ in that slot, because the
 * harness fills it with the model the run answers with. That line is reported
 * rather than hidden — it is what the child was actually told — but it is
 * flagged as generated, so nobody reads it as a persona that was chosen.
 */
async function personaFor(query, header, descriptor, events, parentHint) {
	const recorded = typeof descriptor?.persona === "string" ? descriptor.persona.trim() : "";
	if (recorded !== "") {
		return {
			text: recorded.slice(0, MAX_PERSONA_CHARS),
			source: "descriptor",
			inferred: false,
			generated: false,
			replaced: null,
		};
	}
	const childText = promptOf(events);
	if (childText === "") return undefined;
	const parentId = typeof header?.parentSession === "string" ? header.parentSession : parentHint;
	if (typeof parentId !== "string" || !SESSION_ID.test(parentId)) return undefined;
	let parentEvents;
	try {
		parentEvents = (await query.readSession(parentId))?.events;
	} catch {
		return undefined;
	}
	const parentText = promptOf(Array.isArray(parentEvents) ? parentEvents : []);
	if (parentText === "") return undefined;
	const difference = promptDifference(childText, parentText);
	if (difference.head > 2) return undefined;
	const added = firstSection(difference.added);
	if (added === "") return undefined;
	return {
		text: added.slice(0, MAX_PERSONA_CHARS),
		source: "system-prompt",
		inferred: true,
		generated: GENERATED_PERSONA.test(added),
		replaced: firstSection(difference.removed) || null,
	};
}

/** The skills a session may invoke, as the host skill catalog reports them. */
async function skillsFor(ctx, sessionId, signal) {
	const catalog = ctx.get("sessionSkillCatalog");
	if (catalog === undefined || typeof catalog.list !== "function") {
		return { state: "unavailable", entries: [] };
	}
	try {
		const value = await catalog.list({ sessionId }, signal);
		const entries = (value?.skills ?? []).map((skill) => ({
			name: skill.name,
			description: skill.description ?? "",
			modelInvocable: skill.modelInvocable === true,
			...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
			...(skill.path === undefined ? {} : { path: skill.path }),
		}));
		return { state: "ok", entries };
	} catch (error) {
		return { state: "error", error: `${error?.message ?? error}`, entries: [] };
	}
}

/**
 * Rebuild one subagent's capability face from its durable log: the delegation
 * identity, the tool set and model of its last request, and its persona. The
 * skills come from the host catalog instead, since those follow the session's
 * preset and working directory rather than the log.
 */
async function faceFor(ctx, sessionId, parentHint, signal) {
	const query = ctx.get("sessionQuery");
	if (query === undefined || typeof query.readSession !== "function") {
		throw new FaceError(503, "session reads are unavailable: the session-query service is not mounted");
	}
	let snapshot;
	try {
		snapshot = await query.readSession(sessionId);
	} catch (error) {
		if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") {
			throw new FaceError(404, `session "${sessionId}" has no log in this profile`);
		}
		throw new FaceError(500, `session "${sessionId}" could not be read: ${error?.message ?? error}`);
	}
	const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
	const header = snapshot?.session ?? {};
	const descriptor = firstEventOf(events, "subagent/descriptor")?.data;
	const request = lastEventOf(events, "request/header")?.data?.header;
	const config = request?.config ?? {};
	return {
		ok: true,
		sessionId,
		subagent: {
			mode: typeof descriptor?.mode === "string" ? descriptor.mode : "unknown",
			label: typeof descriptor?.label === "string" ? descriptor.label : null,
			provider: typeof descriptor?.provider === "string" ? descriptor.provider : null,
			agentProvider: descriptor?.agentProvider ?? null,
			agentModel: descriptor?.agentModel ?? null,
			agentReasoningEffort: descriptor?.agentReasoningEffort ?? null,
			toolFilter: descriptor?.toolFilter ?? null,
		},
		session: {
			createdAt: header.createdAt ?? null,
			cwd: header.cwd ?? null,
			origin: header.origin ?? null,
			delegationDepth: header.delegationDepth ?? null,
			agentPreset: header.agentPreset ?? null,
			parentSession: header.parentSession ?? null,
			isSeeded: header.isSeeded === true,
		},
		run: {
			provider: config.provider ?? null,
			model: config.model ?? null,
			reasoningEffort: config.reasoningEffort ?? null,
			temperature: config.temperature ?? null,
			maxTokens: config.maxTokens ?? null,
		},
		tools: (Array.isArray(request?.tools) ? request.tools : []).map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.parameters ?? {},
			deferLoading: tool.deferLoading === true,
		})),
		persona: (await personaFor(query, header, descriptor, events, parentHint)) ?? null,
		skills: await skillsFor(ctx, sessionId, signal),
	};
}

/**
 * Fold the model behind each named subagent from its own log: what the
 * delegation asked for (the descriptor) and what its last request actually ran
 * on. One read per id, so the caller caps the batch; a single unreadable id
 * answers for itself and never fails the whole batch.
 */
async function modelsFor(ctx, sessionIds) {
	const query = ctx.get("sessionQuery");
	if (query === undefined || typeof query.readSession !== "function") {
		throw new FaceError(503, "session reads are unavailable: the session-query service is not mounted");
	}
	const entries = await Promise.all(sessionIds.map(async (sessionId) => {
		try {
			const snapshot = await query.readSession(sessionId);
			const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
			const header = snapshot?.session ?? {};
			const descriptor = firstEventOf(events, "subagent/descriptor")?.data;
			const config = lastEventOf(events, "request/header")?.data?.header?.config ?? {};
			return {
				sessionId,
				state: "ok",
				preset: header.agentPreset ?? null,
				mode: typeof descriptor?.mode === "string" ? descriptor.mode : "unknown",
				agentProvider: descriptor?.agentProvider ?? null,
				agentModel: descriptor?.agentModel ?? null,
				agentReasoningEffort: descriptor?.agentReasoningEffort ?? null,
				provider: config.provider ?? null,
				model: config.model ?? null,
				reasoningEffort: config.reasoningEffort ?? null,
			};
		} catch (error) {
			if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return { sessionId, state: "missing" };
			return { sessionId, state: "error", error: `${error?.message ?? error}` };
		}
	}));
	return { ok: true, entries };
}

/**
 * Register the settings route. `webServer` is asked for rather than injected, so
 * a composition without an HTTP carrier loses the page but keeps the plugin.
 */
export function apply(ctx, config = {}) {
	const configured = normalizeSettings(config);
	const file = settingsFile();

	/** Effective values, the row Config, and what the page wrote. */
	function describe() {
		const stored = readStored(file);
		const defaults_ = defaults();
		const effective = {};
		for (const field of FIELDS) {
			effective[field] = stored[field] ?? configured[field] ?? defaults_[field];
		}
		return {
			ok: true,
			...effective,
			configured: { ...configured },
			stored: { ...stored },
			fields: [...FIELDS],
			file,
		};
	}

	ctx.inject(["webServer"], (scoped) => {
		scoped.effect(
			() =>
				scoped.webServer.register({
					kind: "prefix",
					path: ROUTE_PATH,
					handler: async (req, res) => {
						const send = (status, payload) => {
							const body = JSON.stringify(payload);
							res.writeHead(status, {
								"content-type": "application/json; charset=utf-8",
								"cache-control": "no-store",
								"content-length": Buffer.byteLength(body),
							});
							res.end(body);
						};
						const rejection = rejectionFor(req, ctx.get("connection"));
						if (rejection !== undefined) {
							send(rejection.status === 401 ? 401 : 403, {
								error: rejection.status === 401 ? "unauthorized" : "forbidden",
							});
							return;
						}
						const url = new URL(req.url ?? "/", "http://localhost");
						const route = url.pathname.slice(ROUTE_PATH.length).replace(/\/+$/, "") || "/";
						if (route === FACE_ROUTE) {
							if (req.method !== "GET") {
								send(405, { error: "method not allowed" });
								return;
							}
							const sessionId = url.searchParams.get("sessionId") ?? "";
							if (!SESSION_ID.test(sessionId)) {
								send(400, { error: "sessionId is required" });
								return;
							}
							const parentHint = url.searchParams.get("parent");
							try {
								send(
									200,
									await faceFor(
										ctx,
										sessionId,
										parentHint === null ? undefined : parentHint,
										new AbortController().signal,
									),
								);
							} catch (error) {
								send(error instanceof FaceError ? error.status : 500, {
									error: `${error?.message ?? error}`,
								});
							}
							return;
						}
						if (route === MODELS_ROUTE) {
							if (req.method !== "GET") {
								send(405, { error: "method not allowed" });
								return;
							}
							const named = [...new Set((url.searchParams.get("sessionIds") ?? "")
								.split(",")
								.map((value) => value.trim())
								.filter((value) => value !== ""))];
							if (named.length === 0) {
								send(400, { error: "sessionIds is required" });
								return;
							}
							if (named.length > MAX_MODEL_BATCH) {
								send(400, { error: `at most ${MAX_MODEL_BATCH} sessionIds are read per request` });
								return;
							}
							const invalid = named.find((value) => !SESSION_ID.test(value));
							if (invalid !== undefined) {
								send(400, { error: `invalid session id "${invalid}"` });
								return;
							}
							try {
								send(200, await modelsFor(ctx, named));
							} catch (error) {
								send(error instanceof FaceError ? error.status : 500, {
									error: `${error?.message ?? error}`,
								});
							}
							return;
						}
						if (route !== "/settings") {
							send(404, { error: "not found" });
							return;
						}
						if (req.method === "GET") {
							send(200, describe());
							return;
						}
						if (req.method === "DELETE") {
							try {
								fs.rmSync(file, { force: true });
							} catch (error) {
								send(500, { error: `could not clear: ${error?.message ?? error}` });
								return;
							}
							send(200, describe());
							return;
						}
						if (req.method === "POST") {
							const body = await readJson(req);
							const stored = readStored(file);
							const next = { ...stored };
							let touched = 0;
							let failure;
							for (const field of FIELDS) {
								if (body[field] === undefined) continue;
								touched += 1;
								const value = validFlag(body[field]);
								if (value === undefined) {
									failure ??= `${field} must be true or false`;
									continue;
								}
								next[field] = value;
							}
							if (touched === 0) {
								send(400, { error: "no settings provided" });
								return;
							}
							if (failure !== undefined) {
								send(400, { error: failure });
								return;
							}
							try {
								writeStored(file, next);
							} catch (error) {
								send(500, { error: `could not save: ${error?.message ?? error}` });
								return;
							}
							send(200, describe());
							return;
						}
						send(405, { error: "method not allowed" });
					},
				}),
			"subagent-mgm: settings api",
		);
	});
}