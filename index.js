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