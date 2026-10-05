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
 *    second tab, and a panel whose subagent ends while its session is off screen
 *    is closed anyway;
 *
 * 3. static wiring checks for the lineage half: the sibling switcher, its
 *    shadowing priority over the shipped breadcrumb, and the branch refresh;
 * 4. the Settings page: the three switches gate the panel reconciler, the page
 *    is wired into the settings slot, and the host half serves its route;
 * 5. the host half behaviourally: the real route handler answers GET, POST and
 *    DELETE, refuses a bad value, a foreign origin and an unowned method, and
 *    resolves precedence as saved file, then row Config, then built-in default;
 * 6. static wiring checks for the capability face: the row button that opens it,
 *    the widening menu that renders it, and the fact that the client half asks
 *    the host instead of trying to read a log it cannot reach;
 * 7. the face route behaviourally, against fake durable logs: the delegation it
 *    records, the last request's tools, the skills an optional catalogue reports,
 *    and the three ways a persona can be known — recorded by the delegation,
 *    recovered from the system prompt, or not recoverable at all;
 * 8. the totals and filter behaviourally, over a fake catalog: text, state and
 *    mode each narrow the loaded rows, an ancestor survives through a matching
 *    descendant, a cycle cannot loop, and the model groups come out largest
 *    first;
 * 9. static wiring checks for the head above the tree, and for the model batch
 *    the client asks for on demand because a model lives only in a session log;
 * 10. the models route behaviourally: one read per named id, the batch cap, and
 *    an id whose own log is missing or unreadable answering for itself.
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

// -------------------------------------------- a subagent that ends off screen
//
// Reported case: the panel was opened for a child of the session on screen, the
// user then switched to another session, and the child ended while it was away.
// The tab inventory spans saved and adopted sessions, so that panel has to be
// closed without its session ever coming back on screen — otherwise selecting
// that session shows a finished chat again.

settingsState.set({ newestFirst: true, autoOpen: true, autoClose: true, reveal: true });
const OFF_PARENT = "off-screen-parent";
const OFF_CHILD = "off-screen-child";
const offMounted = observable(OFF_PARENT);
const offPanels = observable([]);
const offSessions = observable({
	projectionsBySession: {
		[OFF_PARENT]: { state: "idle", values: { subagentCatalog: [{ id: OFF_CHILD, mode: "continuable", createdAt: 1 }] } }
	},
	byId: {}
});
const offStatus = observable(new Map());
const offCalls = { open: [], close: [] };
const offSidebar = {
	mounted: offMounted,
	openTabs: offPanels,
	openResourceIn(sessionId, address, options) {
		offCalls.open.push(address);
		options.kind;
		if (offPanels.getSnapshot().some((tab) => tab.contentId === address && tab.kind === "subagentchat")) return;
		offPanels.set([...offPanels.getSnapshot(), {
			sessionId,
			tabId: `off-tab-${offCalls.open.length}`,
			kind: "subagentchat",
			contentId: address
		}]);
	},
	closeIn(sessionId, tabId) {
		offCalls.close.push(tabId);
		offPanels.set(offPanels.getSnapshot().filter((tab) => !(tab.sessionId === sessionId && tab.tabId === tabId)));
	}
};
const offCtx = {
	sidebarRight: offSidebar,
	sessions: { list: offSessions, refreshProjections: () => Promise.resolve() },
	uiSession: { sessionStatus: offStatus }
};
const offRunning = async (childSessionId, running) => {
	const next = new Map(offStatus.getSnapshot());
	next.set(childSessionId, { running });
	offStatus.set(next);
	await flush();
};
const offOpen = () => offPanels.getSnapshot().filter((tab) => tab.kind === "subagentchat").length;

const disposeOff = startSubagentPanels(offCtx);
await flush();
await offRunning(OFF_CHILD, true);
check("off screen: a running child of the selected session still opens", offOpen(), 1);

offMounted.set("another-session");
await flush();
await offRunning(OFF_CHILD, false);
check("a child that ends in the background gives up its panel", offOpen(), 0);
check("that close is issued against the background session", offCalls.close, ["off-tab-1"]);

offMounted.set(OFF_PARENT);
await flush();
check("returning to that session finds no finished chat", offOpen(), 0);

// The same pass must leave a panel the user opened by hand for an already
// finished child alone: that child was never seen running.
offPanels.set([{
	sessionId: OFF_PARENT,
	tabId: "off-user",
	kind: "subagentchat",
	contentId: helpers.chatAddress(OFF_PARENT, "finished-child", "one-shot")
}]);
await flush();
check("a hand opened panel for a finished child is left alone", offOpen(), 1);

// No session on screen at all (the settings page): a child that ends there must
// still give up its panel, while the hand opened one stays.
await offRunning(OFF_CHILD, true);
check("off screen: the running child's panel is opened again", offOpen(), 2);
offMounted.set(undefined);
await flush();
await offRunning(OFF_CHILD, false);
check("a child that ends with no session on screen still gives up its panel", offCalls.close, ["off-tab-1", "off-tab-2"]);
check("the hand opened panel outlives that close", offOpen(), 1);

// The closing pass has to run before the on-screen session is consulted, and a
// session switch must not drop the run state it depends on.
const mountBranch = source.slice(source.indexOf("if (mounted !== current) {"), source.indexOf("// Closing comes first"));
check("the reconciler closes before it asks which session is on screen",
	/for \(const tab of readChatPanels\(\)\) \{[\s\S]*?sidebar\.closeIn\(tab\.sessionId, tab\.tabId\);[\s\S]*?if \(current === undefined\) return;/.test(source), true);
check("a session switch keeps the run state and rebinds only the focus record",
	mountBranch.includes("handled.clear()") &&
		!mountBranch.includes("wasRunning.clear()") && !mountBranch.includes("seen.clear()"), true);
disposeOff();
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
	/const ordered = settings\.newestFirst \? sortNewestFirst\(entries\) : entries;\n\t+const rows = filtering/.test(source), true);
check("the dropdown honours the order switch",
	/const entries = settings\.newestFirst \? sortNewestFirst\(catalogEntries\) : catalogEntries;/.test(drop), true);
check("the panel keeper honours the auto-close switch",
	/if \(settings\.autoClose && wasRunning\.has\(child\)\) \{/.test(source), true);
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
// ---------------------------------------------------- capability face (static)
//
// The face is a React panel fed by one read-only host route, so it is checked
// structurally against the real source: the browser may only render what the
// host derives, because a subagent's tools and persona live in that subagent's
// own durable log, which the client half cannot read.

const faceSource = source.slice(
	source.indexOf("//#region capability face"),
	source.indexOf("//#region catalog trigger")
);
const faceApi = new Function(literal("FACE_ROUTE") + "\nreturn FACE_ROUTE;")();

check("the face route is the plugin's own sub-path", faceApi, "/api/subagent-mgm/face");
check("the face asks the host by session id",
	/fetch\(`\$\{FACE_ROUTE\}\?\$\{parameters\.toString\(\)\}`/.test(faceSource), true);
check("the face passes the open session as the parent hint",
	/parameters\.set\("parent", parentSessionId\)/.test(faceSource), true);
check("the face is opened from the catalog row",
	/className: "smgm-faceButton",[\s\S]{0,240}?inspectFace\(entry\.id, label, activity === "running"\)/.test(source), true);
check("the face button names itself in both languages",
	/t\("face\.open\.aria", \{ label \}\)/.test(source), true);
check("opening a face does not open the subagent",
	/event\.preventDefault\(\);\n\t+event\.stopPropagation\(\);\n\t+inspectFace\(entry\.id, label, activity === "running"\);/.test(source), true);
check("the dropdown widens while a face is open",
	/const width = Math\.min\(face === undefined \? MENU_WIDTH : MENU_WIDTH_WIDE/.test(drop), true);
check("the menu body becomes the face, not the tree",
	/face !== undefined\n\t+\? h\("div", \{[\s\S]{0,240}?role: "dialog"/.test(drop), true);
check("the tree comes back when the face closes",
	/h\(CatalogRows, \{[\s\S]{0,400}?inspectFace,/.test(drop), true);
check("closing the menu forgets the face",
	/setExpanded\(new Set\(\)\);\n\t+setFace\(undefined\);/.test(drop), true);
check("Escape in a face steps back to the tree",
	/const onFaceKeyDown = useCallback\(\(event\) => \{[\s\S]{0,160}?setFace\(undefined\);/.test(drop), true);
check("the face retries a failed load",
	/setAttempt\(\(current\) => current \+ 1\)/.test(faceSource), true);
check("a wide parameter schema cannot flood the panel",
	/text\.length > 4000 \? `\$\{text\.slice\(0, 4000\)\}\\n…` : text/.test(faceSource), true);
check("the face reads no log itself", /readSession/.test(source), false);
check("the face stylesheet ships with the client half",
	["smgm-face", "smgm-faceButton", "smgm-faceHead", "smgm-faceGrid", "smgm-faceItem",
		"smgm-faceParams", "smgm-facePre", "smgm-faceError", "smgm-faceEmpty", "smgm-faceFilter"]
		.every((name) => source.includes("." + name + "{")), true);
check("the wide menu stylesheet ships too",
	/\.smgm-menu\.smgm-menuWide\{/.test(source), true);
check("both dictionaries translate the face", [
	"face.open", "face.open.aria", "face.title", "face.back", "face.loading", "face.failed",
	"face.section.profile", "face.section.tools", "face.section.skills", "face.section.persona",
	"face.mode", "face.state", "face.launch", "face.preset", "face.model", "face.delegatedModel",
	"face.cwd", "face.depth", "face.created", "face.parent", "face.filter", "face.filter.allow",
	"face.filter.deny", "face.tools.count", "face.tools.source", "face.tools.empty", "face.tools.params",
	"face.tools.deferred", "face.skills.count", "face.skills.empty", "face.skills.unavailable",
	"face.skills.failed", "face.skills.agentOnly", "face.persona.recorded", "face.persona.inferred",
	"face.persona.generated", "face.persona.generatedNote", "face.persona.replaced", "face.persona.empty"
].every((key) => (source.split(JSON.stringify(key) + ":").length - 1) === 2), true);
check("both counts are filled in at render time",
	/t\("face\.tools\.count", \{ count: tools\.length \}\)/.test(faceSource)
	&& /t\("face\.skills\.count", \{ count: skillEntries\.length \}\)/.test(faceSource), true);
check("an unusable skill list says which way it failed",
	/t\("face\.skills\.unavailable"\)/.test(faceSource)
	&& /t\("face\.skills\.failed", \{ error: skills\.error \?\? "" \}\)/.test(faceSource), true);
check("an inferred persona is labelled as inferred",
	/persona\?\.source === "descriptor"\n\t+\? "face\.persona\.recorded"\n\t+\t*: persona\?\.generated === true \? "face\.persona\.generated" : "face\.persona\.inferred"/.test(faceSource), true);
check("a generated persona says so instead of hiding it",
	/persona\.generated === true \? h\("span", \{ className: "smgm-faceNote" \}, t\("face\.persona\.generatedNote"\)\) : null/.test(faceSource), true);
check("the persona it replaced is shown beside it",
	/persona\.replaced === null \|\| persona\.replaced === undefined/.test(faceSource)
	&& /t\("face\.persona\.replaced"\)/.test(faceSource), true);
check("a skill that only a human invokes is flagged",
	/entry\.modelInvocable === true \? null : h\("span", \{ className: "smgm-faceItemFlag" \}/.test(faceSource), true);

// -------------------------------------------------- totals and filter (static)
//
// The filter and the totals strip are pure client behaviour over data the client
// already holds: they narrow and sum the rows a branch has loaded and never read
// a log. The one thing the client cannot know — the model a subagent ran on —
// is asked of the batch route on demand, because a model is named only inside
// that subagent's own durable log.

const totalsSource = source.slice(
	source.indexOf("//#region filter and totals"),
	source.indexOf("//#region capability face")
);
const totalsApi = new Function(
	extract("tokenTotal") + "\n" + extract("billedInputTokens") + "\n" + extract("cacheHitPercent") + "\n" +
	extract("activityDuration") + "\n" + extract("catalogOf") + "\n" +
	extract("activityOf") + "\n" + extract("filterActive") + "\n" + extract("entryMatches") + "\n" +
	extract("subtreeMatches") + "\n" + extract("catalogTotals") + "\n" + extract("modelOf") + "\n" +
	extract("groupModels") +
	"\nreturn { filterActive, entryMatches, subtreeMatches, catalogTotals, modelOf, groupModels, billedInputTokens, cacheHitPercent };"
)();
const modelsLiteral = new Function(literal("MODELS_ROUTE") + "\nreturn MODELS_ROUTE;")();

check("the totals head is its own region", totalsSource.includes("function CatalogControls({ t, filter, onChange })")
	&& totalsSource.includes("function CatalogSummary({ t, totals, nodes, models, modelState, onFetchModels })"), true);
check("the head sits above the tree in the menu",
	drop.indexOf("smgm-head") > -1 && drop.indexOf("smgm-head") < drop.indexOf("smgm-tree"), true);
check("the tree keeps its tree role under the head",
	/className: "smgm-tree",\n\t+role: "tree"/.test(drop), true);
check("a filter forces open whatever it matched",
	/const isExpanded = expanded\.has\(entry\.id\) \|\| filtering;/.test(source), true);
check("a filtered row cannot collapse a branch by keyboard",
	/if \(knownLeaf \|\| filtering\) return;/.test(source), true);
check("the disclosure stops being a control while filtering",
	/filtering\n\t+\? h\("span", \{ className: "smgm-disclosure smgm-disclosureOpen" \}, h\(Chevron, \{\}\)\)/.test(source), true);
check("the filter is carried down the recursion",
	/closeCatalog,\n\t+inspectFace,\n\t+filter,/.test(source), true);
check("the dropdown hands the filter over only while it is in force",
	/filter: filtering \? filter : undefined,/.test(drop), true);
check("an empty filtered tree says so", /"smgm-filterEmpty" \}, t\("filter\.empty"\)\)/.test(source), true);
check("the model batch is asked for, never watched",
	/const fetchModels = useCallback/.test(drop) && !/useEffect\([\s\S]{0,240}?MODELS_ROUTE/.test(drop), true);
check("the batch names every counted row",
	/\[\.\.\.new Set\(totals\.nodes\.map\(\(node\) => node\.id\)\)\]/.test(drop), true);
check("the route is the host's own sub-path", modelsLiteral, "/api/subagent-mgm/models");
check("the client reads the batch's entries", /payload\.entries \?\? \[\]/.test(drop), true);
check("a failure is reported, not thrown",
	/setModelState\("error"\);/.test(drop) && /console\.warn\("\[subagent-mgm\] could not read the models"/.test(drop), true);
check("the panel head cannot scroll away",
	/\.smgm-head\{[^}]*position:sticky/.test(source), true);
check("the head, filter and totals stylesheet ships with the client half",
	["smgm-head", "smgm-controls", "smgm-search", "smgm-chips", "smgm-chip", "smgm-chipOn", "smgm-chipClear",
		"smgm-totals", "smgm-totalsItem", "smgm-summaryHint", "smgm-modelHead", "smgm-models", "smgm-modelRow",
		"smgm-modelName", "smgm-modelError", "smgm-filterEmpty"]
		.every((name) => source.includes("." + name + "{")), true);
check("the tree indents through its own container, not the scrolling body",
	source.includes(".smgm-tree>.smgm-node{" ) && !source.includes(".smgm-menuBody>.smgm-node{"), true);
check("both dictionaries translate the filter, the totals and the hover card", [
	"controls.placeholder", "controls.searchAria", "controls.clear", "filter.all", "filter.inactive",
	"filter.oneShot", "filter.empty", "totals.loaded", "totals.running", "totals.tokens", "totals.duration",
	"totals.none", "totals.partial", "totals.tokensWithSelf", "totals.selfTitle", "models.fetch", "models.refetch", "models.hint", "models.loading",
	"models.failed", "models.empty", "models.unknown", "models.unknownNote", "models.delegated", "models.times",
	"cache.percent", "cache.exactTitle", "cache.stripTitle", "tokens.exactTitle", "tokens.cacheTitle", "hover.more",
	"hover.selfTokens", "hover.workTime", "hover.workTitle"
].every((key) => (source.split(JSON.stringify(key) + ":").length - 1) === 2), true);
check("the cache share has its own helper pair",
	/function billedInputTokens\(usage\)/.test(source) && /function cacheHitPercent\(cacheReadTokens, promptTokens\)/.test(source), true);
check("the strip states the share of what was billed",
	/cacheHitPercent\(totals\.cacheRead, totals\.billedInput\)/.test(totalsSource)
	&& /t\("cache\.percent", \{ percent: cacheHit \}\)/.test(totalsSource), true);
check("each model group carries its own share",
	/cacheHitPercent\(group\.cacheRead, group\.billedInput\)/.test(totalsSource), true);
check("a row's token metric explains its share on hover",
	/t\("tokens\.cacheTitle", \{ value: formatExactTokens\(totalTokens\), percent: rowCacheHit \}\)/.test(source), true);
check("counts and usage are separate lines, so neither reflows the other",
	/className: "smgm-totals" \},\n\t+h\("span", \{ className: "smgm-totalsItem" \}, t\("totals\.loaded", \{ count: totals\.count \}\)\),\n\t+totals\.running === 0 \? null : h\("span", \{ className: "smgm-totalsItem" \}, t\("totals\.running"/.test(totalsSource)
	&& /className: "smgm-totals" \},\n\t+totalsItem,\n\t+cacheItem,\n\t+h\("span", \{ className: "smgm-totalsItem", title: formatExactDuration/.test(totalsSource), true);
check("a row without usage is counted with the other counts",
	/partial\),\n\t+h\("div", \{ className: "smgm-totals" \},\n\t+totalsItem,/.test(totalsSource), true);
check("a model row may wrap rather than overflow the narrow menu",
	/\.smgm-modelRow\{[^}]*flex-wrap:wrap/.test(source), true);

// The catalog the filter and the totals are exercised against: one running parent
// with a nested one-shot child, one finished child with no nested branch, one
// finished child with no projections at all, and a branch that points back at
// its own ancestor.
const usage = (input, output, cacheRead, cacheWrite) => ({
	uncachedInputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite
});
const catalogView = (entries) => ({ state: "ready", error: null, values: { subagentCatalog: entries } });
const filterProjections = {
	"session-tree": catalogView([
		{ id: "session-alpha", label: "Alpha", mode: "continuable" },
		{ id: "session-beta", label: "Beta", mode: "one-shot" },
		{ id: "session-gamma", label: "Gamma", mode: "continuable" }
	]),
	"session-alpha": catalogView([{ id: "session-delta", label: "Deep beta", mode: "one-shot" }]),
	"session-beta": catalogView([]),
	"session-cycle": catalogView([{ id: "session-cycler", label: "Cycle", mode: "continuable" }]),
	"session-cycler": catalogView([{ id: "session-cycle", label: "Back", mode: "continuable" }])
};
const filterSummaries = {
	// The session the tree hangs off: never a row of its own catalog, but its own
	// usage is spent in the same place, so the totals fold it in as well.
	"session-tree": {
		title: "This conversation", cwd: "D:\\dsh", running: true,
		projectionValues: { tokenUsage: usage(200, 100, 300, 20) }
	},
	"session-alpha": {
		title: "First child", cwd: "D:\\dsh\\one", running: true,
		projectionValues: {
			tokenUsage: usage(100, 50, 10, 0),
			subagentTiming: { settledMs: 1000, active: { since: 4000 } }
		}
	},
	"session-beta": {
		title: "Second child", cwd: "D:\\dsh\\two", running: false,
		projectionValues: {
			tokenUsage: usage(7, 3, 0, 0),
			subagentTiming: { settledMs: 2000, active: { since: 1000, through: 1500 } }
		}
	},
	"session-gamma": { title: "Third child", running: false },
	"session-delta": {
		title: "Fourth child", running: false,
		projectionValues: { tokenUsage: usage(1, 0, 0, 0), subagentTiming: { settledMs: 500 } }
	}
};
const filterStatuses = new Map([["session-alpha", { running: true }]]);
const treeView = { state: "ready", error: null, entries: filterProjections["session-tree"].values.subagentCatalog };
const totalsOf = (filter, view = treeView, now = 6000) =>
	totalsApi.catalogTotals(view, filter, filterProjections, filterSummaries, filterStatuses, now);
const totalsWithSelf = (filter, selfId = "session-tree", view = treeView, now = 6000) =>
	totalsApi.catalogTotals(view, filter, filterProjections, filterSummaries, filterStatuses, now, selfId);
const shape = (result) => [result.count, result.running, result.tokens, result.durationMs,
	result.unknownTokens, result.unknownDuration].join(",");

check("an unfiltered tree totals every loaded row",
	shape(totalsOf(undefined)), "4,1,171,6000,1,1");
check("the rows it counted are named", totalsOf(undefined).nodes.map((node) => node.id).join(","),
	"session-alpha,session-delta,session-beta,session-gamma");
check("a running row is counted as running, not as a row without timing",
	[totalsOf(undefined).nodes[0].running, totalsOf(undefined).tokens].join("|"), "true|171");
check("text narrows by name, title and working directory", [
	shape(totalsOf({ text: "two", activity: "all", oneShot: false })),
	shape(totalsOf({ text: "third", activity: "all", oneShot: false })),
	shape(totalsOf({ text: "alpha", activity: "all", oneShot: false }))
].join(" "), "1,0,10,2500,0,0 1,0,0,0,1,1 1,1,160,3000,0,0");
check("a match is case-insensitive", shape(totalsOf({ text: "SECOND", activity: "all", oneShot: false })), "1,0,10,2500,0,0");
check("an ancestor survives through a matching descendant",
	totalsOf({ text: "deep", activity: "all", oneShot: false }).nodes.map((node) => node.id).join(","),
	"session-alpha,session-delta");
check("a survived ancestor still contributes its own tokens",
	shape(totalsOf({ text: "deep", activity: "all", oneShot: false })), "2,1,161,3500,0,0");
check("a state filter keeps the running branch it names",
	shape(totalsOf({ text: "", activity: "running", oneShot: false })), "1,1,160,3000,0,0");
// An ancestor kept only to hold a match is still counted: the strip describes the
// rows on screen, which is why a finished filter can still report a running row.
check("a parent shown only for its child is still counted",
	shape(totalsOf({ text: "", activity: "inactive", oneShot: false })), "4,1,171,6000,1,1");
check("the one-shot switch keeps one-shot rows and their parents",
	shape(totalsOf({ text: "", activity: "all", oneShot: true })), "3,1,171,6000,0,0");
check("nothing matching totals nothing", shape(totalsOf({ text: "zzz", activity: "all", oneShot: false })), "0,0,0,0,0,0");
check("a row without usage is unknown, never zero",
	[totalsOf(undefined).unknownTokens, totalsOf(undefined).tokens].join("|"), "1|171");
check("a branch that points back at its ancestor cannot loop",
	shape(totalsOf(undefined, { state: "ready", entries: filterProjections["session-cycle"].values.subagentCatalog })),
	"2,0,0,0,2,2");
check("a row listed twice under one parent is counted once",
	shape(totalsOf(undefined, { state: "ready", entries: [
		{ id: "session-beta", label: "Beta", mode: "one-shot" },
		{ id: "session-beta", label: "Beta again", mode: "one-shot" }
	] })), "1,0,10,2500,0,0");
check("a filter that names nothing is not in force",
	[totalsApi.filterActive({ text: "", activity: "all", oneShot: false }),
		totalsApi.filterActive({ text: "x", activity: "all", oneShot: false }),
		totalsApi.filterActive({ text: "", activity: "inactive", oneShot: false }),
		totalsApi.filterActive({ text: "", activity: "all", oneShot: true })].join(","), "false,true,true,true");

const named = (answer) => {
	const model = totalsApi.modelOf(answer);
	return model === null ? "none" : [model.key, model.name, model.delegated].join("|");
};
check("the model the run used names the row",
	named({ state: "ok", provider: "qwen", model: "deepseek-v4.1-flash", agentProvider: "other", agentModel: "spawned" }),
	"qwen/deepseek-v4.1-flash|deepseek-v4.1-flash|false");
check("a row with no run falls back to the model the delegation named",
	named({ state: "ok", provider: null, model: null, agentProvider: "qwen", agentModel: "spawned" }),
	"qwen/spawned|spawned|true");
check("an unreadable or missing row has no model",
	[named({ state: "missing" }), named({ state: "error" }), named(undefined), named({ state: "ok" })].join(","),
	"none,none,none,none");

const grouped = totalsApi.groupModels([
	{ id: "a", tokens: 30, running: false },
	{ id: "b", tokens: 10, running: true },
	{ id: "c", tokens: 5, running: false },
	{ id: "d", tokens: 7, running: false }
], new Map([
	["a", { state: "ok", provider: "qwen", model: "big" }],
	["b", { state: "ok", provider: "qwen", model: "big" }],
	["c", { state: "ok", provider: null, model: null, agentProvider: "qwen", agentModel: "spawned" }]
]));
check("rows group by the model behind them, largest first",
	grouped.groups.map((group) => [group.model?.name ?? "unknown", group.model?.delegated ?? false,
		group.count, group.tokens, group.running].join(":")).join(","),
	"big:false:2:40:1,unknown:false:1:7:0,spawned:true:1:5:0");
check("a row the batch never answered for is reported, not invented",
	[grouped.groups.find((group) => group.model === null).tokens, grouped.unanswered].join("|"), "7|1");

// Cache-hit share: the cheap half of prompt-side billing over all of it. Summing
// the buckets and taking one ratio — instead of averaging per-row ratios — is what
// makes a tree total mean what a single log's own share means.
const cacheOf = (result) => [result.cacheRead, result.billedInput,
	String(totalsApi.cacheHitPercent(result.cacheRead, result.billedInput))].join("|");
check("the cache share counts only what was billed",
	[String(totalsApi.cacheHitPercent(10, 10)), String(totalsApi.cacheHitPercent(0, 0)),
		String(totalsApi.cacheHitPercent(3, undefined)), String(totalsApi.cacheHitPercent(3, 0))].join(","),
	"100,null,null,null");
check("a partial hit never rounds up to a full one",
	[String(totalsApi.cacheHitPercent(9999, 10000)), String(totalsApi.cacheHitPercent(196, 200)),
		String(totalsApi.cacheHitPercent(9, 10))].join(","), "99.99,98,90");
check("output tokens are not prompt-side input",
	[String(totalsApi.billedInputTokens(usage(50, 9999, 25, 25))),
		String(totalsApi.cacheHitPercent(25, totalsApi.billedInputTokens(usage(50, 9999, 25, 25))))].join("|"), "100|25");
check("a row with no usage adds no denominator",
	[String(totalsApi.billedInputTokens(undefined)), String(totalsApi.billedInputTokens({}))].join("|"), "undefined|0");
check("the strip folds every counted row's buckets",
	cacheOf(totalsOf(undefined)), "10|118|8");
check("the share follows the filter",
	cacheOf(totalsOf({ text: "alpha", activity: "all", oneShot: false })), "10|110|9");
check("a filter whose rows never billed has no share to state",
	cacheOf(totalsOf({ text: "third", activity: "all", oneShot: false })), "0|0|null");

const groupedCache = totalsApi.groupModels([
	{ id: "a", tokens: 30, running: false, cacheRead: 90, billedInput: 100 },
	{ id: "b", tokens: 10, running: true, cacheRead: 10, billedInput: 100 },
	{ id: "c", tokens: 5, running: false }
], new Map([
	["a", { state: "ok", provider: "qwen", model: "big" }],
	["b", { state: "ok", provider: "qwen", model: "big" }],
	["c", { state: "ok", provider: null, model: null, agentProvider: "qwen", agentModel: "spawned" }]
]));
const bigGroup = groupedCache.groups.find((group) => group.model?.name === "big");
const spawnedGroup = groupedCache.groups.find((group) => group.model?.name === "spawned");
check("a model group folds its rows' buckets before taking a share",
	[bigGroup.count, bigGroup.cacheRead, bigGroup.billedInput,
		totalsApi.cacheHitPercent(bigGroup.cacheRead, bigGroup.billedInput)].join("|"), "2|100|200|50");
check("a group whose rows never billed states no share",
	[spawnedGroup.cacheRead, spawnedGroup.billedInput,
		String(totalsApi.cacheHitPercent(spawnedGroup.cacheRead, spawnedGroup.billedInput))].join("|"), "0|0|null");

// The session you are looking at spends its own tokens in the same conversation
// as its children, so the totals fold it in — named beside them, never as a row.
check("the session this tree hangs off is counted in the totals",
	shape(totalsWithSelf(undefined)), "4,1,791,6000,1,2");
check("it is named as itself, ahead of the rows",
	[totalsWithSelf(undefined).nodes.map((node) => node.id).join(","), totalsWithSelf(undefined).self.id].join(" "),
	"session-tree,session-alpha,session-delta,session-beta,session-gamma session-tree");
check("its buckets reach the share like any row's",
	cacheOf(totalsWithSelf(undefined)), "310|638|49");
check("the same filter rule decides whether it counts", [
	shape(totalsWithSelf({ text: "conversation", activity: "all", oneShot: false })),
	(totalsWithSelf({ text: "conversation", activity: "all", oneShot: false }).self === null),
	shape(totalsWithSelf({ text: "third", activity: "all", oneShot: false })),
	(totalsWithSelf({ text: "third", activity: "all", oneShot: false }).self === null)
].join("|"), "0,0,620,0,0,1|false|1,0,0,0,1,1|true");
check("a state filter keeps it only while it still matches", [
	shape(totalsWithSelf({ text: "", activity: "inactive", oneShot: false })),
	(totalsWithSelf({ text: "", activity: "inactive", oneShot: false }).self === null),
	shape(totalsWithSelf({ text: "", activity: "running", oneShot: false })),
	(totalsWithSelf({ text: "", activity: "running", oneShot: false }).self === null)
].join("|"), "4,1,171,6000,1,1|true|1,1,780,3000,0,1|false");
check("the one-shot switch does not turn it into a delegation", [
	shape(totalsWithSelf({ text: "", activity: "all", oneShot: true })),
	(totalsWithSelf({ text: "", activity: "all", oneShot: true }).self === null)
].join("|"), "3,1,171,6000,0,0|true");

// Static half of the same rule: the session has to go through the arithmetic the
// rows go through, so changing one of them cannot leave the other behind.
check("the session is folded in by the rows' own arithmetic",
	/const account = \(id, activity, asRow\) =>/.test(source)
	&& /totals\.nodes\.push\(account\(entry\.id, activityOf\(entry\.id, summaries, statuses\), true\)\)/.test(source)
	&& /totals\.self = account\(selfId, activityOf\(selfId, summaries, statuses\), false\)/.test(source), true);
check("the rows' filter decides the session too, so the two cannot disagree",
	/entryMatches\(\{ id: selfId \}, filter, summaries, statuses\)/.test(source), true);
check("the session is counted once, never again as a row",
	/seen\.add\(selfId\);/.test(source), true);
check("the session's share is named inside the token item, not as a new one",
	/const totalsItem = selfShare === null\n\t+\? h\("span", \{ className: "smgm-totalsItem" \}, t\("totals\.tokens", \{ value: formatTokens\(totals\.tokens, t\) \}\)\)\n\t+: h\("span", \{ className: "smgm-totalsItem", title: selfShare \},/.test(totalsSource)
	&& /t\("totals\.tokensWithSelf", \{\n\t+value: formatTokens\(totals\.tokens, t\),\n\t+self: formatTokens\(totals\.self\.tokens, t\)/.test(totalsSource), true);
check("the hover text keeps the session's own split",
	/t\("totals\.selfTitle", \{\n\t+hit: formatExactTokens\(totals\.self\.cacheRead\),\n\t+written: formatExactTokens\(totals\.self\.cacheWrite\),\n\t+prompt: formatExactTokens\(totals\.self\.billedInput\),/.test(totalsSource), true);
check("an empty tree still states the session's own numbers",
	/if \(totals\.count === 0 && totals\.self === null\)/.test(totalsSource), true);
check("the dropdown totals the session it is showing",
	/catalogTotals\(presentedCatalog, filtering \? filter : undefined, projections, summaries, statuses, now, currentSessionId\)/.test(drop), true);

// The same digest, smaller, in a sidebar Session row's hover card. The seat hands
// over the row's Session id alone, so the card subscribes to the two client stores
// itself and asks the host for nothing: it is a read-only view of what the browser
// already holds, and the numbers are the strip's numbers with no filter.
const hoverSource = source.slice(
	source.indexOf("function SessionRowHover({ sessionId, useHoverStores, t })"),
	source.indexOf("function SubagentMgrLineage(")
);
check("the hover digest fills the sidebar row's own seat",
	/ctx\.slots\.inject\("sidebar\.session\.row\.hover"/.test(source)
	&& /id: "subagent-digest",/.test(source) && /order: 5,/.test(source), true);
check("the seat's occupant is handed the store subscription and the translator",
	/h\(SessionRowHover, \{ \.\.\.props, useHoverStores, t \}\)/.test(source), true);
check("the card subscribes to the two stores it reads, and nothing else",
	/scope\.sessions\.list\.subscribe\(update\)/.test(source)
	&& /scope\.uiSession\.sessionStatus\.subscribe\(update\)/.test(source)
	&& /const stops = \[/.test(source), true);
check("the card asks the host for nothing and reads no log",
	/[^a-zA-Z]fetch\(/.test(hoverSource) === false && /readSession/.test(hoverSource) === false
	&& /MODELS_ROUTE/.test(hoverSource) === false, true);
check("the card's numbers are the strip's numbers, session included",
	/catalogTotals\(catalog, undefined, stores\.projections, stores\.summaries, stores\.statuses, now, sessionId\)/.test(hoverSource), true);
check("a row with no subagents reports the session's own usage instead",
	/if \(totals\.count === 0\) \{/.test(hoverSource)
	&& /selfSummary\?\.projectionValues\?\.sessionStats/.test(hoverSource)
	&& /t\("hover\.selfTokens", \{ value: formatTokens\(selfTokens, t\) \}\)/.test(hoverSource)
	&& /t\("hover\.workTime", \{ duration: formatDuration\(work\.ms, t\) \}\)/.test(hoverSource)
	&& /title: t\("hover\.workTitle", \{[\s\S]{0,240}?turns: work\.turns,\n\t+steps: work\.steps/.test(hoverSource), true);
check("a session with nothing recorded stays silent rather than reporting zeros",
	/\(selfTokens === undefined \|\| selfTokens === 0\) && cacheHit === null && \(work === null \|\| work\.ms === 0\)\) return null;/.test(hoverSource)
	&& /work === null \|\| work\.ms === 0 \? null/.test(hoverSource)
	&& /selfTokens === undefined \|\| selfTokens === 0 \? null/.test(hoverSource), true);
check("the card lists a few rows and counts the rest",
	/const HOVER_ROWS = 4;/.test(source) && /listed\.slice\(0, HOVER_ROWS\)/.test(hoverSource)
	&& /t\("hover\.more", \{ count: hidden \}\)/.test(hoverSource), true);
check("the card follows the same order switch as the catalog",
	/settings\.newestFirst \? sortNewestFirst\(entries\) : entries/.test(hoverSource), true);
check("the card says a row's state the way the catalog does",
	/h\(StateDot, \{ state: activity === "running" \? "ongoing" : completed \? "done" : "idle", size: 12 \}\)/.test(hoverSource), true);
check("the card's totals name the session's own share like the strip",
	/title: t\("totals\.selfTitle", \{[\s\S]{0,200}?totals\.self\.cacheWrite\)/.test(hoverSource)
	&& /t\("totals\.tokensWithSelf", \{\n\t+value: formatTokens\(totals\.tokens, t\),\n\t+self: formatTokens\(totals\.self\.tokens, t\)/.test(hoverSource), true);
check("a row's share is explained on hover and never invented",
	/t\("cache\.percent", \{ percent: hit \}\)/.test(hoverSource)
	&& /hit === null \? null : h\("span", \{\n\t+className: "smgm-digestNote",/.test(hoverSource), true);
check("the hover card stylesheet ships with the client half",
	["smgm-digest", "smgm-digestLine", "smgm-digestRows", "smgm-digestRow", "smgm-digestName",
		"smgm-digestValue", "smgm-digestNote"].every((name) => source.includes("." + name + "{")), true);
check("the card wears the colours the sidebar card already uses",
	/\.smgm-digest\{[^}]*color:#adb2b8/.test(source) && /\.smgm-digestName\{[^}]*color:#cfd3d6/.test(source), true);
check("the header states the hover card as well",
	/5\. The same digest, smaller, fills a sidebar Session row's hover card/.test(source), true);
check("the header states the instant hover card too",
	/6\. Those cards open without the shipped 800ms dwell/.test(source), true);
check("the instant hover card is installed once, from this bundle's own factory",
	/const INSTANT_HOVER_OPEN_MS = 0;/.test(source)
	&& /const INSTANT_HOVER_MARK = Symbol\.for\("dsh-subagent-mgm\.instantHoverTimer"\);/.test(source)
	&& /installInstantHover\(typeof window === "undefined" \? null : window, INSTANT_HOVER_OPEN_MS\)/.test(source), true);
check("the instant hover card writes to no export, only to the live timer",
	/primitives\.HoverCard|installInstantHover\(require\(/.test(source), false);
check("the install is disposable, so a reload can put the real timer back",
	/ctx\.effect\(\(\) => \{\n\t+const installed = installInstantHover\(/.test(source)
	&& /return \(\) => uninstallInstantHover\(window, installed\);/.test(source), true);

// ---------------------------------------------- session work + the instant hover
//
// Two small pieces run directly here: the `sessionStats` fold that gives a
// childless Session its working time, and the wrappers that shorten the shipped
// hover dwell and hand a card over to the next one. The primitives namespace is
// frozen by the shell, so the wrappers take the global timers instead: a fake
// window records what each `setTimeout` was handed and can fire one on demand.

const hoverOpenConst = /const HOVER_OPEN_CALLBACK = [^\n]+;/.exec(source);
if (hoverOpenConst === null) throw new Error("constant HOVER_OPEN_CALLBACK is missing from client.js");
const hoverGraceConst = /const POINTER_GRACE_CALLBACK = [^\n]+;/.exec(source);
if (hoverGraceConst === null) throw new Error("constant POINTER_GRACE_CALLBACK is missing from client.js");
const hoverApi = new Function(
	"INSTANT_HOVER_MARK",
	extract("sessionWork") + "\n" + hoverOpenConst[0] + "\n" + hoverGraceConst[0] + "\n" +
	extract("installInstantHover") + "\n" + extract("uninstallInstantHover") + "\n" +
	"return { sessionWork, installInstantHover, uninstallInstantHover };"
)(Symbol.for("dsh-subagent-mgm.instantHoverTimer"));
const hoverCalls = [];
const hoverLive = new Map();
let hoverSeq = 0;
let hoverThis = null;
const fakeWindow = {
	setTimeout: function (callback, delay, ...rest) {
		hoverThis = this;
		hoverCalls.push([callback, delay, rest]);
		hoverSeq += 1;
		hoverLive.set(hoverSeq, { callback, rest });
		return hoverSeq;
	},
	clearTimeout: function (id) {
		hoverLive.delete(id);
	}
};
const realHoverTimer = fakeWindow.setTimeout;
const realHoverClear = fakeWindow.clearTimeout;
/** Fire one armed timer the way the browser would; false once it is gone. */
function fireHoverTimer(id) {
	const timer = hoverLive.get(id);
	if (timer === undefined) return false;
	hoverLive.delete(id);
	timer.callback(...timer.rest);
	return true;
}
const hoverInstalled = hoverApi.installInstantHover(fakeWindow, 0);
check("the wrappers replace both live timers and report what they replaced",
	[hoverInstalled !== null, hoverInstalled.real === realHoverTimer, hoverInstalled.realClear === realHoverClear,
		fakeWindow.setTimeout === hoverInstalled.wrapped, fakeWindow.clearTimeout === hoverInstalled.wrappedClear,
		fakeWindow.setTimeout[Symbol.for("dsh-subagent-mgm.instantHoverTimer")] === true,
		fakeWindow.clearTimeout[Symbol.for("dsh-subagent-mgm.instantHoverTimer")] === true].join("|"),
	"true|true|true|true|true|true|true");
const openDwell = () => { setPhase("open"); };
fakeWindow.setTimeout(openDwell, 800);
check("the shipped opening dwell fires at once", [hoverCalls[0][1], hoverThis === fakeWindow].join("|"), "0|true");
const minifiedDwell = () => { D("open"); };
const spacedDwell = () => { setPhase( "open" ); };
const memberDwell = function () { this.setPhase("open"); };
fakeWindow.setTimeout(minifiedDwell, 500);
fakeWindow.setTimeout(spacedDwell, 1200);
fakeWindow.setTimeout(memberDwell, 800);
check("a minified or respaced dwell callback is still recognised",
	hoverCalls.slice(1, 4).map((call) => call[1]).join("|"), "0|0|0");
fakeWindow.setTimeout(() => { setPhase("closed"); }, 800);
fakeWindow.setTimeout(() => { show(); }, 800);
fakeWindow.setTimeout(() => { setCopied(false); }, 400);
fakeWindow.setTimeout("alert(1)", 800);
fakeWindow.setTimeout(null, 800);
fakeWindow.setTimeout(openDwell, 0);
fakeWindow.setTimeout(openDwell, undefined);
fakeWindow.setTimeout(openDwell, -5);
fakeWindow.setTimeout(openDwell, "800");
check("every other timer, and a dwell already shorter, is passed through untouched",
	hoverCalls.slice(4).map((call) => String(call[1])).join("|"), "800|800|400|800|800|0|undefined|-5|800");
fakeWindow.setTimeout(openDwell, 800, "arg", 7);
check("a forced dwell still carries the caller's extra arguments",
	[hoverCalls[13][1], hoverCalls[13][2].join(",")].join("|"), "0|arg,7");
const replacedOrder = [];
const replacedDwell = (...args) => { replacedOrder.push("open", ...args); };
const replacedFired = fireHoverTimer(fakeWindow.setTimeout(replacedDwell, 800, "arg", 7));
check("a forced dwell still runs the callback it replaced, with its arguments",
	[String(replacedFired), replacedOrder.join(",")].join("|"), "true|open,arg,7");

const closed = [];
const graceStash = { current: null };
const graceNext = { current: () => closed.push("close") };
/** The shipped grace as the served bundle writes it, and as source would read it. */
const bundledGrace = () => { graceStash.current=null,graceNext.current(); };
const writtenGrace = () => { graceStash.current = null; graceNext.current(); };
const openNext = () => closed.push("open");
closed.length = 0;
const replacedGrace = fakeWindow.setTimeout(writtenGrace, 200);
const firstFired = fireHoverTimer(fakeWindow.setTimeout(openNext, 800));
check("opening a card dismisses the card still waiting out its grace, and first",
	[String(firstFired), closed.join(","), String(hoverLive.has(replacedGrace))].join("|"), "true|close,open|false");
closed.length = 0;
fakeWindow.clearTimeout(fakeWindow.setTimeout(bundledGrace, 200));
fireHoverTimer(fakeWindow.setTimeout(openNext, 800));
check("a grace the card itself cancelled is not run behind the user's back", closed.join(","), "open");
closed.length = 0;
fireHoverTimer(fakeWindow.setTimeout(writtenGrace, 200));
fireHoverTimer(fakeWindow.setTimeout(openNext, 800));
check("a grace that already elapsed is not run a second time", closed.join(","), "close,open");
closed.length = 0;
const shapeTimers = [
	fakeWindow.setTimeout(bundledGrace, 200),
	fakeWindow.setTimeout(writtenGrace, 200),
	fakeWindow.setTimeout(function () { graceStash.current = null; graceNext(); }, 200),
	fakeWindow.setTimeout(() => { setPhase("closed"); }, 100),
	fakeWindow.setTimeout(writtenGrace, 0)
];
fireHoverTimer(fakeWindow.setTimeout(openNext, 800));
check("the shipped grace shapes are taken over, its 200ms sibling is not",
	[closed.join(","), shapeTimers.map((id) => String(hoverLive.has(id))).join(",")].join("|"),
	"close,close,open|false,false,true,true,true");
check("installing over an already wrapped timer stacks no second layer",
	[String(hoverApi.installInstantHover(fakeWindow, 0)), fakeWindow.setTimeout === hoverInstalled.wrapped,
		fakeWindow.clearTimeout === hoverInstalled.wrappedClear].join("|"), "null|true|true");
const halfWindow = { setTimeout: realHoverTimer };
const readOnlyWindow = {};
Object.defineProperty(readOnlyWindow, "setTimeout", { value: realHoverTimer, writable: false });
Object.defineProperty(readOnlyWindow, "clearTimeout", { value: realHoverClear, writable: false });
const throwingWindow = new Proxy({}, {
	get: (target, key) => (key === "setTimeout" ? realHoverTimer : key === "clearTimeout" ? realHoverClear : undefined),
	set: () => { throw new Error("this window refuses the write"); }
});
check("a target that cannot take both wrappers, or has no timer, is left alone",
	[String(hoverApi.installInstantHover(null, 0)), String(hoverApi.installInstantHover(undefined, 0)),
		String(hoverApi.installInstantHover({}, 0)), String(hoverApi.installInstantHover({ setTimeout: "x" }, 0)),
		String(hoverApi.installInstantHover(halfWindow, 0)), String(hoverApi.installInstantHover(readOnlyWindow, 0)),
		String(hoverApi.installInstantHover(throwingWindow, 0)),
		halfWindow.setTimeout === realHoverTimer, readOnlyWindow.setTimeout === realHoverTimer,
		throwingWindow.setTimeout === realHoverTimer, throwingWindow.clearTimeout === realHoverClear].join("|"),
	"null|null|null|null|null|null|null|true|true|true|true");
const tidyWindow = { setTimeout: realHoverTimer, clearTimeout: realHoverClear };
const tidyInstalled = hoverApi.installInstantHover(tidyWindow, 0);
const foreignTimer = () => 0;
const foreignClear = () => 0;
tidyWindow.setTimeout = foreignTimer;
tidyWindow.clearTimeout = foreignClear;
hoverApi.uninstallInstantHover(tidyWindow, tidyInstalled);
const restoreWindow = { setTimeout: realHoverTimer, clearTimeout: realHoverClear };
hoverApi.uninstallInstantHover(restoreWindow, hoverApi.installInstantHover(restoreWindow, 0));
check("the tidy-up puts both real timers back, but never a foreign later layer",
	[tidyWindow.setTimeout === foreignTimer, tidyWindow.clearTimeout === foreignClear,
		restoreWindow.setTimeout === realHoverTimer, restoreWindow.clearTimeout === realHoverClear,
		String(hoverApi.uninstallInstantHover(null, restoreWindow)),
		String(hoverApi.uninstallInstantHover(restoreWindow, null))].join("|"),
	"true|true|true|true|undefined|undefined");
const reloadWindow = { setTimeout: realHoverTimer, clearTimeout: realHoverClear };
const firstInstall = hoverApi.installInstantHover(reloadWindow, 0);
reloadWindow.setTimeout(writtenGrace, 200);
hoverApi.uninstallInstantHover(reloadWindow, firstInstall);
closed.length = 0;
const reinstall = hoverApi.installInstantHover(reloadWindow, 0);
const reloadFired = fireHoverTimer(reloadWindow.setTimeout(openNext, 800));
check("a reinstall starts with no close left over from the install before it",
	[reinstall !== null, String(reloadFired), closed.join(",")].join("|"), "true|true|open");
check("the wrapper takes over the shipped close grace alone, never a fade or an export",
	[/POINTER_GRACE_CALLBACK/.test(extract("installInstantHover")),
		/previewFade|PREVIEW_FADE_MS|"closed"|closeDelay|primitives/.test(extract("installInstantHover"))].join("|"),
	"true|false");
check("the dwell it forces is a parameter, not the shipped 800ms baked in",
	/800/.test(extract("installInstantHover")), false);
check("session work folds model time and tool time into one duration",
	JSON.stringify(hoverApi.sessionWork({ llmMs: 1200, toolMs: 300, turns: 4, steps: 9 })),
	'{"ms":1500,"llmMs":1200,"toolMs":300,"turns":4,"steps":9}');
check("session work reports nothing when the projection has nothing",
	[String(hoverApi.sessionWork(undefined)), String(hoverApi.sessionWork(null)), String(hoverApi.sessionWork({})),
		String(hoverApi.sessionWork({ llmMs: -5, toolMs: "x", turns: Number.NaN }))].join("|"), "null|null|null|null");
check("session work keeps a session that only counted turns",
	JSON.stringify(hoverApi.sessionWork({ turns: 2 })), '{"ms":0,"llmMs":0,"toolMs":0,"turns":2,"steps":0}');

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

/**
 * Mount the host half on a fake context and remember the route it registered.
 * `services` stands in for the optional carrier services the face route reads.
 */
function mountHost(config, services) {
	applyHost({
		inject: (_keys, callback) => callback({
			effect: (operation) => operation(),
			webServer: { register: (route) => { routes.push(route); return () => {}; } }
		}),
		get: (name) => services?.[name]
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

// ------------------------------------------------------ capability face (host)
//
// The face route is exercised against fake durable logs: the real handler folds
// them, so what these checks assert is what the browser would receive. Skills
// come from an optional carrier service, and a missing one must degrade instead
// of failing an answer that is otherwise complete.

const IDENTITY = "You are an AI agent powered by DeepSeek Harness.";
const PARENT_PERSONA = "你是 Adg 多智能体模式的调度智能体（dispatcher）。";
const CHILD_PERSONA = "你是实现工程师（coder）。";
const ONESHOT_PERSONA = "你是一次性核查员（checker）。";
const PARENT_ID = "session-parent";
const CHILD_ID = "session-child-continuable";
const ONESHOT_ID = "session-child-oneshot";
const ORPHAN_ID = "session-child-orphan";
const SHARED_ID = "session-child-shared";
const GONE_ID = "session-child-gone";
const MODEL_ID = "session-child-model";
const SAME_ID = "session-child-composed-alike";
const MODEL_LINE = "You are a coding agent powered by the deepseek-v4.1-flash model.";
const promptLines = (persona, tail = ["", "## Tools", "read, grep, glob"]) => [IDENTITY, "", persona, ...tail].join("\n");
// This one shares three prompt lines with its parent, so the difference reaches
// past the persona section and must not be read as a persona at all.
const SHARED_TEXT = [IDENTITY, "", PARENT_PERSONA, "a section of its own", "## Tools", "read"].join("\n");

const systemPrompt = (text) => ({
	turn: 0,
	step: 0,
	message: { role: "system", content: [{ type: "text", text }] }
});
const header = (tools, reason) => ({
	type: "request/header",
	seq: 3,
	time: 3,
	data: { header: { config: { provider: "qwen-token-plan-cn", model: "deepseek-v4.1-flash", reasoningEffort: "high" }, tools }, reason }
});
const descriptor = (mode, extra) => ({
	type: "subagent/descriptor",
	seq: 1,
	time: 1,
	data: { version: 3, mode, provider: "spawn", label: mode === "one-shot" ? "Check the live prompt" : "Build the thing", agentProvider: "qwen-token-plan-cn", agentModel: "deepseek-v4.1-flash", agentReasoningEffort: "high", ...extra }
});

const logs = new Map([
	[PARENT_ID, {
		session: { id: PARENT_ID, createdAt: 1790859000000, cwd: "D:\\dsh", origin: "top-level" },
		inheritedEventCount: 0,
		events: [
			{ type: "system/message", seq: 1, time: 1, data: systemPrompt(promptLines(PARENT_PERSONA)) },
			// The parent was recomposed later on another model. A child composed
			// against the parent's *first* prompt must not inherit this.
			{ type: "system/message", seq: 900, time: 900, data: systemPrompt(promptLines("You are a coding agent powered by the qwen3.8-max model.")) }
		]
	}],
	[SAME_ID, {
		session: { id: SAME_ID, createdAt: 1790859001000, cwd: "D:\\dsh", origin: "subagent", parentSession: PARENT_ID },
		inheritedEventCount: 0,
		events: [{ type: "system/message", seq: 1, time: 1, data: systemPrompt(promptLines(PARENT_PERSONA)) }]
	}],
	[CHILD_ID, {
		session: { id: CHILD_ID, createdAt: 1790859003771, cwd: "D:\\dsh", origin: "subagent", delegationDepth: 1, agentPreset: "cordis", parentSession: PARENT_ID, isSeeded: true },
		inheritedEventCount: 0,
		events: [
			descriptor("continuable", { persona: CHILD_PERSONA, toolFilter: { allow: ["read", "glob"] } }),
			{ type: "system/message", seq: 2, time: 2, data: systemPrompt(promptLines(CHILD_PERSONA)) },
			header([{ name: "stale", description: "from the first request" }], "start"),
			header([
				{ name: "read", description: "Read one file", parameters: { type: "object", properties: { path: { type: "string" } } } },
				{ name: "grep", description: "Search", deferLoading: true }
			], "tools-changed")
		]
	}],
	[ONESHOT_ID, {
		session: { id: ONESHOT_ID, createdAt: 1790859004000, cwd: "D:\\dsh", origin: "subagent", delegationDepth: 1, parentSession: PARENT_ID },
		inheritedEventCount: 0,
		events: [
			descriptor("one-shot", {}),
			{ type: "system/message", seq: 2, time: 2, data: systemPrompt(promptLines(ONESHOT_PERSONA)) }
		]
	}],
	[ORPHAN_ID, {
		session: { id: ORPHAN_ID, createdAt: 1790859005000, cwd: "D:\\dsh", origin: "subagent" },
		inheritedEventCount: 0,
		events: [{ type: "system/message", seq: 1, time: 1, data: systemPrompt(promptLines(ONESHOT_PERSONA)) }]
	}],
	[SHARED_ID, {
		session: { id: SHARED_ID, createdAt: 1790859006000, cwd: "D:\\dsh", origin: "subagent", parentSession: PARENT_ID },
		inheritedEventCount: 0,
		events: [{ type: "system/message", seq: 1, time: 1, data: systemPrompt(SHARED_TEXT) }]
	}],
	[GONE_ID, {
		session: { id: GONE_ID, createdAt: 1790859007000, cwd: "D:\\dsh", origin: "subagent", parentSession: "session-gone" },
		inheritedEventCount: 0,
		events: [{ type: "system/message", seq: 1, time: 1, data: systemPrompt(promptLines(ONESHOT_PERSONA)) }]
	}],
	// No delegation named a persona here: the harness filled the slot from the
	// model, which is what a real child usually differs in.
	[MODEL_ID, {
		session: { id: MODEL_ID, createdAt: 1790859008000, cwd: "D:\\dsh", origin: "subagent", parentSession: PARENT_ID },
		inheritedEventCount: 0,
		events: [{ type: "system/message", seq: 1, time: 1, data: systemPrompt(promptLines(MODEL_LINE)) }]
	}]
]);

const sessionQuery = {
	readSession: async (sessionId) => {
		const log = logs.get(sessionId);
		if (log !== undefined) return log;
		const error = new Error(`session "${sessionId}" is not in this profile`);
		error.code = "SESSION_QUERY_SESSION_NOT_FOUND";
		throw error;
	}
};
const skillCalls = [];
const sessionSkillCatalog = {
	list: async (request) => {
		skillCalls.push(request);
		return { skills: [
			{ name: "adg-delegation", description: "写一次委派", whenToUse: "当你需要派出子代理时", modelInvocable: true, path: "D:\\dsh\\skills\\adg-delegation\\SKILL.md" },
			{ name: "hand-written", description: "只给人看的技能", modelInvocable: false }
		] };
	}
};
const faceUrl = (sessionId, parent) => "/api/subagent-mgm/face?sessionId=" + encodeURIComponent(sessionId)
	+ (parent === undefined ? "" : "&parent=" + encodeURIComponent(parent));

const faceRoute = mountHost({}, { sessionQuery, sessionSkillCatalog });
check("the face is served under the same prefix", routes[faceRoute].path, "/api/subagent-mgm");
check("a face without a session id is refused", (await call({ url: "/api/subagent-mgm/face" }, faceRoute)).status, 400);
check("the refusal says what is missing",
	(await call({ url: "/api/subagent-mgm/face" }, faceRoute)).payload.error, "sessionId is required");
check("an id that is not a session id is refused", (await call({ url: faceUrl("../secrets") }, faceRoute)).status, 400);
check("a face cannot be written to", (await call({ method: "POST", url: faceUrl(CHILD_ID) }, faceRoute)).status, 405);
check("the face shares the origin fence",
	(await call({ url: faceUrl(CHILD_ID), headers: { origin: "http://evil.example" } }, faceRoute)).status, 403);
check("an unknown session has no face", (await call({ url: faceUrl("session-nobody") }, faceRoute)).status, 404);
check("the missing session is named",
	(await call({ url: faceUrl("session-nobody") }, faceRoute)).payload.error, 'session "session-nobody" has no log in this profile');

const face = await call({ url: faceUrl(CHILD_ID) }, faceRoute);
check("a subagent has a face", face.status, 200);
check("the face is JSON and never cached",
	[face.headers["content-type"], face.headers["cache-control"]].join("|"), "application/json; charset=utf-8|no-store");
check("the face reports the delegation",
	[face.subagent.mode, face.subagent.label, face.subagent.provider].join(","), "continuable,Build the thing,spawn");
check("the face reports where the session came from",
	[face.session.origin, face.session.delegationDepth, face.session.agentPreset, face.session.parentSession, face.session.isSeeded].join(","),
	"subagent,1,cordis,session-parent,true");
check("the face reports the delegation's own model",
	[face.subagent.agentProvider, face.subagent.agentModel, face.subagent.agentReasoningEffort].join(","),
	"qwen-token-plan-cn,deepseek-v4.1-flash,high");
check("the face reports the run the session is on",
	[face.run.provider, face.run.model, face.run.reasoningEffort].join(","), "qwen-token-plan-cn,deepseek-v4.1-flash,high");
check("the face reports the filter the delegation set", face.subagent.toolFilter, { allow: ["read", "glob"] });
check("the tool list is the last request's, not the first",
	face.tools.map((tool) => tool.name).join(","), "read,grep");
check("a tool keeps the schema it was declared with",
	face.tools[0].parameters, { type: "object", properties: { path: { type: "string" } } });
check("a deferred tool is reported as deferred",
	[face.tools[0].deferLoading, face.tools[1].deferLoading].join(","), "false,true");
check("the persona is the one the delegation recorded",
	[face.persona.source, face.persona.inferred, face.persona.text].join("|"), "descriptor|false|" + CHILD_PERSONA);
check("a recorded persona replaces nothing", face.persona.replaced, null);
check("the skills are the ones this session sees",
	face.skills.state + ":" + face.skills.entries.map((entry) => entry.name).join(","), "ok:adg-delegation,hand-written");
check("a skill keeps the flag that gates model use",
	[face.skills.entries[0].modelInvocable, face.skills.entries[1].modelInvocable].join(","), "true,false");
check("a skill keeps its invocation guide", face.skills.entries[0].whenToUse, "当你需要派出子代理时");
check("a skill keeps the path it loads from", face.skills.entries[0].path, "D:\\dsh\\skills\\adg-delegation\\SKILL.md");
check("the catalogue is asked about the session itself", skillCalls.at(-1).sessionId, CHILD_ID);

const recovered = await call({ url: faceUrl(ONESHOT_ID) }, faceRoute);
check("a one-shot subagent has a face too", recovered.status, 200);
check("the one-shot delegation is reported as such", recovered.subagent.mode, "one-shot");
check("a persona the descriptor never wrote is recovered from its prompt", recovered.persona.text, ONESHOT_PERSONA);
check("the recovered persona is labelled as inferred",
	[recovered.persona.source, recovered.persona.inferred].join("|"), "system-prompt|true");
check("the persona it replaced is reported", recovered.persona.replaced, PARENT_PERSONA);
check("a session with no requests reports no tools", recovered.tools.length, 0);
check("a session with no descriptor reports no filter", recovered.persona === null ? "unexpected" : recovered.subagent.toolFilter, null);

const hinted = await call({ url: faceUrl(ORPHAN_ID, PARENT_ID) }, faceRoute);
check("the open session can stand in as the parent", hinted.persona.text, ONESHOT_PERSONA);
check("a session with no parent hint keeps its persona unknown",
	(await call({ url: faceUrl(ORPHAN_ID) }, faceRoute)).persona, null);

const shared = await call({ url: faceUrl(SHARED_ID) }, faceRoute);
check("a prompt that differs past the persona is not a persona", shared.persona, null);
check("the shared-prompt session is still described", [shared.status, shared.sessionId].join("|"), "200|" + SHARED_ID);

const gone = await call({ url: faceUrl(GONE_ID) }, faceRoute);
check("a missing parent leaves the persona unknown", gone.persona, null);

const modelled = await call({ url: faceUrl(MODEL_ID) }, faceRoute);
check("a persona slot filled from the model is still reported", modelled.persona.text, MODEL_LINE);
check("it is flagged as generated, not chosen",
	[modelled.persona.source, modelled.persona.inferred, modelled.persona.generated].join("|"), "system-prompt|true|true");
check("the model line it replaced is reported", modelled.persona.replaced, PARENT_PERSONA);
check("an inferred persona that was chosen is not flagged",
	[recovered.persona.inferred, recovered.persona.generated].join("|"), "true|false");
check("a recorded persona is not flagged either", face.persona.generated, false);

const recomposed = await call({ url: faceUrl(SAME_ID) }, faceRoute);
check("a parent recomposed later is not read as this child's persona", recomposed.persona, null);
check("the parent's first prompt is the one compared",
	(await call({ url: faceUrl(ONESHOT_ID) }, faceRoute)).persona.replaced, PARENT_PERSONA);

const noCatalogue = mountHost({}, { sessionQuery });
check("a face still answers without the skill catalogue",
	(await call({ url: faceUrl(CHILD_ID) }, noCatalogue)).status, 200);
check("a missing skill catalogue is reported, not faked",
	(await call({ url: faceUrl(CHILD_ID) }, noCatalogue)).skills.state, "unavailable");
check("an unavailable skill list is empty and unexplained",
	(await call({ url: faceUrl(CHILD_ID) }, noCatalogue)).skills.entries.length, 0);

const brokenCatalogue = mountHost({}, {
	sessionQuery,
	sessionSkillCatalog: { list: async () => { throw new Error("skill registry is absent: nothing is mounted"); } }
});
const broken = await call({ url: faceUrl(CHILD_ID) }, brokenCatalogue);
check("a failing skill catalogue does not fail the face", broken.status, 200);
check("the skill failure is reported, not swallowed",
	[broken.skills.state, broken.skills.error].join("|"), "error|skill registry is absent: nothing is mounted");
check("a failing skill catalogue still reports the tools", broken.tools.length, 2);

const noQuery = mountHost({}, {});
check("a face without session reads is refused, not guessed",
	(await call({ url: faceUrl(CHILD_ID) }, noQuery)).status, 503);
check("the refusal names the missing service",
	(await call({ url: faceUrl(CHILD_ID) }, noQuery)).payload.error,
	"session reads are unavailable: the session-query service is not mounted");

const corruptLog = mountHost({}, { sessionQuery: { readSession: async () => { throw new Error("log is corrupt"); } } });
check("an unreadable log is an error, not a 404", (await call({ url: faceUrl(CHILD_ID) }, corruptLog)).status, 500);
check("the unreadable log keeps its reason",
	(await call({ url: faceUrl(CHILD_ID) }, corruptLog)).payload.error,
	'session "session-child-continuable" could not be read: log is corrupt');

// ------------------------------------------------------ model batch (host)
//
// The model behind a set of rows is read in one capped, read-only request: one
// log per id, so the batch is a convenience for the caller, never a licence to
// read the whole profile. An id's own failure stays that id's own answer.

const modelsUrl = (ids) => "/api/subagent-mgm/models?sessionIds=" + encodeURIComponent(ids.join(","));
const models = await call({ url: modelsUrl([CHILD_ID, ONESHOT_ID, ORPHAN_ID, "session-nobody"]) }, faceRoute);
check("the batch answers behind the same fence as the face", models.status, 200);
check("a batch is JSON and never cached",
	[models.headers["content-type"], models.headers["cache-control"]].join("|"), "application/json; charset=utf-8|no-store");
check("a batch answers in the order it was asked",
	models.entries.map((entry) => entry.sessionId).join(","),
	[CHILD_ID, ONESHOT_ID, ORPHAN_ID, "session-nobody"].join(","));
const [modelChild, modelOneshot, modelOrphan, modelMissing] = models.entries;
check("the batch reports the model the last run used",
	[modelChild.provider, modelChild.model, modelChild.reasoningEffort].join(","), "qwen-token-plan-cn,deepseek-v4.1-flash,high");
check("the batch reports the model the delegation named",
	[modelChild.agentProvider, modelChild.agentModel].join(","), "qwen-token-plan-cn,deepseek-v4.1-flash");
check("the batch reports the mode and the preset beside them",
	[modelChild.mode, modelChild.preset].join("|"), "continuable|cordis");
check("a row that never ran names only the delegated model",
	JSON.stringify([modelOneshot.state, modelOneshot.agentModel, modelOneshot.model, modelOneshot.preset]),
	'["ok","deepseek-v4.1-flash",null,null]');
check("a row with no delegation at all is unknown, not invented",
	JSON.stringify([modelOrphan.state, modelOrphan.mode, modelOrphan.model]), '["ok","unknown",null]');
check("an id with no log answers for itself", modelMissing.state, "missing");
check("one missing id does not fail the batch", models.entries.filter((entry) => entry.state === "ok").length, 3);
check("the same id twice is read once",
	(await call({ url: modelsUrl([CHILD_ID, CHILD_ID]) }, faceRoute)).entries.length, 1);
check("an empty batch is refused",
	(await call({ url: "/api/subagent-mgm/models?sessionIds=" }, faceRoute)).status, 400);
check("the empty batch says what is missing",
	(await call({ url: "/api/subagent-mgm/models" }, faceRoute)).payload.error, "sessionIds is required");
check("an id that is not a session id is refused",
	(await call({ url: modelsUrl(["../secrets"]) }, faceRoute)).status, 400);
check("the refusal names the id it refused",
	(await call({ url: modelsUrl(["../secrets"]) }, faceRoute)).payload.error, 'invalid session id "../secrets"');
const overCapped = Array.from({ length: 65 }, (_, index) => `session-cap-${index}`);
check("a batch is capped",
	(await call({ url: modelsUrl(overCapped) }, faceRoute)).status, 400);
check("the cap says how many it will read",
	(await call({ url: modelsUrl(overCapped) }, faceRoute)).payload.error, "at most 64 sessionIds are read per request");
check("a batch cannot be written to", (await call({ method: "POST", url: modelsUrl([CHILD_ID]) }, faceRoute)).status, 405);
check("the batch shares the origin fence",
	(await call({ url: modelsUrl([CHILD_ID]), headers: { origin: "http://evil.example" } }, faceRoute)).status, 403);
check("a batch without session reads is refused, not guessed",
	(await call({ url: modelsUrl([CHILD_ID]) }, noQuery)).status, 503);
check("that refusal names the missing service",
	(await call({ url: modelsUrl([CHILD_ID]) }, noQuery)).payload.error,
	"session reads are unavailable: the session-query service is not mounted");
const modelsBroken = await call({ url: modelsUrl([CHILD_ID]) }, corruptLog);
check("an unreadable log is that row's error, not the batch's", modelsBroken.status, 200);
check("the unreadable row keeps its reason", modelsBroken.entries[0].error, "log is corrupt");
check("an unreadable row is marked as an error", modelsBroken.entries[0].state, "error");

rmSync(storeDir, { recursive: true, force: true });
if (failures.length > 0) {
	console.error("\nFAILED:\n" + failures.join("\n"));
	process.exit(1);
}
console.log(`\nall ${passed} checks passed`);