/**
 * Behaviour checks for this bundle's shipped client half.
 *
 * Both suites read `client.js` itself and exercise the extracted functions, so
 * a regression in the real file fails here. Run: `node verify.mjs`
 *
 * 1. pure helpers: `sortNewestFirst` (catalog order), `chatAddress` and
 *    `panelChildId` (sidebar panel identity);
 * 2. the panel reconciler `startSubagentPanels`, driven by a fake context whose
 *    sidebar surface mimics the documented sidebar-right tab semantics:
 *    opening the address of an already open tab reveals it instead of adding a
 *    second tab.
 *
 * 3. static wiring checks for the lineage half: the sibling switcher, its
 *    shadowing priority over the shipped breadcrumb, and the branch refresh;
 * 4. the Settings page: the three switches gate the panel reconciler, the page
 *    is wired into the settings slot, and the host half serves its route;
 * 5. the host half behaviourally: the real route handler answers GET, POST and
 *    DELETE, refuses a bad value, a foreign origin and an unowned method, and
 *    resolves precedence as saved file, then row Config, then built-in default.
 *
 * No DOM, no React and no browser are involved.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source = readFileSync(new URL("./client.js", import.meta.url), "utf8");

/** Extract one top-level function declaration by name, brace-balanced. */
function extract(name) {
	const start = source.indexOf("function " + name + "(");
	if (start < 0) throw new Error(`function ${name} is missing from client.js`);
	const open = source.indexOf("{", start);
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	throw new Error(`function ${name} has unbalanced braces`);
}

/** Extract one `const NAME = "..."` literal declaration. */
function literal(name) {
	const match = new RegExp("const " + name + ' = ("(?:[^"\\\\]|\\\\.)*")').exec(source);
	if (match === null) throw new Error(`constant ${name} is missing from client.js`);
	return "const " + name + " = " + match[1] + ";";
}

const failures = [];
let passed = 0;
const check = (label, actual, expected) => {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	if (left === right) {
		passed += 1;
		console.log(`ok   ${label}`);
	} else failures.push(`${label}\n  actual   ${left}\n  expected ${right}`);
};

// ---------------------------------------------------------------- pure helpers

const helpers = new Function(
	literal("CHAT_PREFIX") + "\n" +
	extract("sortNewestFirst") + "\n" + extract("chatAddress") + "\n" + extract("panelChildId") +
	"\nreturn { sortNewestFirst, chatAddress, panelChildId };"
)();
const order = (entries) => helpers.sortNewestFirst(entries).map((entry) => entry.id);

check("newest createdAt wins", order([
	{ id: "old", createdAt: 1_000 },
	{ id: "new", createdAt: 3_000 },
	{ id: "mid", createdAt: 2_000 }
]), ["new", "mid", "old"]);
check("equal stamps fall back to the later host-array event", order([
	{ id: "a", createdAt: 5 }, { id: "b", createdAt: 5 }, { id: "c", createdAt: 5 }
]), ["c", "b", "a"]);
check("missing createdAt ranks below a real stamp", order([
	{ id: "none" }, { id: "has", createdAt: 7 }, { id: "alsoNone", createdAt: null }
]), ["has", "alsoNone", "none"]);
check("the caller's array is not mutated", (() => {
	const entries = [{ id: "old", createdAt: 1 }, { id: "new", createdAt: 2 }];
	helpers.sortNewestFirst(entries);
	return entries.map((entry) => entry.id);
})(), ["old", "new"]);

const address = helpers.chatAddress("parent-session", "child-session", "continuable");
check("chatAddress matches the shipped resource scheme", address,
	"dsh-resource://subagentchat/session/child-session?parent=parent-session&mode=continuable");
check("an unknown mode is stated, never dropped", helpers.chatAddress("p", "c", undefined),
	"dsh-resource://subagentchat/session/c?parent=p&mode=unknown");
check("the child identity is escaped exactly once",
	helpers.chatAddress("p", "child/with space", "one-shot"),
	"dsh-resource://subagentchat/session/child%2Fwith%20space?parent=p&mode=one-shot");
check("a panel address recovers its child", helpers.panelChildId(address), "child-session");
check("a mode difference does not hide an open panel",
	helpers.panelChildId(helpers.chatAddress("p", "child-session", "unknown")), "child-session");
check("escaping survives the round trip",
	helpers.panelChildId(helpers.chatAddress("p", "child/with space", "one-shot")), "child/with space");
check("a foreign tab is not claimed", helpers.panelChildId("dsh-resource://page/session/abc"), undefined);
check("a bare prefix is not claimed", helpers.panelChildId("dsh-resource://subagentchat/session/"), undefined);
check("a missing identity is not claimed", helpers.panelChildId(undefined), undefined);

// ------------------------------------------------------------ panel reconciler

const startSubagentPanelsFactory = new Function(
	"__settingsStore",
	literal("CHAT_KIND") + "\n" + literal("CHAT_PREFIX") + "\n" +
	extract("chatAddress") + "\n" + extract("panelChildId") + "\n" + extract("startSubagentPanels") +
	"\nconst settingsStore = __settingsStore;\nreturn startSubagentPanels;"
);

const PARENT = "parent-session";
const CHILD = "child-session";

/** Minimal observable snapshot, the shape the client store publishes. */
const observable = (value) => {
	const listeners = new Set();
	return {
		getSnapshot: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of listeners) listener();
		}
	};
};

const settingsState = observable({ newestFirst: true, autoOpen: true, autoClose: true, reveal: true });
const settingsStoreStub = {
	getSnapshot: () => settingsState.getSnapshot(),
	subscribe: (listener) => settingsState.subscribe(listener)
};
const startSubagentPanels = startSubagentPanelsFactory(settingsStoreStub);

const state = { catalog: [{ id: CHILD, mode: "continuable", createdAt: 1 }], nextTabId: 1 };
const mounted = observable(PARENT);
const panels = observable([]);
const sessions = observable({
	projectionsBySession: { [PARENT]: { state: "idle", values: { subagentCatalog: state.catalog } } },
	byId: {}
});
const status = observable(new Map());
const calls = { open: [], reveal: [], close: [] };

const sidebar = {
	mounted,
	openTabs: panels,
	openResourceIn(sessionId, address, options) {
		calls.open.push(address);
		options.kind;
		if (panels.getSnapshot().some((tab) => tab.contentId === address && tab.kind === "subagentchat")) {
			calls.reveal.push(address);
			return;
		}
		panels.set([...panels.getSnapshot(), {
			sessionId,
			tabId: `tab-${state.nextTabId++}`,
			kind: "subagentchat",
			contentId: address
		}]);
	},
	closeIn(sessionId, tabId) {
		calls.close.push(tabId);
		panels.set(panels.getSnapshot().filter((tab) => !(tab.sessionId === sessionId && tab.tabId === tabId)));
	}
};

const ctx = {
	sidebarRight: sidebar,
	sessions: { list: sessions, refreshProjections: () => Promise.resolve() },
	uiSession: { sessionStatus: status }
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const setRunning = async (running) => {
	const next = new Map(status.getSnapshot());
	next.set(CHILD, { running });
	status.set(next);
	await flush();
};
const openPanels = () =>
	panels.getSnapshot().filter((tab) => tab.kind === "subagentchat" && tab.sessionId === PARENT).length;

const dispose = startSubagentPanels(ctx);
await flush();

check("an idle catalogued child opens nothing", openPanels(), 0);

await setRunning(true);
check("a running child gets a panel", openPanels(), 1);
await flush();
await flush();
check("a continuously running child keeps one panel", openPanels(), 1);
check("a continuously running child is opened exactly once", calls.open.length, 1);

await setRunning(false);
check("a finished child loses its panel", openPanels(), 0);
check("the plugin closed that panel itself", calls.close.length, 1);

await setRunning(true);
check("a child the parent resumes gets its panel back", openPanels(), 1);
check("resuming opens rather than revealing a stale tab", calls.reveal.length, 0);

await setRunning(false);
await setRunning(true);
check("resuming stays a single panel across the close race", openPanels(), 1);

const beforeUserClose = calls.open.length;
sidebar.closeIn(PARENT, panels.getSnapshot()[0].tabId);
await flush();
await flush();
check("a panel the user closed stays closed for this run", openPanels(), 0);
check("the user close is not fought with another open", calls.open.length, beforeUserClose);

await setRunning(false);
await setRunning(true);
check("the next run opens again after an earlier user close", openPanels(), 1);
check("that recovery is an open, not a reveal", calls.reveal.length, 0);

await setRunning(false);
const revealsBefore = calls.reveal.length;
panels.set([{
	sessionId: PARENT,
	tabId: "tab-foreign",
	kind: "subagentchat",
	contentId: "dsh-resource://subagentchat/session/child-session?parent=parent-session&mode=one-shot"
}]);
await flush();
await setRunning(true);
check("an already open panel is surfaced instead of duplicated", openPanels(), 1);
check("surfacing an already open panel counts as a reveal", calls.reveal.length - revealsBefore, 1);
check("surfacing creates no second record", panels.getSnapshot().length, 1);

dispose();
await flush();

// ------------------------------------------------------- lineage wiring (static)
//
// The lineage half is bound to React and the DOM, so it is checked structurally
// against the real source: the shipped breadcrumb holds
// `conversation.session.header.lineage` at priority 0 and a single slot has no
// `id`, so this bundle must register the same slot one priority lower to be the
// one that renders, and both of its dropdowns must stay newest-first.

const applyRegion = source.slice(source.indexOf("const catalogActions = "));
const lineageEntry = applyRegion.slice(
	applyRegion.indexOf('name: "conversation.session.header.lineage"'),
	applyRegion.indexOf("SubagentMgrLineage"));
const drop = source.slice(source.indexOf("function CatalogDropdown("), source.indexOf("function SubagentMgrAction("));
const lineage = source.slice(source.indexOf("function SubagentMgrLineage("), source.indexOf("function startSubagentPanels("));

check("the lineage entry shadows the single shipped breadcrumb",
	/name: "conversation\.session\.header\.lineage",[\s\S]*?priority: -1/.test(lineageEntry), true);
check("the lineage entry reuses the catalog action factory",
	/inject: catalogActions/.test(lineageEntry), true);
check("the lineage entry renders for child sessions only",
	/if \(parentId === undefined\) return null;/.test(lineage), true);
check("the parent is read from the discovered address first",
	/address\?\.childSessionId === lineageSessionId/.test(lineage), true);
check("the parent is found by scanning catalogs as a fallback",
	/snapshot\.values\.subagentCatalog\?\.some\(\(entry\) => entry\.id === lineageSessionId\)/.test(lineage), true);
check("the switcher lists the parent catalog",
	/rootSessionId: parentId,[\s\S]*?variant: "switcher"/.test(lineage), true);
check("the switcher marks the session on screen",
	/currentSessionId: lineageSessionId,/.test(lineage), true);
check("the child keeps its own count trigger",
	/openTitle === undefined \? h\(CatalogDropdown, \{[\s\S]*?rootSessionId: lineageSessionId,/.test(lineage), true);
check("an ancestor breadcrumb navigates instead of opening a menu",
	/openTitle === undefined \? onTriggerClick : onAncestorClick/.test(drop), true);
check("the switcher trigger names itself through its own key",
	/t\("switcher\.aria", \{ title: switcherTitle \}\)/.test(drop), true);
check("both dictionaries translate the switcher label",
	(source.match(/"switcher\.aria":/g) ?? []).length, 2);
check("the switcher stylesheet ships with the client half",
	["smgm-switcherRoot", "smgm-switcherTrigger", "smgm-ancestorSwitcherTrigger", "smgm-switcherTitle"]
		.every((name) => source.includes("." + name + "{")), true);
check("a switcher renders while its catalog still loads",
	/variant === "switcher" \|\| presentedCatalog\.state === "error"/.test(drop), true);
check("every dropdown sorts the catalog newest-first by default",
	/const entries = settings\.newestFirst \? sortNewestFirst\(catalogEntries\) : catalogEntries;/.test(drop), true);
check("collapsing a branch drops its whole subtree",
	/const closeBranch = useCallback[\s\S]*?for \(const child of catalogOf\(parentSessionId, projections, summaries\)\?\.entries \?\? \[\]\) visit\(child\.id\)/.test(drop), true);
check("expanding a branch asks for the child's own catalog",
	/refreshProjection\(childSessionId\);/.test(drop), true);

// ------------------------------------------------- settings switches (behaviour)
//
// A second reconciler instance, driven by the same fake sidebar, proves that the
// three switches gate exactly what the first suite observed with all of them on.

settingsState.set({ newestFirst: false, autoOpen: false, autoClose: true, reveal: true });
panels.set([]);
status.set(new Map());
const openBaseline = calls.open.length;
const closeBaseline = calls.close.length;
const revealBaseline = calls.reveal.length;
const disposeSwitches = startSubagentPanels(ctx);
await flush();

await setRunning(true);
check("auto-open off keeps a running child out of the sidebar", openPanels(), 0);
check("auto-open off issues no open call at all", calls.open.length, openBaseline);

panels.set([{ sessionId: PARENT, tabId: "tab-user", kind: "subagentchat", contentId: helpers.chatAddress(PARENT, CHILD, "one-shot") }]);
await flush();
check("a panel opened by hand survives while auto-open is off", openPanels(), 1);

settingsState.set({ newestFirst: false, autoOpen: true, autoClose: true, reveal: false });
await flush();
await flush();
check("bring-forward off leaves the open panel alone", calls.reveal.length, revealBaseline);
check("bring-forward off opens nothing new", calls.open.length, openBaseline);

settingsState.set({ newestFirst: false, autoOpen: true, autoClose: true, reveal: true });
await flush();
await flush();
check("a switch change alone re-reconciles", calls.reveal.length - revealBaseline, 1);
check("surfacing keeps exactly one panel", openPanels(), 1);

settingsState.set({ newestFirst: false, autoOpen: true, autoClose: false, reveal: true });
await flush();
await setRunning(false);
check("auto-close off keeps a finished child's panel", openPanels(), 1);
check("auto-close off issues no close call", calls.close.length, closeBaseline);

settingsState.set({ newestFirst: false, autoOpen: true, autoClose: true, reveal: true });
await flush();
await setRunning(true);
await flush();
await setRunning(false);
check("auto-close on takes that panel away again", openPanels(), 0);
check("auto-close on closes it itself", calls.close.length, closeBaseline + 1);
disposeSwitches();
await flush();

// ------------------------------------------------------- switch wiring (static)
//
// The page itself is React and DOM, so it is checked structurally against the
// real source, together with the host half that has to serve its route.

const settingsSource = source.slice(
	source.indexOf("function SettingsSection("),
	source.indexOf("/** Insert this plugin's stylesheet")
);
const host = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const clientFields = /const SETTING_FIELDS = \[([^\]]*)\]/.exec(source)[1].replace(/["\s]/g, "");
const hostFields = /const FIELDS = \[([^\]]*)\]/.exec(host)[1].replace(/["\s]/g, "");

check("both halves own the same switch list", clientFields, hostFields);
check("the switches default to the shipped behaviour",
	/const DEFAULT_SETTINGS = Object\.freeze\(\{ newestFirst: true, autoOpen: true, autoClose: true, reveal: true \}\);/.test(source), true);
check("the switch store keeps only booleans",
	/typeof payload\?\.\[field\] === "boolean"/.test(source), true);
check("the panel keeper follows the switch store",
	/settingsStore\.subscribe\(schedule\)/.test(source), true);
check("the switches are read once per reconcile",
	/const reconcile = \(\) => \{\n\t+const settings = settingsStore\.getSnapshot\(\);/.test(source), true);
check("the catalog honours the order switch",
	/const rows = settings\.newestFirst \? sortNewestFirst\(entries\) : entries;/.test(source), true);
check("the dropdown honours the order switch",
	/const entries = settings\.newestFirst \? sortNewestFirst\(catalogEntries\) : catalogEntries;/.test(drop), true);
check("the panel keeper honours the auto-close switch",
	/if \(settings\.autoClose && panel !== undefined && wasRunning\.has\(entry\.id\)\) \{/.test(source), true);
check("the panel keeper honours auto-open and bring-forward",
	/if \(!settings\.autoOpen\) continue;[\s\S]{0,240}?if \(panel !== undefined && settings\.reveal === false\) continue;/.test(source), true);
check("the page reads the host route",
	/const SETTINGS_ROUTE = "\/api\/subagent-mgm\/settings";/.test(source), true);
check("the page is registered in the settings slot",
	/name: "settings\.section",[\s\S]{0,160}?id: "subagent-mgm",[\s\S]{0,160}?order: 37,[\s\S]{0,160}?label: \(\) => t\("settings\.nav"\)/.test(applyRegion), true);
check("the page resolves its own namespace",
	/locale: NS\s*\},?\s*\(props\) => h\(SettingsSection, \{ \.\.\.props, t \}\)/.test(applyRegion), true);
check("the page asks the host before showing values",
	/fetch\(SETTINGS_ROUTE, \{ headers: \{ accept: "application\/json" \} \}\)/.test(settingsSource), true);
check("a rejected save is shown, not swallowed",
	/if \(!response\.ok\) throw new Error\(payload\?\.error \?\? "HTTP " \+ response\.status\);/.test(settingsSource), true);
check("every switch is offered to the page",
	["newestFirst", "autoOpen", "autoClose", "reveal"].every((field) => settingsSource.includes("[\"" + field + "\", \"settings." + field)), true);
check("both dictionaries label every switch", [
	"settings.nav", "settings.title", "settings.subtitle", "settings.behaviour",
	"settings.newestFirst", "settings.newestFirstHint", "settings.autoOpen", "settings.autoOpenHint",
	"settings.autoClose", "settings.autoCloseHint", "settings.reveal", "settings.revealHint",
	"settings.current", "settings.short.newestFirst", "settings.short.autoOpen", "settings.short.autoClose",
	"settings.short.reveal", "settings.sep", "settings.on", "settings.off", "settings.save", "settings.saving",
	"settings.saved", "settings.reset", "settings.resetting", "settings.resetDone", "settings.storedAt",
	"settings.notStored", "settings.loading", "settings.failed", "settings.rejected", "settings.retry", "settings.note"
].every((key) => (source.split(JSON.stringify(key) + ":").length - 1) === 2), true);
check("the settings page ships its own stylesheet",
	["smgm-set", "smgm-setHead", "smgm-setCard", "smgm-setSwitch", "smgm-setTrack", "smgm-setKnob", "smgm-setState", "smgm-setBtn"]
		.every((name) => source.includes("." + name + "{")), true);
check("the switch styles its checked state",
	/input:checked\+\.smgm-setTrack\{/.test(source), true);
check("the host half serves the route",
	/const ROUTE_PATH = "\/api\/subagent-mgm";/.test(host) && /kind: "prefix"[\s\S]{0,60}?path: ROUTE_PATH/.test(host), true);
check("the host half asks for the carrier instead of requiring it",
	/ctx\.inject\(\["webServer"\]/.test(host), true);
check("the host half refuses foreign origins",
	/sec-fetch-site/.test(host) && /LOOPBACK_NAMES/.test(host), true);
check("the host half stores beside the profile",
	/process\.env\.DSH_PROFILE_DIR \|\| process\.env\.DSH_HOME/.test(host), true);
check("the host half replaces the file atomically",
	/renameSync\(temporary, file\)/.test(host), true);
check("the host half rejects a bad value instead of guessing",
	/must be true or false/.test(host) && /no settings provided/.test(host), true);
// ------------------------------------------------------------ host half (behaviour)
//
// The real route handler runs against a fake ctx and fake req/res, and the real
// store is written — only DSH_PROFILE_DIR is redirected to a temporary folder so
// a test run can never touch the operator's own switches.

const storeDir = mkdtempSync(path.join(tmpdir(), "smgm-verify-"));
process.env.DSH_PROFILE_DIR = storeDir;
const storeFile = path.join(storeDir, "subagent-mgm.json");
const { apply: applyHost, name: hostName } = await import(new URL("./index.js", import.meta.url).href);
const routes = [];

/** Mount the host half on a fake context and remember the route it registered. */
function mountHost(config) {
	applyHost({
		inject: (_keys, callback) => callback({
			effect: (operation) => operation(),
			webServer: { register: (route) => { routes.push(route); return () => {}; } }
		}),
		get: () => undefined
	}, config);
	return routes.length - 1;
}

function fakeRequest({ method = "GET", url = "/api/subagent-mgm/settings", headers = {}, body } = {}) {
	const listeners = { data: [], end: [], error: [] };
	const request = {
		method,
		url,
		headers: { host: "127.0.0.1:3080", ...headers },
		on: (event, handler) => {
			(listeners[event] ??= []).push(handler);
			return request;
		}
	};
	// The handler subscribes synchronously, then this microtask feeds the body.
	queueMicrotask(() => {
		if (body !== undefined) for (const handler of listeners.data) handler(Buffer.from(body));
		for (const handler of listeners.end) handler();
	});
	return request;
}

async function call(options = {}, index = 0) {
	let status = 0;
	let headers = null;
	let text = "";
	const response = {
		writeHead: (next, nextHeaders) => {
			status = next;
			headers = nextHeaders;
		},
		end: (chunk) => {
			text = chunk ?? "";
		}
	};
	await routes[index].handler(fakeRequest(options), response);
	const body = JSON.parse(text);
	return { status, headers, ...body, payload: body };
}

const settingsRoute = mountHost({});
check("the plugin names itself once", hostName, "subagent-mgm");
check("exactly one route is registered", routes.length, 1);
check("the route claims its own prefix", routes[settingsRoute].path, "/api/subagent-mgm");
check("the route is a prefix route", routes[settingsRoute].kind, "prefix");

const initial = await call();
check("a fresh install answers", initial.status, 200);
check("the answer is JSON", initial.headers["content-type"], "application/json; charset=utf-8");
check("the answer is never cached", initial.headers["cache-control"], "no-store");
check("every switch defaults to on",
	[initial.newestFirst, initial.autoOpen, initial.autoClose, initial.reveal].join(","), "true,true,true,true");
check("nothing is stored before the first save", Object.keys(initial.stored).length, 0);
check("the page is told where the store lives", initial.file, storeFile);

const saved = await call({
	method: "POST",
	body: JSON.stringify({ newestFirst: false, reveal: false })
});
check("a save is accepted", saved.status, 200);
check("the saved switch comes back switched off", saved.newestFirst, false);
check("the save is what the file holds", existsSync(storeFile), true);
check("only the saved switches are stored", Object.keys(saved.stored).sort().join(","), "newestFirst,reveal");
check("an untouched switch keeps its default", saved.autoClose, true);

const reopened = await call();
check("a reload reads the saved switch", reopened.newestFirst, false);
check("a reload keeps the stored set", Object.keys(reopened.stored).sort().join(","), "newestFirst,reveal");

const badValue = await call({ method: "POST", body: JSON.stringify({ autoOpen: "maybe" }) });
check("a bad value is refused", badValue.status, 400);
check("the refusal names the field", badValue.payload.error, "autoOpen must be true or false");
check("a refusal writes nothing", (await call()).autoOpen, true);

const untouched = await call({ method: "POST", body: JSON.stringify({}) });
check("a save that touches nothing is refused", untouched.status, 400);
check("the empty save says so", untouched.payload.error, "no settings provided");

const unreadable = await call({ method: "POST", body: "not json" });
check("an unreadable body saves nothing", unreadable.payload.error, "no settings provided");

const cleared = await call({ method: "DELETE" });
check("restoring defaults drops the file", existsSync(storeFile), false);
check("restoring defaults reports the defaults", cleared.newestFirst, true);

check("another sub-path is not ours", (await call({ url: "/api/subagent-mgm/other" })).status, 404);
check("an unowned method is refused", (await call({ method: "PUT" })).status, 405);
check("a cross-site request is refused", (await call({ headers: { "sec-fetch-site": "cross-site" } })).status, 403);
check("a foreign Host is refused", (await call({ headers: { host: "evil.example" } })).status, 403);
check("a foreign Origin is refused", (await call({ headers: { origin: "http://evil.example" } })).status, 403);
check("a foreign Referer is refused", (await call({ headers: { referer: "http://evil.example/steal" } })).status, 403);
check("the browser's own origin is admitted",
	(await call({ headers: { origin: "http://127.0.0.1:3080", referer: "http://127.0.0.1:3080/" } })).status, 200);
check("https on the same authority is not the same authority",
	(await call({ headers: { origin: "https://127.0.0.1:3080" } })).status, 403);

// A second mount carrying row Config proves the precedence chain.
const configuredRoute = mountHost({ newestFirst: true, autoOpen: false });
check("row Config is used when nothing is stored", (await call({}, configuredRoute)).autoOpen, false);
check("a field the row omits keeps the built-in default", (await call({}, configuredRoute)).autoClose, true);
check("row Config is reported as such",
	Object.keys((await call({}, configuredRoute)).configured).sort().join(","), "autoOpen,newestFirst");

await call({ method: "POST", body: JSON.stringify({ autoOpen: true }) });
check("a stored switch outranks the row Config", (await call({}, configuredRoute)).autoOpen, true);

rmSync(storeDir, { recursive: true, force: true });
if (failures.length > 0) {
	console.error("\nFAILED:\n" + failures.join("\n"));
	process.exit(1);
}
console.log(`\nall ${passed} checks passed`);