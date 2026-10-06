/**
 * Browser half of dsh-subagent-mgm.
 *
 * The DSH Web UI side of dsh-subagent-mgm:
 *  1. The subagent catalog trigger in the conversation header lists subagents
 *     newest-first (by `createdAt`), at every nesting level.
 *  2. A running direct subagent of the on-screen session gets its chat panel in
 *     the right sidebar automatically, and that panel closes when the subagent
 *     ends. Closing it by hand while the subagent still runs is respected.
 *  3. Every row carries a capability face: the tools its last request carried,
 *     the skills its preset sees and the persona its delegation wrote, read from
 *     the host at `/api/subagent-mgm/face` — another session's log is in nothing
 *     the browser receives.
 *  4. The menu can narrow its tree (text / state / mode) and total what it has
 *     loaded — tokens, the cache-hit share of prompt-side input, and wall time —
 *     in two lines so neither reflows the other. The session on screen is totalled
 *     with them and named beside the totals, since its own tokens are spent in the
 *     same place. The model behind those rows is read on demand from
 *     `/api/subagent-mgm/models`, because a model is named only in that subagent's
 *     own log. The share is taken over summed buckets, never averaged per row, so a
 *     tree total means what one log's share means.
 *  5. The same digest, smaller, fills a sidebar Session row's hover card: that
 *     row's subagent count, live tokens, cache share, wall time and up to four
 *     rows, read from the two client stores alone — the card stays local,
 *     read-only, and needs no log. A Session without subagents shows its own
 *     usage line there instead of nothing.
 *  6. Those cards open without the shipped 800ms dwell, and only one of them is
 *     ever up: the global timers that arm the opening dwell and the 200ms close
 *     grace are wrapped once at load — the primitives namespace the card is read
 *     off is frozen by the shell, so its export cannot be. Crossing several rows
 *     shows each card at once and takes down the one just left, while leaving a
 *     row with nothing else opening still dismisses its card after the grace.
 *
 * A Settings page in the settings.section slot switches the ordering and the
 * automatic panels on and off. The switches are stored by this bundle's host half
 * behind /api/subagent-mgm/settings, so they survive a reload.
 *
 * The count trigger, the breadcrumb switcher and the tree are ported from the shipped
 * `@deepseek-ai/dsh-client-ui-subagent` catalog (markup, CSS and behaviour),
 * re-registered under this plugin's own class prefix and locale namespace.
 */
window.__ModuleLoader__.load({
	id: "dsh-subagent-mgm",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

		/** Locale namespace owned by this plugin (registered by `apply`). */
		const NS = "subagentMgr";
		/** Right-sidebar tab kind that renders one subagent chat. */
		const CHAT_KIND = "subagentchat";
		/** Address scheme claimed by the shipped subagent chat resource provider. */
		const CHAT_PREFIX = "dsh-resource://subagentchat/session/";
		/** Marker on the stylesheet this plugin owns. */
		const STYLE_TAG = "dsh-subagent-mgm/SubagentMgr.module.css";
		const MENU_VIEWPORT_MARGIN = 16;
		const MENU_WIDTH = 336;
		/** The capability face needs room for a tool list, so its menu is wider. */
		const MENU_WIDTH_WIDE = 520;
		const HOVER_OPEN_DELAY = 150;
		const HOVER_CLOSE_DELAY = 120;
		/** Same-origin route backed by this bundle's host half. */
		const SETTINGS_ROUTE = "/api/subagent-mgm/settings";
		/** Same-origin route that returns one subagent's capability face. */
		const FACE_ROUTE = "/api/subagent-mgm/face";
		/** Same-origin route that returns the model behind a batch of session ids. */
		const MODELS_ROUTE = "/api/subagent-mgm/models";
		/** Subagent rows a sidebar hover card lists before it counts the rest. */
		const HOVER_ROWS = 4;
		/** Every switch the settings page owns, in page order. */
		const SETTING_FIELDS = ["newestFirst", "autoOpen", "autoClose", "reveal"];
		/** Effective switches before the first host reply: the original behaviour. */
		const DEFAULT_SETTINGS = Object.freeze({ newestFirst: true, autoOpen: true, autoClose: true, reveal: true });
		/**
		 * Live view of the switches, shared by the catalog and the panel keeper.
		 * The host route is the durable record; this snapshot is what the UI reads.
		 */
		const settingsStore = (() => {
			let snapshot = DEFAULT_SETTINGS;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				adopt(payload) {
					const resolved = {};
					for (const field of SETTING_FIELDS) {
						resolved[field] = typeof payload?.[field] === "boolean" ? payload[field] : DEFAULT_SETTINGS[field];
					}
					snapshot = Object.freeze(resolved);
					for (const listener of [...listeners]) listener();
				}
			};
		})();
		/**
		 * Subscribe one component to the effective switches.
		 * @returns the current switch values.
		 */
		function useSettings() {
			const [value, setValue] = useState(settingsStore.getSnapshot);
			useEffect(() => settingsStore.subscribe(() => setValue(settingsStore.getSnapshot)), []);
			return value;
		}
		/**
		 * A clock that ticks once a second, for components that show a duration.
		 * @returns the current timestamp, refreshed every second while mounted.
		 */
		function useNow() {
			const [value, setValue] = useState(Date.now);
			useEffect(() => {
				const timer = setInterval(() => setValue(Date.now()), 1e3);
				return () => clearInterval(timer);
			}, []);
			return value;
		}
		/**
		 * The Session's own working wall time, as the host's `sessionStats`
		 * projection folds it: model time (`llmMs`) plus tool time (`toolMs`). That is
		 * the same kind of number a delegated row shows from its `subagentTiming`, so
		 * a Session with no subagents can still answer "how long did this take" from
		 * the client store alone, with no log read.
		 * @param stats - the `sessionStats` projection, or undefined when it is absent.
		 * @returns `{ ms, llmMs, toolMs, turns, steps }`, or null when it has nothing.
		 */
		function sessionWork(stats) {
			if (stats === null || typeof stats !== "object") return null;
			const count = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
			const llmMs = count(stats.llmMs);
			const toolMs = count(stats.toolMs);
			const turns = count(stats.turns);
			const steps = count(stats.steps);
			if (llmMs === 0 && toolMs === 0 && turns === 0 && steps === 0) return null;
			return { ms: llmMs + toolMs, llmMs, toolMs, turns, steps };
		}
		/** Hover dwell this plugin leaves the shipped preview cards, in milliseconds. */
		const INSTANT_HOVER_OPEN_MS = 0;
		/** Marks both wrapped timers so a second install cannot stack another layer on them. */
		const INSTANT_HOVER_MARK = Symbol.for("dsh-subagent-mgm.instantHoverTimer");
		/**
		 * The dwell timer's callback, matched by the call it makes: the shipped
		 * `HoverCard` opens through `setTimeout(() => { setPhase("open"); }, openDelayMs)`.
		 *
		 * The timer, not the module export, is the place to intervene. The shell hands
		 * every bundle one `@deepseek-ai/dsh-client-ui-primitives` namespace built with
		 * `Object.freeze`, so writing a wrapper onto that namespace's `HoverCard` is a
		 * silent no-op — the cards keep the delay the workspace asked for. Its `setTimeout`,
		 * by contrast, is the global at call time, and the minifier keeps the string
		 * the callback closes on, so the one timer this matches is the one that opens a
		 * card. In the shipped client every other timer ends on something else
		 * (`"closed"`, `show()`, `setCopied`, a fade or a focus move).
		 */
		const HOVER_OPEN_CALLBACK = /\(\s*["']open["']\s*\)/;
		/**
		 * The close grace's callback, matched the same way: the shipped `usePointerGrace`
		 * waits out its 200ms through
		 * `setTimeout(() => { timerRef.current = null; closeRef.current(); }, 200)`.
		 *
		 * Only property names reach this pattern — a minifier renames the refs, never
		 * `.current` or the `null` written into it — so the shape is what identifies the
		 * timer, not the delay. The sibling that clears a ref and then calls a plain
		 * function (`setTimeout(() => { timerRef.current = null; show(); }, 200)`) does
		 * not match, and neither does the fade. In the shipped shell this pattern matches
		 * exactly one timer: the shared grace both the preview card and the dropdown menu
		 * close through.
		 */
		const POINTER_GRACE_CALLBACK = /\.current\s*=\s*null\s*[,;]\s*[A-Za-z_$][\w$]*\.current\s*\(/;
		/**
		 * Open the shipped preview cards without their dwell, and take down the card the
		 * pointer just left the moment a new one opens.
		 *
		 * The sidebar's Session and workspace rows ask for 800ms of dwell
		 * (`dsh-client-ui-workspace` passes `openDelayMs: 800`), which is long enough to
		 * feel broken when this plugin's digest is the reason to hover a Session row at
		 * all. Wrapping `setTimeout` breaks no export and edits no package file, so the
		 * change survives reinstalling DSH.
		 *
		 * Sweeping the pointer down a list of rows shows every crossed card at once,
		 * stacked over the ones still waiting out their close grace, so the forced dwell
		 * is paired with a hand-off: the close grace is the one other timer this wrapper
		 * tracks, and opening a card runs any grace still pending in place of its own
		 * timer. A card the pointer simply left alone keeps its shipped delay — only a
		 * card that something replaces disappears at once.
		 * @param target - the object carrying the live timers (the window).
		 * @param delayMs - the opening dwell to force.
		 * @returns the installed handles once both wrappers are in place, else null.
		 */
		function installInstantHover(target, delayMs) {
			if (target === null || typeof target !== "object") return null;
			const real = target.setTimeout;
			const realClear = target.clearTimeout;
			// A grace that could not be taken out of the queue would run twice, so both
			// halves have to be wrappable before either one is installed.
			if (typeof real !== "function" || typeof realClear !== "function" || real[INSTANT_HOVER_MARK] === true) return null;
			/** Close graces waiting out their delay, by timer id. */
			const pending = new Map();
			/**
			 * Run every close still waiting out its grace now, in place of its own timer:
			 * when a card opens, one of these belongs to the card the pointer just left.
			 */
			const flushPendingCloses = () => {
				const entries = [...pending.values()];
				pending.clear();
				for (const entry of entries) {
					realClear.call(target, entry.id);
					try {
						entry.callback(...entry.args);
					} catch (error) {
						console.warn("[subagent-mgm] a hover card could not be dismissed early", error);
					}
				}
			};
			const wrapped = function (callback, delay, ...rest) {
				if (typeof delay !== "number" || typeof callback !== "function") return real.call(this, callback, delay, ...rest);
				if (delay > delayMs && HOVER_OPEN_CALLBACK.test(String(callback))) {
					return real.call(this, (...args) => {
						flushPendingCloses();
						return callback(...args);
					}, delayMs, ...rest);
				}
				if (delay <= 0 || !POINTER_GRACE_CALLBACK.test(String(callback))) return real.call(this, callback, delay, ...rest);
				let id = 0;
				const once = (...args) => {
					pending.delete(id);
					return callback(...args);
				};
				id = real.call(this, once, delay, ...rest);
				pending.set(id, { id, callback, args: rest });
				return id;
			};
			wrapped[INSTANT_HOVER_MARK] = true;
			const wrappedClear = function (id, ...rest) {
				pending.delete(id);
				return realClear.call(this, id, ...rest);
			};
			wrappedClear[INSTANT_HOVER_MARK] = true;
			try {
				target.setTimeout = wrapped;
				target.clearTimeout = wrappedClear;
			} catch (error) {
				// A global that refuses the write is not worth breaking the plugin over; put
				// back whichever half did take before reporting the failure.
				try {
					target.setTimeout = real;
					target.clearTimeout = realClear;
				} catch (ignored) {
					// The refused write is the one that threw; there is nothing to put back.
				}
				return null;
			}
			// A sloppy-mode write onto a read-only property fails silently instead; either
			// way report only what actually took.
			if (target.setTimeout !== wrapped || target.clearTimeout !== wrappedClear) {
				target.setTimeout = real;
				target.clearTimeout = realClear;
				return null;
			}
			return { real, wrapped, realClear, wrappedClear };
		}
		/**
		 * Put the real timers back, but only while ours are still the live ones: a later
		 * install (or a reload that re-applies this plugin) may have wrapped them again,
		 * and that outer layer must survive this tidy-up. A grace still pending is left to
		 * its own timer, exactly the way it was armed.
		 * @param target - the object the wrappers were installed on.
		 * @param installed - what `installInstantHover` returned.
		 */
		function uninstallInstantHover(target, installed) {
			if (target === null || typeof target !== "object" || installed === null || typeof installed !== "object") return;
			if (target.setTimeout === installed.wrapped) target.setTimeout = installed.real;
			if (target.clearTimeout === installed.wrappedClear) target.clearTimeout = installed.realClear;
		}

		/** Ported from the shipped catalog stylesheet; classes renamed under `smgm-`. */
		const CSS = `
.smgm-root{align-items:center;gap:10px;min-width:0;display:inline-flex;position:relative}
.smgm-trigger{border-radius:var(--dsw-radius-sm);min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;align-items:center;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex;gap:4px}
.smgm-trigger:hover,.smgm-trigger:focus-visible{color:var(--dsw-alias-label-primary)}
.smgm-trigger svg{transition:transform .12s}
.smgm-triggerOpen{transform:rotate(180deg)}
.smgm-switcherRoot{min-width:0;margin-left:6px}
.smgm-switcherTrigger{border-radius:var(--dsw-radius-sm);min-height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:0;align-items:center;padding:3px 2px;font-size:12px;line-height:18px;display:inline-flex;min-width:0;max-width:244px;gap:4px;font-weight:500}
.smgm-ancestorSwitcherTrigger{color:var(--dsw-alias-label-tertiary);font-weight:400}
.smgm-switcherTitle{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}
.smgm-switcherTrigger svg{flex:none;transition:transform .12s}
.smgm-switcherTrigger:hover,.smgm-switcherTrigger:focus-visible{color:var(--dsw-alias-label-primary)}
.smgm-ancestorSwitcherTrigger:hover,.smgm-ancestorSwitcherTrigger:focus-visible{color:var(--dsw-alias-label-tertiary)}
.smgm-activitySlot{flex:none;justify-content:center;align-items:center;width:14px;height:14px;display:inline-flex}
.smgm-count{white-space:nowrap}
.smgm-menu{z-index:100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:336px;max-width:min(400px,100vw - 32px);max-height:min(560px,100vh - 140px);box-shadow:var(--dsw-elevation-prominent,0 10px 32px rgba(0,0,0,.18));flex-direction:column;padding:3px;display:flex;position:fixed;overflow:hidden}
.smgm-menu:before{content:"";z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));backdrop-filter:var(--dsw-menu-backdrop-filter);position:absolute;inset:0}
.smgm-menuBody{flex-direction:column;flex:auto;min-height:0;display:flex;overflow:auto}
.smgm-node{min-width:0;position:relative}
.smgm-row{box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);width:100%;min-height:44px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:0;outline:none;align-items:flex-start;gap:6px;padding:6px 7px 6px 9px;font-size:12px;line-height:17px;display:flex;position:relative}
.smgm-row:hover>.smgm-clickarea,.smgm-row:focus-visible>.smgm-clickarea{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.smgm-clickarea{box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);flex:1;align-self:stretch;align-items:flex-start;gap:6px;min-width:0;margin:-6px -7px;padding:6px 7px;display:flex}
.smgm-rowActivitySlot{flex:none;justify-content:center;align-items:center;width:14px;height:17px;display:inline-flex}
.smgm-disclosure,.smgm-disclosureSpace{flex:none;width:14px;height:17px}
.smgm-disclosure{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;justify-content:center;align-items:center;padding:0;transition:transform .12s;display:inline-flex}
.smgm-disclosure svg{width:12px;height:12px}
.smgm-disclosure:hover{color:var(--dsw-alias-label-primary)}
.smgm-disclosureOpen{transform:rotate(90deg)}
.smgm-content{flex-direction:column;flex:1;min-width:0;display:flex}
.smgm-label,.smgm-summary{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.smgm-label{color:inherit;font-weight:400}
.smgm-currentLabel{font-weight:600}
.smgm-summary,.smgm-metrics{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}
.smgm-metrics{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;flex:none;grid-template-rows:17px 15px;display:grid}
.smgm-metricToken{grid-row:1;line-height:17px}
.smgm-metricDuration{grid-row:2}
.smgm-sidebarButton{border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;flex:none;justify-content:center;align-items:center;margin:4px 0;padding:6px;display:inline-flex}
.smgm-sidebarButton:hover,.smgm-sidebarButton:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.smgm-children{margin-left:16px;padding-left:3px;position:relative}
.smgm-children:before,.smgm-children>.smgm-node:before{content:"";border-left:.5px solid var(--dsw-alias-border-l2);position:absolute;left:0}
.smgm-children:before{height:23px;top:-23px}
.smgm-children[aria-busy=true]:before{content:none}
.smgm-children>.smgm-node:before{top:0;bottom:0;left:-3px}
.smgm-children>.smgm-node:last-child:before{height:15px;bottom:auto}
.smgm-children>.smgm-node>.smgm-row:before{content:"";border-top:.5px solid var(--dsw-alias-border-l2);width:12px;position:absolute;top:14px;left:-3px}
.smgm-notice,.smgm-error{color:var(--dsw-alias-label-tertiary);padding:8px 10px;font-size:11px;line-height:16px}
.smgm-error{color:var(--dsw-alias-state-error-primary);justify-content:space-between;align-items:center;gap:10px;display:flex}
.smgm-refresh{border-radius:var(--dsw-radius-sm);color:inherit;cursor:pointer;background:0 0;border:0;flex:none;align-items:center;gap:3px;padding:3px 5px;display:inline-flex}
.smgm-refresh:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.smgm-dot{position:relative;display:inline-block;flex:none}
.smgm-dot:after{content:"";position:absolute;inset:20%;border-radius:50%;background:currentColor}
.smgm-dot[data-state=done]{color:var(--dsw-alias-state-success-primary)}
.smgm-dot[data-state=idle]{color:var(--dsw-alias-state-idle-primary)}
.smgm-spinner{flex:none;color:var(--dsw-alias-label-tertiary)}
.smgm-spinnerMotion{transform-origin:center;animation:smgm-state-spin 1.5s linear infinite}
.smgm-spinnerTrack,.smgm-spinnerArc{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.smgm-spinnerTrack{opacity:.25}
.smgm-spinnerArc{stroke-dasharray:12 150;animation:smgm-state-dash 1.5s ease-in-out infinite}
@keyframes smgm-state-spin{to{transform:rotate(360deg)}}
@keyframes smgm-state-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}100%{stroke-dasharray:12 150;stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.smgm-spinnerMotion,.smgm-spinnerArc{animation:none}.smgm-spinnerArc{stroke-dasharray:18 150;stroke-dashoffset:-3}
.smgm-set{flex-direction:column;gap:16px;max-width:760px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);display:flex}
.smgm-setHead{flex-direction:column;gap:6px;display:flex}
.smgm-setTitle{margin:0;font-size:15px;font-weight:650}
.smgm-setSub{margin:0;max-width:62ch;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.smgm-setCard{flex-direction:column;gap:12px;padding:14px 15px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay));display:flex}
.smgm-setLabel{font-size:12px;font-weight:600}
.smgm-setOpt{align-items:flex-start;gap:12px;display:flex}
.smgm-setSwitch{position:relative;flex:0 0 auto;width:36px;height:20px;margin-top:1px;cursor:pointer;display:inline-flex}
.smgm-setSwitch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.smgm-setTrack{pointer-events:none;position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);transition:background .12s,border-color .12s}
.smgm-setKnob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));transition:transform .12s,background .12s}
.smgm-setSwitch input:checked+.smgm-setTrack{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.smgm-setSwitch input:checked+.smgm-setTrack .smgm-setKnob{transform:translateX(16px);background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1))}
.smgm-setSwitch input:focus-visible+.smgm-setTrack{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.smgm-setSwitch input:disabled+.smgm-setTrack{opacity:.5}
.smgm-setOptText{flex-direction:column;gap:2px;flex:1;min-width:0;display:flex}
.smgm-setOptLabel{font-size:12.5px;font-weight:600}
.smgm-setDim{opacity:.45}
.smgm-setHint{font-size:11.5px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.smgm-setActions{align-items:center;gap:10px;flex-wrap:wrap;display:flex}
.smgm-setBtn{font:inherit;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));padding:6px 14px;cursor:pointer}
.smgm-setBtnGhost{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.smgm-setBtn:hover:not(:disabled){opacity:.9}
.smgm-setBtn:disabled{opacity:.5;cursor:default}
.smgm-setState{flex-direction:column;gap:4px;padding:10px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));font-size:12px;display:flex}
.smgm-setNote{font-size:11px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.smgm-setMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay))}
.smgm-setOk{color:var(--dsw-alias-state-success-primary)}
.smgm-setErr{color:var(--dsw-alias-state-error-primary)}
.smgm-faceButton{border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;flex:none;justify-content:center;align-items:center;margin:4px 0;padding:6px;display:inline-flex}
.smgm-faceButton:hover,.smgm-faceButton:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.smgm-menu.smgm-menuWide{width:520px;max-width:min(620px,100vw - 32px)}
.smgm-face{flex-direction:column;gap:12px;padding:9px 11px 13px;display:flex}
.smgm-faceHead{align-items:center;gap:8px;display:flex}
.smgm-faceBack{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));cursor:pointer;background:0 0;border:0;flex:none;align-items:center;gap:2px;padding:4px 6px;font:inherit;font-size:11.5px;display:inline-flex}
.smgm-faceBack:hover,.smgm-faceBack:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.smgm-faceTitle{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden}
.smgm-faceChip{border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);flex:none;padding:1px 8px;font-size:10.5px;line-height:15px}
.smgm-faceGrid{grid-template-columns:auto 1fr;gap:3px 12px;font-size:11.5px;line-height:16px;display:grid}
.smgm-faceKey{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.smgm-faceValue{color:var(--dsw-alias-label-primary);word-break:break-word}
.smgm-faceSection{flex-direction:column;gap:6px;display:flex}
.smgm-faceSectionHead{align-items:baseline;gap:6px;display:flex}
.smgm-faceSectionTitle{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}
.smgm-faceCount{color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-variant-numeric:tabular-nums}
.smgm-faceItem{border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));flex-direction:column;gap:2px;padding:6px 8px;display:flex}
.smgm-faceItemName{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary);word-break:break-all}
.smgm-faceItemDesc{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.smgm-faceItemFlag{font-size:10px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.smgm-faceParams{margin:4px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.smgm-facePre{margin:0;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
.smgm-faceNote{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.smgm-faceEmpty{padding:4px 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.smgm-faceError{padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:16px;word-break:break-word}
.smgm-faceLoading{padding:16px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}
.smgm-faceFilter{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}
.smgm-head{flex-direction:column;gap:6px;padding:4px 6px 7px;border-bottom:.5px solid var(--dsw-alias-border-l1);display:flex;position:sticky;top:0;z-index:1;background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay))}
.smgm-controls{flex-direction:column;gap:6px;display:flex}
.smgm-search{box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;line-height:16px;padding:4px 7px;outline:none}
.smgm-search:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.smgm-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.smgm-chips{align-items:center;gap:4px;flex-wrap:wrap;display:flex}
.smgm-chip{border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;font:inherit;font-size:10.5px;line-height:15px;white-space:nowrap;padding:1px 8px}
.smgm-chip:hover,.smgm-chip:focus-visible{color:var(--dsw-alias-label-primary)}
.smgm-chipOn{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.smgm-chipClear{margin-left:auto;border:0;padding:1px 4px}
.smgm-totals{align-items:center;gap:6px;flex-wrap:wrap;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;display:flex}
.smgm-totalsItem{white-space:nowrap}
.smgm-summaryHint{font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.smgm-modelHead{align-items:center;gap:6px;flex-wrap:wrap;display:flex}
.smgm-models{flex-direction:column;gap:2px;display:flex}
.smgm-modelRow{align-items:baseline;gap:6px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));display:flex;flex-wrap:wrap}
.smgm-modelName{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-width:0;word-break:break-all}
.smgm-modelRow>.smgm-totalsItem{margin-left:auto}
.smgm-modelError{font-size:10.5px;line-height:15px;color:var(--dsw-alias-state-error-primary)}
.smgm-filterEmpty{padding:12px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-align:center}
.smgm-tree>.smgm-node{margin-left:-2px}
/* The sidebar hover card is styled by the workspace with literal dark-surface
   colours (.hoverTitle #fff, .hoverTime #cfd3d6, .hoverStatus #adb2b8), so this
   section matches those instead of the theme tokens used elsewhere. */
.smgm-digest{flex-direction:column;gap:5px;color:#adb2b8;font-size:12px;line-height:18px;display:flex}
.smgm-digestLine{align-items:center;gap:8px;flex-wrap:wrap;display:flex}
.smgm-digestRows{flex-direction:column;gap:3px;display:flex}
.smgm-digestRow{align-items:center;gap:6px;min-width:0;display:flex}
.smgm-digestName{flex:1 1 auto;min-width:0;color:#cfd3d6;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.smgm-digestValue{color:#cfd3d6;flex:none;font-variant-numeric:tabular-nums}
.smgm-digestNote{color:#8c9299;flex:none;font-size:11px}
`;

		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			"duration.seconds": "{seconds}秒",
			"duration.minutes": "{minutes}分{seconds}秒",
			"duration.hours": "{hours}小时{minutes}分{seconds}秒",
			"duration.days": "{days}天",
			"duration.daysHours": "{days}天{hours}小时",
			"duration.months": "约{months}个月",
			"duration.monthsDays": "约{months}个月{days}天",
			"duration.years": "约{years}年",
			"duration.yearsMonths": "约{years}年{months}个月",
			"duration.exactDays": "{days}天{hours}小时{minutes}分{seconds}秒",
			"duration.exactTitle": "总活跃耗时：{duration}",
			"tokens.thousand": "{value}K",
			"tokens.million": "{value}M",
			"tokens.total": "{value} tok",
			"loading.label": "正在加载子智能体…",
			"load.error": "无法加载子智能体",
			"retry": "重试",
			"mode.oneShot": "一次性",
			"mode.continuable": "可继续",
			"mode.unknown": "模式未知",
			"activity.running": "正在运行",
			"activity.completed": "已完成",
			"activity.inactive": "当前未运行",
			"branch.collapse": "收起 {label} 的下级子智能体",
			"branch.expand": "展开 {label} 的下级子智能体",
			"count.total.one": "{count} 个子智能体",
			"count.total.other": "{count} 个子智能体",
			"count.running.one": "{count} 个子智能体，正在运行",
			"count.running.other": "{count} 个子智能体，正在运行",
			"switcher.aria": "切换子智能体：{title}",
			"tree.aria": "子智能体会话",
			"open.sidebar": "在侧边栏打开",
			"open.sidebar.aria": "在侧边栏打开 {label}",
			"settings.nav": "子智能体管理",
			"settings.title": "子智能体管理",
			"settings.subtitle": "目录顺序与自动开合右侧栏面板的行为开关。改动保存在本插件的设置文件里，刷新后依然生效。",
			"settings.behaviour": "行为",
			"settings.newestFirst": "子智能体目录按创建时间倒序",
			"settings.newestFirstHint": "关闭后恢复官方原顺序：最早创建的在最上面。",
			"settings.autoOpen": "子智能体开始运行时自动在右侧栏打开",
			"settings.autoOpenHint": "只处理屏幕上这个会话的直接子智能体；每次运行只打开一次，不会反复抢前台。",
			"settings.autoClose": "子智能体结束时自动关闭它的面板",
			"settings.autoCloseHint": "手动打开的面板同样会在该子智能体结束时关闭。",
			"settings.reveal": "面板已开在后台时自动拎到前台",
			"settings.revealHint": "关闭后不抢前台：面板已在后台标签里就保持原样，需要你自己切过去。",
			"settings.current": "当前生效",
			"settings.short.newestFirst": "倒序",
			"settings.short.autoOpen": "自动打开",
			"settings.short.autoClose": "自动关闭",
			"settings.short.reveal": "拎到前台",
			"settings.sep": " · ",
			"settings.on": "开",
			"settings.off": "关",
			"settings.save": "保存",
			"settings.saving": "保存中…",
			"settings.saved": "已保存",
			"settings.reset": "恢复默认",
			"settings.resetting": "恢复中…",
			"settings.resetDone": "已恢复默认",
			"settings.storedAt": "设置文件",
			"settings.notStored": "目前的值来自插件配置或内置默认，尚未写入设置文件。",
			"settings.loading": "正在读取设置…",
			"settings.failed": "无法读取设置：连不上插件后端",
			"settings.rejected": "服务器拒绝了这次保存",
			"settings.retry": "重试",
			"settings.note": "这些开关只影响本插件的界面行为，保存后立即生效，不需要重启。",
			"face.open": "查看能力",
			"face.open.aria": "查看 {label} 的工具、技能与人格",
			"face.title": "子智能体能力",
			"face.back": "返回",
			"face.close": "关闭",
			"face.loading": "正在读取该子智能体的日志…",
			"face.failed": "无法读取该子智能体的能力",
			"face.section.profile": "身份与运行配置",
			"face.section.tools": "可用工具",
			"face.section.skills": "技能",
			"face.section.persona": "人格",
			"face.mode": "模式",
			"face.state": "状态",
			"face.launch": "启动方式",
			"face.preset": "预设",
			"face.model": "模型",
			"face.delegatedModel": "委派指定的模型",
			"face.cwd": "工作目录",
			"face.depth": "委派深度",
			"face.created": "创建时间",
			"face.parent": "父会话",
			"face.filter": "工具过滤",
			"face.filter.allow": "允许",
			"face.filter.deny": "排除",
			"face.tools.count": "{count} 个",
			"face.tools.source": "取自它最后一次请求的工具集合。",
			"face.tools.empty": "该子智能体的日志里没有工具快照。",
			"face.tools.params": "参数",
			"face.tools.deferred": "延迟加载",
			"face.skills.count": "{count} 个",
			"face.skills.empty": "该会话的预设与工作目录下没有可见技能。",
			"face.skills.unavailable": "宿主没有挂载技能注册表，无法列出技能。",
			"face.skills.failed": "技能列表读取失败：{error}",
			"face.skills.agentOnly": "仅智能体可调用",
			"face.skills.notDelegated": "这次委派的工具面里没有 skill，所以它看不到任何技能。技能目录只发给手里有 skill 工具的智能体。",
			"face.persona.recorded": "委派记录（权威）",
			"face.persona.inferred": "由系统提示差异推断",
			"face.persona.generated": "按运行模型生成",
			"face.persona.generatedNote": "本次委派没有指派人格，这一行是宿主按该子智能体所用模型填进人格槽位的。",
			"face.persona.replaced": "被它替换掉的父会话人格",
			"face.persona.empty": "日志里没有记录人格：它很可能沿用父会话的组成，或者本次委派没有指派人格。",
			"controls.placeholder": "筛选子智能体",
			"controls.searchAria": "按名称、标题或工作目录筛选子智能体",
			"controls.clear": "清除筛选",
			"filter.all": "全部",
			"filter.inactive": "已结束",
			"filter.oneShot": "仅一次性",
			"filter.empty": "没有符合筛选条件的子智能体。",
			"totals.loaded": "已加载 {count} 个",
			"totals.running": "运行中 {count} 个",
			"totals.tokens": "合计 {value}",
			"totals.duration": "合计 {duration}",
			"totals.none": "没有可统计的子智能体。",
			"totals.partial": "{count} 个没有用量数据",
			"totals.tokensWithSelf": "合计 {value}（本会话 {self}）",
			"totals.selfTitle": "这一屏会话自己用掉的部分，已算进这个合计：命中 {hit} · 写入 {written} · 提示合计 {prompt}（未命中 {missed}）",
			"cache.percent": "缓存命中 {percent}%",
			"cache.exactTitle": "命中 {hit} · 提示合计 {prompt}（未命中 {missed}）",
			"cache.stripTitle": "命中 {hit} · 写入 {written} · 提示合计 {prompt}（未命中 {missed}）",
			"tokens.exactTitle": "合计 {value} tok",
			"tokens.cacheTitle": "合计 {value} tok · 缓存命中 {percent}%",
			"models.fetch": "按模型汇总",
			"models.refetch": "重新汇总",
			"models.hint": "模型只存在于会话日志里，点一下才去读。",
			"models.loading": "正在读取日志…",
			"models.failed": "无法读取模型",
			"models.empty": "没有读到模型信息。",
			"models.unknown": "未知模型",
			"models.unknownNote": "日志里没有模型信息，或该会话的日志没能读到。",
			"models.delegated": "委派指定的模型",
			"models.times": "× {count}",
			"hover.more": "另有 {count} 个未列出",
			"hover.selfTokens": "本会话 {value}",
			"hover.workTime": "总用时 {duration}",
			"hover.workTitle": "模型 {model} · 工具 {tool} · {turns} 轮 · {steps} 步"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"duration.seconds": "{seconds}s",
			"duration.minutes": "{minutes}m {seconds}s",
			"duration.hours": "{hours}h {minutes}m {seconds}s",
			"duration.days": "{days}d",
			"duration.daysHours": "{days}d {hours}h",
			"duration.months": "~{months}mo",
			"duration.monthsDays": "~{months}mo {days}d",
			"duration.years": "~{years}y",
			"duration.yearsMonths": "~{years}y {months}mo",
			"duration.exactDays": "{days}d {hours}h {minutes}m {seconds}s",
			"duration.exactTitle": "Total active duration: {duration}",
			"tokens.thousand": "{value}K",
			"tokens.million": "{value}M",
			"tokens.total": "{value} tok",
			"loading.label": "Loading subagents…",
			"load.error": "Unable to load subagents",
			"retry": "Retry",
			"mode.oneShot": "one-shot",
			"mode.continuable": "continuable",
			"mode.unknown": "unknown mode",
			"activity.running": "running",
			"activity.completed": "completed",
			"activity.inactive": "not running",
			"branch.collapse": "Collapse {label} descendants",
			"branch.expand": "Expand {label} descendants",
			"count.total.one": "{count} subagent",
			"count.total.other": "{count} subagents",
			"count.running.one": "{count} subagent running",
			"count.running.other": "{count} subagents running",
			"switcher.aria": "Switch subagent: {title}",
			"tree.aria": "Subagent sessions",
			"open.sidebar": "Open in sidebar",
			"open.sidebar.aria": "Open {label} in sidebar",
			"settings.nav": "Subagent management",
			"settings.title": "Subagent management",
			"settings.subtitle": "Switches for the catalog order and for the automatic right-sidebar panels. Changes are stored in this plugin's settings file and kept across reloads.",
			"settings.behaviour": "Behaviour",
			"settings.newestFirst": "Order the subagent catalog newest-first",
			"settings.newestFirstHint": "Off restores the shipped order, oldest creation first.",
			"settings.autoOpen": "Open a running subagent in the right sidebar",
			"settings.autoOpenHint": "Only the on-screen session's direct subagents, once per run, so it never steals focus repeatedly.",
			"settings.autoClose": "Close that panel when the subagent ends",
			"settings.autoCloseHint": "A panel you opened by hand closes on the same transition.",
			"settings.reveal": "Bring a background panel forward",
			"settings.revealHint": "Off leaves an already open background panel alone; switch to it yourself.",
			"settings.current": "In effect now",
			"settings.short.newestFirst": "newest-first",
			"settings.short.autoOpen": "auto-open",
			"settings.short.autoClose": "auto-close",
			"settings.short.reveal": "bring forward",
			"settings.sep": " · ",
			"settings.on": "on",
			"settings.off": "off",
			"settings.save": "Save",
			"settings.saving": "Saving…",
			"settings.saved": "Saved",
			"settings.reset": "Restore defaults",
			"settings.resetting": "Restoring…",
			"settings.resetDone": "Defaults restored",
			"settings.storedAt": "Settings file",
			"settings.notStored": "These values come from the plugin config or the built-in defaults; nothing is stored yet.",
			"settings.loading": "Reading settings…",
			"settings.failed": "Could not read the settings: the plugin backend is unreachable",
			"settings.rejected": "The server rejected this save",
			"settings.retry": "Retry",
			"settings.note": "These switches only steer this plugin's UI; a save takes effect at once and needs no restart.",
			"face.open": "View capabilities",
			"face.open.aria": "View the tools, skills and persona of {label}",
			"face.title": "Subagent capabilities",
			"face.back": "Back",
			"face.close": "Close",
			"face.loading": "Reading this subagent's log…",
			"face.failed": "Could not read this subagent's capabilities",
			"face.section.profile": "Identity and run",
			"face.section.tools": "Tools",
			"face.section.skills": "Skills",
			"face.section.persona": "Persona",
			"face.mode": "Mode",
			"face.state": "State",
			"face.launch": "Spawned by",
			"face.preset": "Preset",
			"face.model": "Model",
			"face.delegatedModel": "Delegated model",
			"face.cwd": "Working directory",
			"face.depth": "Delegation depth",
			"face.created": "Created",
			"face.parent": "Parent session",
			"face.filter": "Tool filter",
			"face.filter.allow": "allow",
			"face.filter.deny": "deny",
			"face.tools.count": "{count} tools",
			"face.tools.source": "Taken from the tool set of its last request.",
			"face.tools.empty": "This subagent's log holds no tool snapshot.",
			"face.tools.params": "parameters",
			"face.tools.deferred": "deferred",
			"face.skills.count": "{count} skills",
			"face.skills.empty": "No skill is visible under this session's preset and working directory.",
			"face.skills.unavailable": "The host has no skill registry mounted, so skills cannot be listed.",
			"face.skills.failed": "Could not list skills: {error}",
			"face.skills.agentOnly": "agent-only",
			"face.skills.notDelegated": "This delegation's tool face has no skill, so the subagent sees no skills at all. The catalogue is published only to an agent holding the skill tool.",
			"face.persona.recorded": "Delegation record (authoritative)",
			"face.persona.inferred": "Inferred from the system-prompt difference",
			"face.persona.generated": "Filled in from the run model",
			"face.persona.generatedNote": "This delegation named no persona; that line is the one the host wrote into the persona slot from the model this subagent ran on.",
			"face.persona.replaced": "The parent persona it replaced",
			"face.persona.empty": "No persona in the log: this subagent most likely inherits its parent's composition, or the delegation assigned none.",
			"controls.placeholder": "Filter subagents",
			"controls.searchAria": "Filter subagents by name, title, or working directory",
			"controls.clear": "Clear filter",
			"filter.all": "All",
			"filter.inactive": "Finished",
			"filter.oneShot": "One-shot only",
			"filter.empty": "No subagent matches the filter.",
			"totals.loaded": "{count} loaded",
			"totals.running": "{count} running",
			"totals.tokens": "{value} total",
			"totals.duration": "{duration} total",
			"totals.none": "Nothing to total yet.",
			"totals.partial": "{count} without usage data",
			"totals.tokensWithSelf": "{value} total ({self} here)",
			"totals.selfTitle": "What this on-screen session spent itself, already counted in this total: hit {hit} · written {written} · prompt {prompt} (missed {missed})",
			"cache.percent": "Cache hit {percent}%",
			"cache.exactTitle": "Hit {hit} · prompt {prompt} (missed {missed})",
			"cache.stripTitle": "Hit {hit} · written {written} · prompt {prompt} (missed {missed})",
			"tokens.exactTitle": "{value} tok total",
			"tokens.cacheTitle": "{value} tok total · cache hit {percent}%",
			"models.fetch": "Total by model",
			"models.refetch": "Total again",
			"models.hint": "A model lives only in the session logs, so this reads them on demand.",
			"models.loading": "Reading logs…",
			"models.failed": "Could not read the models",
			"models.empty": "No model was reported.",
			"models.unknown": "Unknown model",
			"models.unknownNote": "The log holds no model, or that session's log could not be read.",
			"models.delegated": "Model named by the delegation",
			"models.times": "× {count}",
			"hover.more": "{count} more not listed",
			"hover.selfTokens": "{value} here",
			"hover.workTime": "worked for {duration}",
			"hover.workTitle": "model {model} · tools {tool} · {turns} turns · {steps} steps"
		};

		//#region shared helpers
		/**
		 * Join the truthy class names of one element.
		 * @param values - class names or falsy placeholders.
		 * @returns the class attribute value.
		 */
		function classNames(...values) {
			return values.filter(Boolean).join(" ");
		}
		/**
		 * Collect the focusable tree rows of one menu.
		 * @param root - the scrolling tree container, or null.
		 * @returns the enabled tree items in document order.
		 */
		function treeItems(root) {
			return root === null ? [] : Array.from(root.querySelectorAll("[role=\"treeitem\"]:not([aria-disabled=\"true\"])"));
		}
		/**
		 * Compact token count shared in shape with the conversation stats strip.
		 * @param value - total tokens.
		 * @param t - translate function.
		 * @returns the display string.
		 */
		function formatTokens(value, t) {
			const scaled = (next) => next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return t("tokens.thousand", { value: scaled(value / 1e3) });
			return t("tokens.million", { value: scaled(value / 1e6) });
		}
		/**
		 * Sum the four disjoint durable provider-usage buckets.
		 * @param usage - the session's token usage projection, if any.
		 * @returns the total, or undefined without usage.
		 */
		function tokenTotal(usage) {
			return usage === undefined ? undefined : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		/**
		 * Sum the three disjoint prompt-side billing buckets: input the provider
		 * billed fresh, input served from cache, and input written to the cache.
		 * Cache reads are the cheap ones, so this is the denominator a cache-hit
		 * share is measured against; output tokens are never prompt-side input.
		 * @param usage - the session's token usage projection, if any.
		 * @returns billed prompt tokens, or undefined without usage.
		 */
		function billedInputTokens(usage) {
			if (usage === undefined || usage === null) return undefined;
			const buckets = [usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
			return buckets.reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
		}
		/**
		 * Display-ready cache-hit share of prompt-side input. A partial hit never
		 * reads as a full one: when integer rounding would reach 100, the answer
		 * keeps just enough decimals to stay below it, and a complete hit is
		 * exactly 100. Nothing billed at all has no share to show.
		 * @param cacheReadTokens - prompt tokens served from cache.
		 * @param promptTokens - billed prompt tokens.
		 * @returns percent text, or null when nothing was billed.
		 */
		function cacheHitPercent(cacheReadTokens, promptTokens) {
			if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens <= 0) return null;
			const read = typeof cacheReadTokens === "number" && Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0;
			if (read >= promptTokens) return "100";
			for (let places = 0; places <= 3; places += 1) {
				const factor = 10 ** places;
				const percent = Math.round(read * 100 * factor / promptTokens) / factor;
				if (percent < 100) return percent.toFixed(places);
			}
			return "99.9";
		}
		/**
		 * Group an exact token count for a tooltip, where the compact form is too
		 * coarse to check a number against a log.
		 * @param value - an exact token count.
		 * @returns the count with grouped thousands.
		 */
		function formatExactTokens(value) {
			return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : String(value ?? 0);
		}
		/**
		 * Exact whole-second active-turn duration for one catalog row.
		 * @param summary - the child session summary, if it exists.
		 * @param activity - "running" or "inactive".
		 * @param now - sampled wall clock for a running child.
		 * @returns the active duration in milliseconds, or undefined without timing.
		 */
		function activityDuration(summary, activity, now) {
			if (summary === undefined) return undefined;
			const timing = summary.projectionValues?.subagentTiming;
			if (timing === undefined) return undefined;
			if (timing.active === undefined) return timing.settledMs;
			const end = activity === "running" ? now : timing.active.through;
			return timing.settledMs + Math.max(0, end - timing.active.since);
		}
		/**
		 * Split a duration into its calendar parts.
		 * @param ms - duration in milliseconds.
		 * @returns the parts plus their unrolled totals.
		 */
		function splitDuration(ms) {
			const totalSeconds = Math.floor(Math.max(0, ms) / 1e3);
			const totalMinutes = Math.floor(totalSeconds / 60);
			const totalHours = Math.floor(totalMinutes / 60);
			return {
				seconds: totalSeconds % 60,
				minutes: totalMinutes % 60,
				hours: totalHours % 24,
				days: Math.floor(totalHours / 24),
				totalMinutes,
				totalHours
			};
		}
		/**
		 * Format a duration with decreasing visual precision at larger scales.
		 * @param ms - duration in milliseconds.
		 * @param t - translate function.
		 * @returns the compact display string.
		 */
		function formatDuration(ms, t) {
			const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms);
			if (days >= 365) {
				const years = Math.floor(days / 365);
				const months = Math.floor(days % 365 / 30);
				return months === 0 ? t("duration.years", { years }) : t("duration.yearsMonths", { years, months });
			}
			if (days >= 30) {
				const months = Math.floor(days / 30);
				const remainingDays = days % 30;
				return remainingDays === 0 ? t("duration.months", { months }) : t("duration.monthsDays", { months, days: remainingDays });
			}
			if (days > 0) return hours === 0 ? t("duration.days", { days }) : t("duration.daysHours", { days, hours });
			if (totalHours > 0) return t("duration.hours", {
				hours: totalHours,
				minutes: String(minutes).padStart(2, "0"),
				seconds: String(seconds).padStart(2, "0")
			});
			if (totalMinutes > 0) return t("duration.minutes", {
				minutes: totalMinutes,
				seconds: String(seconds).padStart(2, "0")
			});
			return t("duration.seconds", { seconds });
		}
		/**
		 * Preserve exact whole seconds for hover and accessible naming.
		 * @param ms - duration in milliseconds.
		 * @param t - translate function.
		 * @returns the exact display string.
		 */
		function formatExactDuration(ms, t) {
			const { seconds, minutes, hours, days } = splitDuration(ms);
			return days === 0 ? formatDuration(ms, t) : t("duration.exactDays", {
				days,
				hours: String(hours).padStart(2, "0"),
				minutes: String(minutes).padStart(2, "0"),
				seconds: String(seconds).padStart(2, "0")
			});
		}
		/**
		 * Read one session's catalog snapshot from the client stores.
		 * @param sessionId - session whose direct children are listed.
		 * @param projections - the list store's projection snapshots.
		 * @param summaries - the list store's session summaries.
		 * @returns the catalog view, or undefined while nothing is retained.
		 */
		function catalogOf(sessionId, projections, summaries) {
			const snapshot = projections?.[sessionId];
			if (snapshot !== undefined && snapshot !== null) {
				const values = snapshot.values ?? {};
				const state = snapshot.state === "idle" ? values.subagentCatalog === undefined ? "loading" : "ready" : snapshot.state;
				return { state, error: snapshot.error, entries: values.subagentCatalog ?? [] };
			}
			const values = summaries?.[sessionId]?.projectionValues;
			if (values === undefined) return undefined;
			return { state: values.subagentCatalog === undefined ? "loading" : "ready", entries: values.subagentCatalog ?? [] };
		}
		/**
		 * A child becomes a known leaf only after its own authoritative catalog loads empty.
		 * @param catalog - the child's catalog view, if loaded.
		 * @returns whether the child certainly has no children.
		 */
		function isKnownLeaf(catalog) {
			return catalog?.state === "ready" && catalog.entries.length === 0;
		}
		/**
		 * Resolve one child's activity from the live status store, then the list row.
		 * @param childSessionId - child session identity.
		 * @param summaries - the list store's session summaries.
		 * @param statuses - the unified session status snapshot.
		 * @returns "running" or "inactive".
		 */
		function activityOf(childSessionId, summaries, statuses) {
			const status = statuses === undefined ? undefined : statuses.get(childSessionId);
			const running = status?.running ?? summaries[childSessionId]?.running;
			return running === true ? "running" : "inactive";
		}
		/**
		 * Whether any control is narrowing the tree.
		 * @param filter - the current filter draft.
		 * @returns whether a filter is in force.
		 */
		function filterActive(filter) {
			return filter.text !== "" || filter.activity !== "all" || filter.oneShot === true;
		}
		/**
		 * Whether one row passes the active filter on its own fields.
		 * @param entry - one catalog entry.
		 * @param filter - the active filter.
		 * @param summaries - the list store's session summaries.
		 * @param statuses - the unified session status snapshot.
		 * @returns whether the row itself matches.
		 */
		function entryMatches(entry, filter, summaries, statuses) {
			if (filter.activity !== "all") {
				const running = activityOf(entry.id, summaries, statuses) === "running";
				if (running !== (filter.activity === "running")) return false;
			}
			if (filter.oneShot === true && entry.mode !== "one-shot") return false;
			if (filter.text === "") return true;
			const needle = filter.text.toLowerCase();
			const summary = summaries[entry.id];
			return [entry.label ?? "", entry.id, summary?.title ?? "", summary?.cwd ?? ""]
				.some((value) => value.toLowerCase().includes(needle));
		}
		/**
		 * Whether one row, or any already loaded descendant of it, matches. Only
		 * loaded branches are walked: a branch that was never fetched cannot be
		 * searched, and claiming otherwise would hide rows silently.
		 * @param entry - one catalog entry.
		 * @param filter - the active filter.
		 * @param projections - the list store's projection snapshots.
		 * @param summaries - the list store's session summaries.
		 * @param statuses - the unified session status snapshot.
		 * @param seen - ids already walked, shared across one filter pass.
		 * @returns whether the row survives the filter.
		 */
		function subtreeMatches(entry, filter, projections, summaries, statuses, seen) {
			if (entryMatches(entry, filter, summaries, statuses)) return true;
			const visited = seen ?? new Set();
			if (visited.has(entry.id)) return false;
			visited.add(entry.id);
			const child = catalogOf(entry.id, projections, summaries);
			if (child === undefined) return false;
			for (const nested of child.entries ?? []) {
				if (nested === null || typeof nested !== "object" || typeof nested.id !== "string") continue;
				if (subtreeMatches(nested, filter, projections, summaries, statuses, visited)) return true;
			}
			return false;
		}
		/**
		 * Total every loaded row under one catalog view, filter applied. Collapsing
		 * a branch hides it without unloading it, so the totals do not move when a
		 * branch is opened or closed. Rows whose projections have not arrived are
		 * counted as unknown rather than as zero.
		 * @param catalog - the catalog view to walk.
		 * @param filter - the active filter, or undefined when nothing is filtered.
		 * @param projections - the list store's projection snapshots.
		 * @param summaries - the list store's session summaries.
		 * @param statuses - the unified session status snapshot.
		 * @param now - sampled wall clock for running children.
		 * @param selfId - the session this tree hangs off, counted too, or undefined.
		 * @returns the totals, one node entry per counted row, and `self` when the
		 *   session itself was counted (it is not a row of this tree).
		 */
		function catalogTotals(catalog, filter, projections, summaries, statuses, now, selfId) {
			const totals = {
				count: 0, running: 0, tokens: 0, durationMs: 0, unknownTokens: 0, unknownDuration: 0,
				cacheRead: 0, cacheWrite: 0, billedInput: 0, nodes: [], self: null
			};
			const seen = new Set();
			/**
			 * Fold one session's usage into the totals. The rows of the tree and the
			 * session the tree hangs off run through the same arithmetic, so their
			 * numbers cannot drift apart; only the row count treats them differently.
			 * @param id - the session whose usage is counted.
			 * @param activity - "running" or "inactive".
			 * @param asRow - whether this session is a row of the tree.
			 * @returns the node the model grouping reads.
			 */
			const account = (id, activity, asRow) => {
				const summary = summaries[id];
				const usageValue = summary?.projectionValues?.tokenUsage;
				const tokens = tokenTotal(usageValue);
				const billed = billedInputTokens(usageValue);
				const cacheRead = typeof usageValue?.cacheReadTokens === "number" ? usageValue.cacheReadTokens : 0;
				const cacheWrite = typeof usageValue?.cacheWriteTokens === "number" ? usageValue.cacheWriteTokens : 0;
				const durationMs = activityDuration(summary, activity, now);
				if (asRow) {
					totals.count += 1;
					if (activity === "running") totals.running += 1;
				}
				if (tokens === undefined) totals.unknownTokens += 1;
				else totals.tokens += tokens;
				if (billed !== undefined) totals.billedInput += billed;
				totals.cacheRead += cacheRead;
				totals.cacheWrite += cacheWrite;
				if (durationMs === undefined) totals.unknownDuration += 1;
				else totals.durationMs += Math.max(0, durationMs);
				return {
					id, tokens: tokens ?? 0, running: activity === "running",
					cacheRead, cacheWrite, billedInput: billed ?? 0
				};
			};
			// The session the tree hangs off is not one of its own rows — you are
			// looking at it — but it spends its tokens in the same place, so it is
			// counted first, under the same filter rule as the rows: it has no mode,
			// so the one-shot chip leaves it out, and it never joins `count`.
			if (selfId !== undefined && summaries[selfId] !== undefined
				&& (filter === undefined || entryMatches({ id: selfId }, filter, summaries, statuses))) {
				seen.add(selfId);
				totals.self = account(selfId, activityOf(selfId, summaries, statuses), false);
				totals.nodes.push(totals.self);
			}
			const walk = (view) => {
				for (const entry of view?.entries ?? []) {
					if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
					if (seen.has(entry.id)) continue;
					seen.add(entry.id);
					if (filter !== undefined && !subtreeMatches(entry, filter, projections, summaries, statuses)) continue;
					totals.nodes.push(account(entry.id, activityOf(entry.id, summaries, statuses), true));
					walk(catalogOf(entry.id, projections, summaries));
				}
			};
			walk(catalog);
			return totals;
		}
		/**
		 * Name the model one batch answer reports: what the run actually used,
		 * else what the delegation asked for, else nothing.
		 * @param answer - one entry of the model batch, if it covered this id.
		 * @returns the model identity, or null when nothing names one.
		 */
		function modelOf(answer) {
			if (answer === undefined || answer.state !== "ok") return null;
			if (answer.model !== null && answer.model !== undefined) {
				return { key: `${answer.provider ?? ""}/${answer.model}`, name: answer.model, provider: answer.provider ?? null, delegated: false };
			}
			if (answer.agentModel !== null && answer.agentModel !== undefined) {
				return { key: `${answer.agentProvider ?? ""}/${answer.agentModel}`, name: answer.agentModel, provider: answer.agentProvider ?? null, delegated: true };
			}
			return null;
		}
		/**
		 * Group counted rows by the model behind them, largest first. Ids the batch
		 * never answered for are reported separately, so the total can admit that
		 * it is incomplete instead of inventing a model.
		 * @param nodes - one entry per counted row, with its summed tokens.
		 * @param models - session id → model batch answer.
		 * @returns the groups, plus how many rows the batch did not answer for.
		 */
		function groupModels(nodes, models) {
			const groups = new Map();
			let unanswered = 0;
			for (const node of nodes) {
				if (!models.has(node.id)) unanswered += 1;
				const model = modelOf(models.get(node.id));
				const key = model === null ? null : model.key;
				const group = groups.get(key) ?? { model, count: 0, tokens: 0, running: 0, cacheRead: 0, billedInput: 0 };
				group.count += 1;
				group.tokens += node.tokens;
				if (node.running) group.running += 1;
				group.cacheRead += typeof node.cacheRead === "number" ? node.cacheRead : 0;
				group.billedInput += typeof node.billedInput === "number" ? node.billedInput : 0;
				groups.set(key, group);
			}
			const ordered = [...groups.values()].sort((left, right) =>
				right.tokens - left.tokens
				|| right.count - left.count
				|| (left.model?.name ?? "").localeCompare(right.model?.name ?? ""));
			return { groups: ordered, unanswered };
		}
		/**
		 * Order catalog entries newest-first, breaking ties by the newest event.
		 * @param entries - the projection's catalog entries.
		 * @returns a new array, newest first.
		 */
		function sortNewestFirst(entries) {
			return entries.map((entry, index) => ({ entry, index })).sort((left, right) => {
				const leftCreated = typeof left.entry?.createdAt === "number" ? left.entry.createdAt : 0;
				const rightCreated = typeof right.entry?.createdAt === "number" ? right.entry.createdAt : 0;
				return rightCreated - leftCreated || right.index - left.index;
			}).map((wrapped) => wrapped.entry);
		}
		/**
		 * Build the address the sidebar subagent chat provider claims.
		 * @param parentSessionId - parent session identity.
		 * @param childSessionId - subagent session identity.
		 * @param mode - catalog mode of the child.
		 * @returns the resource address.
		 */
		function chatAddress(parentSessionId, childSessionId, mode) {
			const query = new URLSearchParams({ parent: parentSessionId, mode: mode === undefined ? "unknown" : mode });
			return CHAT_PREFIX + encodeURIComponent(childSessionId) + "?" + query.toString();
		}
		/**
		 * Recover the child identity a subagent panel address was opened for.
		 *
		 * Matching on the identity instead of the whole address means a panel the
		 * shipped dropdown opened stays recognised even when its `mode` differs
		 * (that dropdown reads the mode from the discovered address, not from the
		 * catalog entry), so this plugin never opens a second panel for it.
		 * @param contentId - a tab's content identity.
		 * @returns the child session identity, or undefined for a foreign tab.
		 */
		function panelChildId(contentId) {
			if (typeof contentId !== "string" || !contentId.startsWith(CHAT_PREFIX)) return void 0;
			const rest = contentId.slice(CHAT_PREFIX.length);
			const query = rest.indexOf("?");
			const encoded = query < 0 ? rest : rest.slice(0, query);
			if (encoded === "") return void 0;
			try {
				return decodeURIComponent(encoded);
			} catch {
				return void 0;
			}
		}
		/** Pin the loader's CSS animations to document time zero so dots stay in phase. */
		function syncSpinner(element) {
			if (element === null) return;
			for (const animation of element.getAnimations?.({ subtree: true }) ?? []) animation.startTime = 0;
		}
		/**
		 * Render the breadcrumb switcher glyph (ported from the shipped lineage).
		 * @returns the up/down chevron pair of a sibling switcher.
		 */
		function SwitcherIcon() {
			return h("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": "true"
			},
				h("path", {
					d: "M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.5989 15.2859 11.0436 14.9478L13.9995 12.7",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}),
				h("path", {
					d: "M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}));
		}
		/**
		 * Render a state dot (ported from the primitives' StateDot).
		 * @param props.state - "ongoing", "done" or "idle".
		 * @param props.size - outer diameter in px; defaults to 14 for ongoing and 10 for solid states.
		 * @param props.className - optional extra layout class.
		 * @returns the dot element.
		 */
		function StateDot({ state, size, className }) {
			const edge = size ?? (state === "ongoing" ? 14 : 10);
			if (state === "ongoing") return h("svg", {
				ref: syncSpinner,
				className: classNames("smgm-spinner", className),
				"data-state": "ongoing",
				width: edge,
				height: edge,
				viewBox: "0 0 24 24",
				"aria-hidden": "true"
			}, h("g", { className: "smgm-spinnerMotion" },
				h("circle", { className: "smgm-spinnerTrack", cx: "12", cy: "12", r: "9.5" }),
				h("circle", { className: "smgm-spinnerArc", cx: "12", cy: "12", r: "9.5" })));
			return h("span", {
				className: classNames("smgm-dot", className),
				"data-state": state,
				"aria-hidden": "true",
				style: { width: edge, height: edge }
			});
		}
		/**
		 * Render one chevron glyph.
		 * @param props.pointsRight - draw a right chevron instead of a down chevron.
		 * @returns the svg element.
		 */
		function Chevron({ pointsRight }) {
			return h("svg", {
				width: "12",
				height: "12",
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true"
			}, h("path", {
				d: pointsRight ? "M9 5l6 7-6 7" : "M5 9l7 6 7-6",
				stroke: "currentColor",
				strokeWidth: "2",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/** Render the sidebar affordance glyph. */
		function SidebarGlyph() {
			return h("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true"
			}, h("rect", {
				x: "3",
				y: "4",
				width: "18",
				height: "16",
				rx: "2.5",
				stroke: "currentColor",
				strokeWidth: "1.8"
			}), h("path", { d: "M15 4.8v14.4", stroke: "currentColor", strokeWidth: "1.8" }));
		}
		/**
		 * Render catalog loading without inventing child membership.
		 * @param props.t - translate function.
		 * @returns the notice row.
		 */
		function CatalogLoadingRows({ t }) {
			return h("div", { className: "smgm-notice" }, t("loading.label"));
		}
		//#endregion
		//#region catalog tree
		/**
		 * Render one catalog level and recurse only through explicitly expanded rows.
		 * @param props.parentSessionId - session owning these children.
		 * @param props.currentSessionId - session whose conversation is on screen.
		 * @param props.catalog - this level's catalog view.
		 * @param props.projections - the list store's projection snapshots.
		 * @param props.summaries - the list store's session summaries.
		 * @param props.statuses - the unified session status snapshot.
		 * @param props.expanded - ids whose branch is open.
		 * @param props.level - 1-based tree level.
		 * @param props.openChild - open a child in the main column.
		 * @param props.openChildAside - open a child in the right column.
		 * @param props.refreshProjection - retry one session's projections.
		 * @param props.toggleBranch - expand or collapse one branch.
		 * @param props.closeCatalog - dismiss the menu.
		 * @param props.t - translate function.
		 * @returns the rendered rows.
		 */
		function CatalogRows({ parentSessionId, currentSessionId, catalog, projections, summaries, statuses, expanded, level, openChild, openChildAside, refreshProjection, toggleBranch, closeCatalog, inspectFace, filter, t }) {
			const [now, setNow] = useState(() => Date.now());
			const settings = useSettings();
			const entries = catalog?.entries ?? [];
			const filtering = filter !== undefined;
			const ordered = settings.newestFirst ? sortNewestFirst(entries) : entries;
			const rows = filtering
				? ordered.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string"
					&& subtreeMatches(entry, filter, projections, summaries, statuses))
				: ordered;
			const anyRunning = rows.some((entry) => activityOf(entry.id, summaries, statuses) === "running");
			useEffect(() => {
				if (!anyRunning) return undefined;
				const timer = setInterval(() => setNow(Date.now()), 1e3);
				return () => clearInterval(timer);
			}, [anyRunning]);
			const reserveDisclosure = rows.some((entry) => !isKnownLeaf(catalogOf(entry.id, projections, summaries)));

			if (catalog.state === "error") return h("div", { className: "smgm-error" },
				h("span", null, t("load.error")),
				h("button", {
					type: "button",
					className: "smgm-refresh",
					onClick: () => refreshProjection(parentSessionId)
				}, t("retry")));
			if (catalog.state === "loading" && rows.length === 0) return h(CatalogLoadingRows, { t });
			if (filtering && rows.length === 0) return level === 1 ? h("div", { className: "smgm-filterEmpty" }, t("filter.empty")) : null;

			return h(React.Fragment, null, rows.map((entry) => {
				if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") return null;
				const childCatalog = catalogOf(entry.id, projections, summaries);
				const knownLeaf = isKnownLeaf(childCatalog);
				const isCurrent = entry.id === currentSessionId;
				const summary = summaries[entry.id];
				const label = entry.label ?? entry.id;
				const activity = activityOf(entry.id, summaries, statuses);
				const completed = activity === "inactive" && summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true;
				const mode = entry.mode === "unknown" ? t("mode.unknown") : entry.mode === "one-shot" ? t("mode.oneShot") : t("mode.continuable");
				const activityLabel = activity === "running" ? t("activity.running") : completed ? t("activity.completed") : t("activity.inactive");
				const secondary = [summary?.title, mode, activityLabel].filter((value) => value !== undefined).join(" · ");
				const usageValue = summary?.projectionValues?.tokenUsage;
				const totalTokens = tokenTotal(usageValue);
				const tokenMetric = totalTokens === undefined ? undefined : t("tokens.total", { value: formatTokens(totalTokens, t) });
				const rowCacheHit = cacheHitPercent(usageValue?.cacheReadTokens, billedInputTokens(usageValue));
				const durationMs = activityDuration(summary, activity, now);
				const durationMetric = durationMs === undefined ? undefined : {
					compact: formatDuration(durationMs, t),
					exact: formatExactDuration(durationMs, t)
				};
				const metrics = [tokenMetric, durationMetric?.exact].filter((value) => value !== undefined).join(" · ");
				const isExpanded = expanded.has(entry.id) || filtering;
				const open = () => {
					openChild({ parentSessionId, childSessionId: entry.id, mode: entry.mode });
					closeCatalog();
				};
				const openAside = (event) => {
					event.preventDefault();
					event.stopPropagation();
					openChildAside({ parentSessionId, childSessionId: entry.id, mode: entry.mode });
					closeCatalog();
				};
				const onKeyDown = (event) => {
					if (knownLeaf || filtering) return;
					if (event.key === "ArrowRight" && !isExpanded) {
						event.preventDefault();
						toggleBranch(entry.id);
					} else if (event.key === "ArrowLeft" && isExpanded) {
						event.preventDefault();
						toggleBranch(entry.id);
					}
				};
				const ariaLabel = [label, secondary, metrics].filter((value) => value !== undefined && value !== "").join(" ");
				const row = h("div", {
					role: "treeitem",
					tabIndex: 0,
					"aria-level": level,
					"aria-current": isCurrent ? "true" : undefined,
					"aria-label": ariaLabel,
					"aria-expanded": knownLeaf ? undefined : isExpanded ? "true" : "false",
					className: "smgm-row",
					onClick: open,
					onKeyDown
				},
					knownLeaf
						? reserveDisclosure ? h("span", { className: "smgm-disclosureSpace" }) : null
						: filtering
							? h("span", { className: "smgm-disclosure smgm-disclosureOpen" }, h(Chevron, {}))
							: h("button", {
							type: "button",
							className: classNames("smgm-disclosure", isExpanded && "smgm-disclosureOpen"),
							"aria-label": t(isExpanded ? "branch.collapse" : "branch.expand", { label }),
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								toggleBranch(entry.id);
							}
						}, h(Chevron, { pointsRight: !isExpanded })),
					h("div", { className: "smgm-clickarea" },
						h("span", { className: "smgm-rowActivitySlot" }, h(StateDot, { state: activity === "running" ? "ongoing" : completed ? "done" : "idle" })),
						h("span", { className: "smgm-content" },
							h("span", { className: classNames("smgm-label", isCurrent && "smgm-currentLabel") }, label),
							h("span", { className: "smgm-summary" }, secondary)),
						h("span", { className: "smgm-metrics" },
							h("span", {
								className: "smgm-metricToken",
								title: tokenMetric === undefined ? undefined
									: rowCacheHit === null ? t("tokens.exactTitle", { value: formatExactTokens(totalTokens) })
										: t("tokens.cacheTitle", { value: formatExactTokens(totalTokens), percent: rowCacheHit })
							}, tokenMetric ?? ""),
							h("span", {
								className: "smgm-metricDuration",
								title: durationMetric === undefined ? undefined : t("duration.exactTitle", { duration: durationMetric.exact })
							}, durationMetric?.compact ?? "")),
						h("button", {
							type: "button",
							className: "smgm-faceButton",
							title: t("face.open"),
							"aria-label": t("face.open.aria", { label }),
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								inspectFace(entry.id, label, activity === "running");
							}
						}, h(FaceGlyph)),
						isCurrent ? null : h("button", {
							type: "button",
							className: "smgm-sidebarButton",
							title: t("open.sidebar"),
							"aria-label": t("open.sidebar.aria", { label }),
							onClick: openAside
						}, h(SidebarGlyph))));
				const children = isExpanded ? h("div", {
					role: "group",
					className: "smgm-children",
					"aria-busy": childCatalog === undefined ? "true" : undefined
				}, childCatalog === undefined ? h(CatalogLoadingRows, { t }) : h(CatalogRows, {
					parentSessionId,
					currentSessionId,
					catalog: childCatalog,
					projections,
					summaries,
					statuses,
					expanded,
					level: level + 1,
					openChild,
					openChildAside,
					refreshProjection,
					toggleBranch,
					closeCatalog,
					inspectFace,
					filter,
					t
				})) : null;
				return h("div", { className: "smgm-node", key: entry.id }, row, children);
			}));
		}
		//#endregion
		//#region filter and totals
		/**
		 * The filter row above the tree: a free-text box plus running/finished and
		 * one-shot-only switches. The controls narrow what is already loaded and
		 * never start a fetch, so a filter can hide rows but never discover one.
		 * @param t - the translator.
		 * @param filter - the active filter.
		 * @param onChange - receives a partial filter patch.
		 * @returns the row.
		 */
		function CatalogControls({ t, filter, onChange }) {
			const chip = (label, active, onClick) => h("button", {
				type: "button",
				className: classNames("smgm-chip", active && "smgm-chipOn"),
				"aria-pressed": active ? "true" : "false",
				onClick
			}, label);
			return h("div", { className: "smgm-controls" },
				h("input", {
					type: "search",
					className: "smgm-search",
					value: filter.text,
					placeholder: t("controls.placeholder"),
					"aria-label": t("controls.searchAria"),
					onKeyDown: (event) => event.stopPropagation(),
					onChange: (event) => onChange({ text: event.target.value })
				}),
				h("div", { className: "smgm-chips" },
					chip(t("filter.all"), filter.activity === "all", () => onChange({ activity: "all" })),
					chip(t("filter.inactive"), filter.activity === "inactive", () => onChange({ activity: "inactive" })),
					chip(t("filter.oneShot"), filter.oneShot === true, () => onChange({ oneShot: filter.oneShot !== true })),
					filterActive(filter) ? h("button", {
						type: "button",
						className: "smgm-chip smgm-chipClear",
						title: t("controls.clear"),
						"aria-label": t("controls.clear"),
						onClick: () => onChange({ text: "", activity: "all", oneShot: false })
					}, h("span", { "aria-hidden": "true" }, "\u00d7")) : null));
		}
		/**
		 * The totals strip under the controls, laid out as one line of counts and
		 * one line of usage so neither wraps into the other: rows loaded, rows
		 * running and rows without usage data, then summed tokens (the session on
		 * screen among them), the cache-hit share of prompt-side input, and wall
		 * time — then, on request, those same rows grouped by the model behind them,
		 * each group carrying its own share. The totals cover, and name beside them,
		 * the session this tree hangs off: it is the one session here whose usage is
		 * never a row. A model is named only inside a session
		 * log, so that grouping is read on demand instead of watched.
		 * @param t - the translator.
		 * @param totals - totals over every loaded row under the active filter, plus
		 *   the on-screen session's own usage as `totals.self`.
		 * @param nodes - one entry per counted row, for the model grouping; the
		 * @param models - session id → model batch answer.
		 * @param modelState - "idle" | "loading" | "ready" | "error".
		 * @param onFetchModels - loads or reloads the model batch.
		 * @returns the strip.
		 */
		function CatalogSummary({ t, totals, nodes, models, modelState, onFetchModels }) {
			const { groups } = useMemo(() => groupModels(nodes, models), [nodes, models]);
			// The session on screen is counted too, so an empty tree still has
			// numbers: only "nothing at all was counted" is nothing to show.
			if (totals.count === 0 && totals.self === null) return h("div", { className: "smgm-totals" },
				h("span", { className: "smgm-summaryHint" }, t("totals.none")));
			const partial = totals.unknownTokens === 0 ? null : h("span", { className: "smgm-summaryHint" },
				t("totals.partial", { count: totals.unknownTokens }));
			const cacheHit = cacheHitPercent(totals.cacheRead, totals.billedInput);
			const shareTitle = (hit, read, billed) => t("cache.exactTitle", {
				hit: formatExactTokens(read),
				prompt: formatExactTokens(billed),
				missed: formatExactTokens(Math.max(0, billed - read))
			});
			const cacheItem = cacheHit === null ? null : h("span", {
				className: "smgm-totalsItem",
				title: t("cache.stripTitle", {
					hit: formatExactTokens(totals.cacheRead),
					written: formatExactTokens(totals.cacheWrite),
					prompt: formatExactTokens(totals.billedInput),
					missed: formatExactTokens(Math.max(0, totals.billedInput - totals.cacheRead))
				})
			}, t("cache.percent", { percent: cacheHit }));
			// Naming the session's own share inside the token item, rather than as a
			// further item, is what keeps the usage line to two lines in a 336px menu
			// while the totals stay readable: the aggregate includes it and says by
			// how much, and the hover text keeps the exact split.
			const selfShare = totals.self === null ? null : t("totals.selfTitle", {
				hit: formatExactTokens(totals.self.cacheRead),
				written: formatExactTokens(totals.self.cacheWrite),
				prompt: formatExactTokens(totals.self.billedInput),
				missed: formatExactTokens(Math.max(0, totals.self.billedInput - totals.self.cacheRead))
			});
			const totalsItem = selfShare === null
				? h("span", { className: "smgm-totalsItem" }, t("totals.tokens", { value: formatTokens(totals.tokens, t) }))
				: h("span", { className: "smgm-totalsItem", title: selfShare },
					t("totals.tokensWithSelf", {
						value: formatTokens(totals.tokens, t),
						self: formatTokens(totals.self.tokens, t)
					}));
			const groupsBody = groups.length === 0 ? h("span", { className: "smgm-summaryHint" }, t("models.empty"))
				: groups.map((group) => {
					const share = cacheHitPercent(group.cacheRead, group.billedInput);
					return h("div", { className: "smgm-modelRow", key: group.model === null ? "unknown" : group.model.key },
						h("span", {
							className: "smgm-modelName",
							title: group.model === null ? t("models.unknownNote")
								: group.model.delegated ? t("models.delegated") : group.model.key
						}, group.model === null ? t("models.unknown") : group.model.name),
						group.model?.delegated === true ? h("span", { className: "smgm-summaryHint" }, t("models.delegated")) : null,
						h("span", { className: "smgm-totalsItem" }, t("totals.tokens", { value: formatTokens(group.tokens, t) })),
						share === null ? null : h("span", {
							className: "smgm-totalsItem",
							title: shareTitle(share, group.cacheRead, group.billedInput)
						}, t("cache.percent", { percent: share })),
						h("span", { className: "smgm-summaryHint" }, t("models.times", { count: group.count })));
				});
			const modelsBody = modelState === "loading" ? h("span", { className: "smgm-summaryHint" }, t("models.loading"))
				: modelState === "error" ? h("span", { className: "smgm-modelError" }, t("models.failed"))
					: modelState === "ready" ? h("div", { className: "smgm-models" }, groupsBody)
						: null;
			return h(React.Fragment, null,
				h("div", { className: "smgm-totals" },
					h("span", { className: "smgm-totalsItem" }, t("totals.loaded", { count: totals.count })),
					totals.running === 0 ? null : h("span", { className: "smgm-totalsItem" }, t("totals.running", { count: totals.running })),
					// The rows without usage are a count like the two above, and the
					// amounts line below stays three items wide either way, so the
					// strip keeps its two lines however many rows lack projections.
					partial),
				h("div", { className: "smgm-totals" },
					totalsItem,
					cacheItem,
					h("span", { className: "smgm-totalsItem", title: formatExactDuration(totals.durationMs, t) },
						t("totals.duration", { duration: formatDuration(totals.durationMs, t) }))),
				h("div", { className: "smgm-modelHead" },
					h("button", {
						type: "button",
						className: "smgm-chip",
						onClick: onFetchModels
					}, t(modelState === "ready" ? "models.refetch" : "models.fetch")),
					modelState === "idle" ? h("span", { className: "smgm-summaryHint" }, t("models.hint")) : null),
				modelsBody);
		}
		//#endregion
		//#region capability face
		/**
		 * Render the id-card glyph that opens one subagent's capability face.
		 * @returns the glyph element.
		 */
		function FaceGlyph() {
			return h("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": "true"
			},
				h("rect", { x: "2.6", y: "4.25", width: "14.8", height: "11.5", rx: "2.25", stroke: "currentColor", strokeWidth: "1.4" }),
				h("circle", { cx: "7", cy: "8.9", r: "1.7", stroke: "currentColor", strokeWidth: "1.3" }),
				h("path", { d: "M4.5 12.7c.5-1.1 1.4-1.7 2.5-1.7s2 .6 2.5 1.7", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
				h("path", { d: "M11.7 8.3h3.4M11.7 11.3h3.4", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }));
		}
		/**
		 * Render the back chevron of the capability face head.
		 * @returns the glyph element.
		 */
		function BackGlyph() {
			return h("svg", {
				width: "13",
				height: "13",
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": "true"
			}, h("path", {
				d: "M12 4.5L7 10l5 5.5",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/**
		 * Serialize one tool parameter schema for display, bounded so a wide schema
		 * cannot flood the panel.
		 * @param value - the schema object.
		 * @returns pretty JSON, truncated past 4000 characters.
		 */
		function faceJson(value) {
			let text;
			try {
				text = JSON.stringify(value ?? {}, null, 2);
			} catch {
				return "";
			}
			return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
		}
		/**
		 * Read-only capability face of one subagent: what its delegation wrote, the
		 * tools and model of its last request, the skills its preset sees, and the
		 * persona it was given. The host derives all of it (`faceFor`), because a
		 * subagent's tools and persona live in that subagent's own durable log;
		 * this component only renders what came back.
		 * @param props.sessionId - the subagent session to describe.
		 * @param props.label - its display label, for the head.
		 * @param props.parentSessionId - the open session, used as the parent hint.
		 * @param props.running - whether that subagent is running right now.
		 * @param props.t - translate function.
		 * @param props.onBack - return to the catalog tree.
		 * @returns the panel element.
		 */
		function CapabilityPanel({ sessionId, label, parentSessionId, running, t, onBack }) {
			const [state, setState] = useState({ status: "loading" });
			const [attempt, setAttempt] = useState(0);

			useEffect(() => {
				const abort = new AbortController();
				let live = true;
				setState({ status: "loading" });
				const parameters = new URLSearchParams({ sessionId });
				if (parentSessionId !== undefined) parameters.set("parent", parentSessionId);
				fetch(`${FACE_ROUTE}?${parameters.toString()}`, {
					signal: abort.signal,
					headers: { accept: "application/json" }
				})
					.then(async (response) => {
						const payload = await response.json().catch(() => undefined);
						if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
						return payload;
					})
					.then((payload) => {
						if (live) setState({ status: "ready", value: payload });
					})
					.catch((error) => {
						if (live && error?.name !== "AbortError") setState({ status: "failed", error: `${error?.message ?? error}` });
					});
				return () => {
					live = false;
					abort.abort();
				};
			}, [sessionId, parentSessionId, attempt]);

			/** One titled section: its head, then whatever the caller renders. */
			const section = (title, meta, children) => h("div", { className: "smgm-faceSection" },
				h("div", { className: "smgm-faceSectionHead" },
					h("span", { className: "smgm-faceSectionTitle" }, title),
					meta),
				children);
			/** One labelled row of the identity grid; empty values are dropped. */
			const rows = (pairs) => h("div", { className: "smgm-faceGrid" },
				pairs
					.filter((pair) => pair[1] !== undefined && pair[1] !== null && pair[1] !== "")
					.map((pair) => h(React.Fragment, { key: pair[0] },
						h("span", { className: "smgm-faceKey" }, pair[0]),
						h("span", { className: "smgm-faceValue" }, pair[1]))));

			const mode = state.value?.subagent?.mode;
			const modeKey = mode === "continuable" ? "mode.continuable" : mode === "one-shot" ? "mode.oneShot" : "mode.unknown";
			const head = h("div", { className: "smgm-faceHead" },
				h("button", {
					type: "button",
					className: "smgm-faceBack",
					onClick: onBack
				}, h(BackGlyph), h("span", null, t("face.back"))),
				h("span", { className: "smgm-faceTitle", title: label ?? sessionId }, label ?? sessionId),
				h("span", { className: "smgm-faceChip" }, t(modeKey)));

			if (state.status === "loading") {
				return h("div", { className: "smgm-face" }, head, h("div", { className: "smgm-faceLoading" }, t("face.loading")));
			}
			if (state.status === "failed") {
				return h("div", { className: "smgm-face" }, head,
					h("div", { className: "smgm-faceError" }, `${t("face.failed")}: ${state.error}`),
					h("div", { className: "smgm-faceHead" }, h("button", {
						type: "button",
						className: "smgm-setBtn smgm-setBtnGhost",
						onClick: () => setAttempt((current) => current + 1)
					}, t("retry"))));
			}

			const value = state.value ?? {};
			const subagent = value.subagent ?? {};
			const session = value.session ?? {};
			const run = value.run ?? {};
			const tools = Array.isArray(value.tools) ? value.tools : [];
			const skills = value.skills ?? {};
			const skillEntries = Array.isArray(skills.entries) ? skills.entries : [];
			const persona = value.persona ?? null;
			const filter = subagent.toolFilter ?? null;
			// The catalogue rendered below is published only to an agent that
			// holds the `skill` tool, and a delegation can leave that tool out of
			// the face (an allow list without it, a deny list with it, or simply
			// a face that never had it). The session catalogue is therefore no
			// proof that THIS subagent sees any skill, so keep the two halves of
			// the panel consistent: no `skill` tool in the face, no skill list.
			const deniedSkill = Array.isArray(filter?.deny) && filter.deny.includes("skill");
			const allowLacksSkill = Array.isArray(filter?.allow) && filter.allow.length > 0 && !filter.allow.includes("skill");
			const runLacksSkill = tools.length > 0 && !tools.some((tool) => tool.name === "skill");
			const skillHidden = deniedSkill || allowLacksSkill || runLacksSkill;
			const model = [run.provider, run.model].filter(Boolean).join(" / ");
			const delegatedModel = [subagent.agentModel, subagent.agentReasoningEffort].filter(Boolean).join(" / ");
			const filterText = filter === null
				? ""
				: [
					Array.isArray(filter.allow) && filter.allow.length > 0 ? `${t("face.filter.allow")}: ${filter.allow.join(", ")}` : "",
					Array.isArray(filter.deny) && filter.deny.length > 0 ? `${t("face.filter.deny")}: ${filter.deny.join(", ")}` : ""
				].filter(Boolean).join(" · ");

			const profile = section(t("face.section.profile"), null, h(React.Fragment, null,
				rows([
					[t("face.mode"), t(modeKey)],
					[t("face.state"), t(running === true ? "activity.running" : "activity.inactive")],
					[t("face.launch"), subagent.provider],
					[t("face.preset"), session.agentPreset],
					[t("face.model"), model],
					[t("face.delegatedModel"), delegatedModel === run.model ? "" : delegatedModel],
					[t("face.cwd"), session.cwd],
					[t("face.depth"), session.delegationDepth],
					[t("face.parent"), session.parentSession ?? parentSessionId],
					[t("face.created"), session.createdAt === null || session.createdAt === undefined ? "" : new Date(session.createdAt).toLocaleString()]
				]),
				filterText === "" ? null : h("span", { className: "smgm-faceNote smgm-faceFilter" }, `${t("face.filter")} · ${filterText}`)));
			const toolSection = section(t("face.section.tools"), h("span", { className: "smgm-faceCount" }, t("face.tools.count", { count: tools.length })),
				tools.length === 0
					? h("div", { className: "smgm-faceEmpty" }, t("face.tools.empty"))
					: h(React.Fragment, null,
						h("span", { className: "smgm-faceNote" }, t("face.tools.source")),
						tools.map((tool) => h("div", { className: "smgm-faceItem", key: tool.name },
							h("span", { className: "smgm-faceItemName" },
								tool.name,
								tool.deferLoading === true ? h("span", { className: "smgm-faceItemFlag" }, ` · ${t("face.tools.deferred")}`) : null),
							tool.description === undefined || tool.description === "" ? null : h("span", { className: "smgm-faceItemDesc" }, tool.description),
							h("details", null,
								h("summary", { className: "smgm-faceItemFlag" }, t("face.tools.params")),
								h("pre", { className: "smgm-faceParams" }, faceJson(tool.parameters)))))));
			const skillSection = section(t("face.section.skills"),
				skillHidden || skills.state !== "ok" ? null : h("span", { className: "smgm-faceCount" }, t("face.skills.count", { count: skillEntries.length })),
				skillHidden
					? h("div", { className: "smgm-faceEmpty" }, t("face.skills.notDelegated"))
					: skills.state === "unavailable"
						? h("div", { className: "smgm-faceEmpty" }, t("face.skills.unavailable"))
						: skills.state === "error"
							? h("div", { className: "smgm-faceEmpty" }, t("face.skills.failed", { error: skills.error ?? "" }))
							: skillEntries.length === 0
								? h("div", { className: "smgm-faceEmpty" }, t("face.skills.empty"))
								: skillEntries.map((entry) => h("div", { className: "smgm-faceItem", key: entry.name },
									h("span", { className: "smgm-faceItemName" },
										entry.name,
										entry.modelInvocable === true ? null : h("span", { className: "smgm-faceItemFlag" }, ` · ${t("face.skills.agentOnly")}`)),
									entry.description === undefined || entry.description === "" ? null : h("span", { className: "smgm-faceItemDesc" }, entry.description),
									entry.whenToUse === undefined || entry.whenToUse === "" ? null : h("span", { className: "smgm-faceItemDesc" }, entry.whenToUse))));
			const personaLabel = persona?.source === "descriptor"
				? "face.persona.recorded"
				: persona?.generated === true ? "face.persona.generated" : "face.persona.inferred";
			const personaSection = section(t("face.section.persona"),
				persona === null ? null : h("span", { className: "smgm-faceCount" }, t(personaLabel)),
				persona === null
					? h("div", { className: "smgm-faceEmpty" }, t("face.persona.empty"))
					: h(React.Fragment, null,
						persona.generated === true ? h("span", { className: "smgm-faceNote" }, t("face.persona.generatedNote")) : null,
						h("pre", { className: "smgm-facePre" }, persona.text),
						persona.replaced === null || persona.replaced === undefined ? null : h(React.Fragment, null,
							h("span", { className: "smgm-faceNote" }, t("face.persona.replaced")),
							h("pre", { className: "smgm-facePre" }, persona.replaced))));

			return h("div", { className: "smgm-face" }, head, profile, toolSection, skillSection, personaSection);
		}
		//#endregion
		//#region catalog trigger
		/**
		 * Count trigger, or breadcrumb switcher, plus the newest-first tree menu.
		 * @param props.rootSessionId - session whose direct children are listed.
		 * @param props.currentSessionId - session whose conversation is on screen.
		 * @param props.displayTitle - header title used when the switcher entry is unknown.
		 * @param props.openTitle - navigate to an ancestor title instead of opening the menu.
		 * @param props.variant - "count" for the header action, "switcher" for the lineage breadcrumb.
		 * @param props.projections - the list store's projection snapshots.
		 * @param props.summaries - the list store's session summaries.
		 * @param props.statuses - the unified session status snapshot.
		 * @param props.openChild - open a child in the main column.
		 * @param props.openChildAside - open a child in the right column.
		 * @param props.refreshProjection - retry one session's projections.
		 * @param props.t - translate function.
		 * @returns the trigger, with its menu while open.
		 */
		function CatalogDropdown({ rootSessionId, currentSessionId, displayTitle, openTitle, variant = "count", projections, summaries, statuses, openChild, openChildAside, refreshProjection, t }) {
			const ancestorSwitcher = variant === "switcher" && openTitle !== undefined;
			const [open, setOpen] = useState(false);
			const [menuPosition, setMenuPosition] = useState(undefined);
			const [expanded, setExpanded] = useState(() => new Set());
			/** The subagent whose capability face replaces the tree, if any. */
			const [face, setFace] = useState(undefined);
			/** The filter narrowing the tree; empty and "all" until the user acts. */
			const [filter, setFilter] = useState({ text: "", activity: "all", oneShot: false });
			/** session id → model answer, filled only when the user asks for them. */
			const [models, setModels] = useState(() => new Map());
			/** "idle" until the first model read, then "loading" | "ready" | "error". */
			const [modelState, setModelState] = useState("idle");
			const [now, setNow] = useState(() => Date.now());
			const rootRef = useRef(null);
			const triggerRef = useRef(null);
			const menuRef = useRef(null);
			const hoverOpenTimer = useRef(undefined);
			const hoverCloseTimer = useRef(undefined);
			const pinnedRef = useRef(false);
			const correctedRef = useRef(false);
			const focusFirstRef = useRef(false);
			const settings = useSettings();

			const catalog = catalogOf(rootSessionId, projections, summaries);
			const catalogEntries = catalog?.entries ?? [];
			const entries = settings.newestFirst ? sortNewestFirst(catalogEntries) : catalogEntries;
			const directCount = entries.length;
			const runningCount = entries.filter((entry) => activityOf(entry.id, summaries, statuses) === "running").length;
			const totalCountKey = directCount === 1 ? "count.total.one" : "count.total.other";
			const runningCountKey = runningCount === 1 ? "count.running.one" : "count.running.other";
			const currentEntry = currentSessionId === undefined ? undefined : (catalog?.entries ?? []).find((entry) => entry.id === currentSessionId);
			const switcherTitle = currentEntry !== undefined ? currentEntry.label ?? currentEntry.id : displayTitle;
			// A switcher is the breadcrumb itself, so it renders while its catalog
			// loads; the count trigger keeps the shipped rule of error-or-children.
			const presentedCatalog = catalog ?? (variant === "switcher" ? { entries: [], state: "loading", error: null } : undefined);
			const visible = presentedCatalog !== undefined && (variant === "switcher" || presentedCatalog.state === "error" || presentedCatalog.entries.length > 0);
			const panelHead = presentedCatalog !== undefined && presentedCatalog.state !== "error";

			// Wall clock for the running rows, ticking only while the menu is open.
			useEffect(() => {
				if (!open) return undefined;
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [open]);

			const filtering = filterActive(filter);
			const totals = useMemo(() => catalogTotals(presentedCatalog, filtering ? filter : undefined, projections, summaries, statuses, now, currentSessionId),
				[presentedCatalog, filter, filtering, projections, summaries, statuses, now, currentSessionId]);
			const patchFilter = useCallback((patch) => setFilter((current) => ({ ...current, ...patch })), []);
			const fetchModels = useCallback(async () => {
				const ids = [...new Set(totals.nodes.map((node) => node.id))];
				if (ids.length === 0) return;
				setModelState("loading");
				try {
					const response = await fetch(`${MODELS_ROUTE}?sessionIds=${encodeURIComponent(ids.join(","))}`);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const payload = await response.json();
					const answers = payload === null || typeof payload !== "object" ? [] : payload.entries ?? [];
					setModels(new Map(answers
						.filter((answer) => answer !== null && typeof answer === "object" && typeof answer.sessionId === "string")
						.map((answer) => [answer.sessionId, answer])));
					setModelState("ready");
				} catch (error) {
					console.warn("[subagent-mgm] could not read the models", error);
					setModelState("error");
				}
			}, [totals.nodes]);

			const positionMenu = useCallback(() => {
				const trigger = triggerRef.current;
				if (trigger === null) return;
				const rect = trigger.getBoundingClientRect();
				const width = Math.min(face === undefined ? MENU_WIDTH : MENU_WIDTH_WIDE, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
				setMenuPosition({
					top: rect.bottom + 5,
					left: Math.min(Math.max(MENU_VIEWPORT_MARGIN, rect.left), window.innerWidth - width - MENU_VIEWPORT_MARGIN)
				});
			}, [face]);

			const changeOpen = useCallback((next) => {
				if (next) {
					positionMenu();
					correctedRef.current = false;
				} else {
					setExpanded(new Set());
					setFace(undefined);
				}
				setOpen(next);
			}, [positionMenu]);

			const cancelHoverOpen = useCallback(() => {
				if (hoverOpenTimer.current === undefined) return;
				clearTimeout(hoverOpenTimer.current);
				hoverOpenTimer.current = undefined;
			}, []);
			const cancelHoverClose = useCallback(() => {
				if (hoverCloseTimer.current === undefined) return;
				clearTimeout(hoverCloseTimer.current);
				hoverCloseTimer.current = undefined;
			}, []);
			const scheduleHoverOpen = useCallback(() => {
				cancelHoverClose();
				if (open || hoverOpenTimer.current !== undefined) return;
				hoverOpenTimer.current = setTimeout(() => {
					hoverOpenTimer.current = undefined;
					changeOpen(true);
				}, HOVER_OPEN_DELAY);
			}, [open, cancelHoverClose, changeOpen]);
			const scheduleHoverClose = useCallback(() => {
				cancelHoverOpen();
				if (!open || pinnedRef.current || hoverCloseTimer.current !== undefined) return;
				hoverCloseTimer.current = setTimeout(() => {
					hoverCloseTimer.current = undefined;
					changeOpen(false);
				}, HOVER_CLOSE_DELAY);
			}, [open, cancelHoverOpen, changeOpen]);
			const closeCatalog = useCallback(() => {
				pinnedRef.current = false;
				changeOpen(false);
			}, [changeOpen]);
			/**
			 * Swap the tree for one subagent's capability face. The menu stays pinned
			 * open: that face is a place to read, not a hover target.
			 */
			const inspectFace = useCallback((childSessionId, childLabel, childRunning) => {
				pinnedRef.current = true;
				cancelHoverClose();
				setFace({ id: childSessionId, label: childLabel, running: childRunning === true });
			}, [cancelHoverClose]);

			useEffect(() => () => {
				cancelHoverOpen();
				cancelHoverClose();
			}, [cancelHoverOpen, cancelHoverClose]);

			useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
					pinnedRef.current = false;
					changeOpen(false);
				};
				const onReposition = () => positionMenu();
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("scroll", onReposition, true);
				window.addEventListener("resize", onReposition);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("scroll", onReposition, true);
					window.removeEventListener("resize", onReposition);
				};
			}, [open, changeOpen, positionMenu]);

			// One post-mount correction keeps the menu on the trigger even when a
			// transformed ancestor turns `position: fixed` into a local containing block.
			useEffect(() => {
				if (!open || correctedRef.current) return;
				const menu = menuRef.current;
				const trigger = triggerRef.current;
				if (menu === null || trigger === null) return;
				correctedRef.current = true;
				const rect = trigger.getBoundingClientRect();
				const width = Math.min(MENU_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
				const wantTop = rect.bottom + 5;
				const wantLeft = Math.min(Math.max(MENU_VIEWPORT_MARGIN, rect.left), window.innerWidth - width - MENU_VIEWPORT_MARGIN);
				const actual = menu.getBoundingClientRect();
				const deltaTop = wantTop - actual.top;
				const deltaLeft = wantLeft - actual.left;
				if (Math.abs(deltaTop) < 0.5 && Math.abs(deltaLeft) < 0.5) return;
				setMenuPosition((current) => ({
					top: (current === undefined ? wantTop : current.top) + deltaTop,
					left: (current === undefined ? wantLeft : current.left) + deltaLeft
				}));
			}, [open, menuPosition]);

			// The capability face is wider than the tree, so re-anchor the menu to its
			// trigger once that width is in effect.
			useEffect(() => {
				if (!open || face === undefined) return;
				positionMenu();
			}, [open, face, positionMenu]);

			useEffect(() => {
				if (!open || !focusFirstRef.current) return;
				focusFirstRef.current = false;
				const items = treeItems(menuRef.current);
				if (items.length > 0) items[0].focus();
			}, [open]);

			const onTriggerKeyDown = useCallback((event) => {
				if (event.key !== "ArrowDown") return;
				event.preventDefault();
				pinnedRef.current = true;
				focusFirstRef.current = true;
				changeOpen(true);
			}, [changeOpen]);

			const onMenuKeyDown = useCallback((event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					pinnedRef.current = false;
					changeOpen(false);
					if (triggerRef.current !== null) triggerRef.current.focus();
					return;
				}
				const items = treeItems(menuRef.current);
				if (items.length === 0) return;
				const index = items.indexOf(document.activeElement);
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					const next = event.key === "ArrowDown"
						? Math.min(items.length - 1, index + 1)
						: Math.max(0, index <= 0 ? 0 : index - 1);
					items[next].focus();
					return;
				}
				if (event.key === "Home") {
					event.preventDefault();
					items[0].focus();
					return;
				}
				if (event.key === "End") {
					event.preventDefault();
					items[items.length - 1].focus();
				}
			}, [changeOpen]);

			/** In the capability face, Escape steps back to the tree, not out of it. */
			const onFaceKeyDown = useCallback((event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				setFace(undefined);
			}, []);

			// Collapsing a branch drops its whole subtree, so expanding it again
			// refetches instead of showing rows that were never loaded.
			const closeBranch = useCallback((childSessionId) => {
				const closing = new Set();
				const visit = (parentSessionId) => {
					if (closing.has(parentSessionId) || !expanded.has(parentSessionId)) return;
					closing.add(parentSessionId);
					for (const child of catalogOf(parentSessionId, projections, summaries)?.entries ?? []) visit(child.id);
				};
				visit(childSessionId);
				setExpanded(new Set([...expanded].filter((id) => !closing.has(id))));
			}, [expanded, projections, summaries]);
			const toggleBranch = useCallback((childSessionId) => {
				if (expanded.has(childSessionId)) {
					closeBranch(childSessionId);
					return;
				}
				setExpanded(new Set(expanded).add(childSessionId));
				// A child's own catalog arrives only once its projections are read.
				refreshProjection(childSessionId);
			}, [expanded, closeBranch, refreshProjection]);

			const onTriggerClick = useCallback(() => {
				cancelHoverClose();
				if (open) {
					pinnedRef.current = false;
					changeOpen(false);
					return;
				}
				pinnedRef.current = true;
				changeOpen(true);
			}, [open, cancelHoverClose, changeOpen]);

			if (!visible) return null;

			const isSwitcher = variant === "switcher";
			const onAncestorClick = () => {
				cancelHoverOpen();
				if (open) changeOpen(false);
				openTitle();
			};
			const trigger = h("button", {
				type: "button",
				ref: triggerRef,
				className: isSwitcher ? classNames("smgm-switcherTrigger", ancestorSwitcher && "smgm-ancestorSwitcherTrigger") : "smgm-trigger",
				"aria-haspopup": "tree",
				"aria-expanded": open ? "true" : "false",
				"aria-label": isSwitcher ? t("switcher.aria", { title: switcherTitle }) : t(runningCount > 0 ? runningCountKey : totalCountKey, { count: runningCount > 0 ? runningCount : directCount }),
				onClick: openTitle === undefined ? onTriggerClick : onAncestorClick,
				onMouseEnter: scheduleHoverOpen,
				onKeyDown: onTriggerKeyDown
			},
				isSwitcher
					? h("span", { className: "smgm-switcherTitle" }, switcherTitle)
					: h(React.Fragment, null,
						runningCount > 0 ? h("span", { className: "smgm-activitySlot" }, h(StateDot, { state: "ongoing" })) : null,
						h("span", { className: "smgm-count" }, t(totalCountKey, { count: directCount }))),
				isSwitcher ? h(SwitcherIcon, {}) : h("span", { className: open ? "smgm-triggerOpen" : undefined }, h(Chevron, {})));

			const menu = !open ? null : h("div", {
				ref: menuRef,
				className: classNames("smgm-menu", face !== undefined && "smgm-menuWide"),
				style: menuPosition,
				onMouseEnter: cancelHoverClose,
				onMouseLeave: scheduleHoverClose
			}, face !== undefined
				? h("div", {
					className: "smgm-menuBody",
					role: "dialog",
					"aria-label": t("face.title"),
					onKeyDown: onFaceKeyDown
				}, h(CapabilityPanel, {
					sessionId: face.id,
					label: face.label,
					parentSessionId: rootSessionId,
					running: face.running,
					t,
					onBack: () => setFace(undefined)
				}))
				: h("div", {
					className: "smgm-menuBody",
					onKeyDown: onMenuKeyDown
				},
					panelHead ? h("div", { className: "smgm-head" },
						h(CatalogControls, { t, filter, onChange: patchFilter }),
						h(CatalogSummary, { t, totals, nodes: totals.nodes, models, modelState, onFetchModels: fetchModels })) : null,
					h("div", {
						className: "smgm-tree",
						role: "tree",
						"aria-label": t("tree.aria")
					}, h(CatalogRows, {
						parentSessionId: rootSessionId,
						currentSessionId,
						catalog: presentedCatalog,
						projections,
						summaries,
						statuses,
						expanded,
						level: 1,
						openChild,
						openChildAside,
						refreshProjection,
						toggleBranch,
						closeCatalog,
						inspectFace,
						filter: filtering ? filter : undefined,
						t
					}))));

			return h("span", {
				className: classNames("smgm-root", isSwitcher && "smgm-switcherRoot"),
				ref: rootRef,
				onMouseLeave: scheduleHoverClose
			}, trigger, menu);
		}
		/**
		 * Header action: the newest-first subagent catalog, hidden inside subagents.
		 * @param props.sessionId - session whose conversation owns the header.
		 * @param props.useSessions - session list selector hook.
		 * @param props.useSessionStatus - unified status selector hook.
		 * @param props.openChild - open a child in the main column.
		 * @param props.openChildAside - open a child in the right column.
		 * @param props.refreshProjection - retry one session's projections.
		 * @param props.t - translate function.
		 * @returns the catalog trigger, or null where it does not belong.
		 */
		function SubagentMgrAction({ sessionId, useSessions, useSessionStatus, openChild, openChildAside, refreshProjection, t }) {
			const isSubagent = useSessions((state) => state.byId[sessionId]?.origin === "subagent");
			const projections = useSessions((state) => state.projectionsBySession);
			const summaries = useSessions((state) => state.byId);
			const statuses = useSessionStatus((value) => value);
			const identity = useMemo(() => ({
				rootSessionId: sessionId,
				currentSessionId: sessionId,
				projections,
				summaries,
				statuses,
				openChild,
				openChildAside,
				refreshProjection,
				t
			}), [sessionId, projections, summaries, statuses, openChild, openChildAside, refreshProjection, t]);
			if (isSubagent || sessionId === undefined) return null;
			return h(CatalogDropdown, identity);
		}
		/**
		 * Sidebar session-row hover digest: the subagents of one Session, inside the
		 * card the sidebar already opens for that row.
		 *
		 * The workspace renders this seat between the row's relative time and the
		 * shipped "N subagents running" line, and that line belongs to the workspace,
		 * so this adds what the line leaves out instead of replacing it. The seat
		 * hands over the row's Session id alone, so the two client stores are
		 * subscribed here: nothing is retained, no session log is read (a model name
		 * lives only in a log, so the model grouping stays in the panel), and the
		 * numbers are the ones the catalog strip would show for that Session with no
		 * filter — its own usage included, because it is spent in the same place.
		 * The rows are deliberately not clickable: the card itself copies the Session
		 * title on click, and a second action inside the same card would be a coin
		 * toss.
		 *
		 * A Session with no subagents is not skipped: it shows its own line — tokens
		 * spent, cache share, working time from the host's `sessionStats` projection —
		 * because that is the same question the rows answer one level down.
		 * @param props.sessionId - the Session this row shows.
		 * @param props.useHoverStores - injected subscription to the client stores.
		 * @param props.t - translate function.
		 * @returns the digest, the Session's own usage line when it has no subagents,
		 *   or null when there is nothing to report.
		 */
		function SessionRowHover({ sessionId, useHoverStores, t }) {
			const stores = useHoverStores();
			const now = useNow();
			const settings = useSettings();
			const catalog = catalogOf(sessionId, stores.projections, stores.summaries);
			const totals = catalogTotals(catalog, undefined, stores.projections, stores.summaries, stores.statuses, now, sessionId);
			const selfSummary = stores.summaries[sessionId];
			const selfTokens = totals.self === null ? undefined : totals.self.tokens;
			const cacheHit = cacheHitPercent(totals.cacheRead, totals.billedInput);
			const work = sessionWork(selfSummary?.projectionValues?.sessionStats);
			// No subagents on this row: the shipped status line keeps saying what it
			// says, and this card answers instead the question the rows would have
			// answered — what this Session spent and how long it worked. A Session with
			// nothing recorded yet stays silent rather than reporting zeros.
			if (totals.count === 0) {
				if ((selfTokens === undefined || selfTokens === 0) && cacheHit === null && (work === null || work.ms === 0)) return null;
				return h("div", { className: "smgm-digest" },
					h("div", { className: "smgm-digestLine" },
						selfTokens === undefined || selfTokens === 0 ? null : h("span", {
							className: "smgm-digestValue",
							title: t("totals.selfTitle", {
								hit: formatExactTokens(totals.cacheRead),
								written: formatExactTokens(totals.cacheWrite),
								prompt: formatExactTokens(totals.billedInput),
								missed: formatExactTokens(Math.max(0, totals.billedInput - totals.cacheRead))
							})
						}, t("hover.selfTokens", { value: formatTokens(selfTokens, t) })),
						cacheHit === null ? null : h("span", {
							className: "smgm-digestValue",
							title: t("cache.stripTitle", {
								hit: formatExactTokens(totals.cacheRead),
								written: formatExactTokens(totals.cacheWrite),
								prompt: formatExactTokens(totals.billedInput),
								missed: formatExactTokens(Math.max(0, totals.billedInput - totals.cacheRead))
							})
						}, t("cache.percent", { percent: cacheHit })),
						work === null || work.ms === 0 ? null : h("span", {
							className: "smgm-digestValue",
							title: t("hover.workTitle", {
								model: formatExactDuration(work.llmMs, t),
								tool: formatExactDuration(work.toolMs, t),
								turns: work.turns,
								steps: work.steps
							})
						}, t("hover.workTime", { duration: formatDuration(work.ms, t) }))));
			}
			const entries = catalog?.entries ?? [];
			const ordered = settings.newestFirst ? sortNewestFirst(entries) : entries;
			const listed = ordered.filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string");
			const shown = listed.slice(0, HOVER_ROWS);
			const hidden = totals.count - shown.length;
			const totalsItem = totals.self === null
				? h("span", { className: "smgm-digestValue" }, t("totals.tokens", { value: formatTokens(totals.tokens, t) }))
				: h("span", {
					className: "smgm-digestValue",
					title: t("totals.selfTitle", {
						hit: formatExactTokens(totals.self.cacheRead),
						written: formatExactTokens(totals.self.cacheWrite),
						prompt: formatExactTokens(totals.self.billedInput),
						missed: formatExactTokens(Math.max(0, totals.self.billedInput - totals.self.cacheRead))
					})
				}, t("totals.tokensWithSelf", {
					value: formatTokens(totals.tokens, t),
					self: formatTokens(totals.self.tokens, t)
				}));
			return h("div", { className: "smgm-digest" },
				h("div", { className: "smgm-digestLine" },
					h("span", null, t("count.total.other", { count: totals.count })),
					totals.running === 0 ? null : h("span", null, t("totals.running", { count: totals.running })),
					totals.unknownTokens === 0 ? null
						: h("span", { className: "smgm-digestNote" }, t("totals.partial", { count: totals.unknownTokens }))),
				h("div", { className: "smgm-digestLine" },
					totalsItem,
					cacheHit === null ? null : h("span", {
						className: "smgm-digestValue",
						title: t("cache.stripTitle", {
							hit: formatExactTokens(totals.cacheRead),
							written: formatExactTokens(totals.cacheWrite),
							prompt: formatExactTokens(totals.billedInput),
							missed: formatExactTokens(Math.max(0, totals.billedInput - totals.cacheRead))
						})
					}, t("cache.percent", { percent: cacheHit })),
					totals.durationMs === 0 ? null : h("span", {
						className: "smgm-digestValue",
						title: formatExactDuration(totals.durationMs, t)
					}, t("totals.duration", { duration: formatDuration(totals.durationMs, t) }))),
				h("div", { className: "smgm-digestRows" }, shown.map((entry) => {
					const summary = stores.summaries[entry.id];
					const activity = activityOf(entry.id, stores.summaries, stores.statuses);
					const completed = activity === "inactive" && summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true;
					const usageValue = summary?.projectionValues?.tokenUsage;
					const totalTokens = tokenTotal(usageValue);
					const read = usageValue?.cacheReadTokens ?? 0;
					const billed = billedInputTokens(usageValue) ?? 0;
					const hit = cacheHitPercent(usageValue?.cacheReadTokens, billedInputTokens(usageValue));
					const label = entry.label ?? entry.id;
					return h("div", { className: "smgm-digestRow", key: entry.id },
						h(StateDot, { state: activity === "running" ? "ongoing" : completed ? "done" : "idle", size: 12 }),
						h("span", { className: "smgm-digestName", title: label }, label),
						totalTokens === undefined ? null
							: h("span", { className: "smgm-digestValue" }, t("tokens.total", { value: formatTokens(totalTokens, t) })),
						hit === null ? null : h("span", {
							className: "smgm-digestNote",
							title: t("cache.exactTitle", {
								hit: formatExactTokens(read),
								prompt: formatExactTokens(billed),
								missed: formatExactTokens(Math.max(0, billed - read))
							})
						}, t("cache.percent", { percent: hit })));
				})),
				hidden <= 0 ? null : h("div", { className: "smgm-digestNote" }, t("hover.more", { count: hidden })));
		}
		/**
		 * Header lineage: the breadcrumb a child session shows instead of the
		 * count action, newest-first like the catalog it replaces.
		 *
		 * A child session renders its parent's catalog as a sibling switcher, and —
		 * when there is no ancestor title to navigate to — its own children as the
		 * count trigger, mirroring the shipped lineage this entry shadows.
		 * @param props.lineageSessionId - session represented by this breadcrumb.
		 * @param props.displayTitle - header title handed down for this breadcrumb.
		 * @param props.openTitle - navigate to an ancestor title when present.
		 * @param props.useSessions - session list selector hook.
		 * @param props.useSession - single-session selector hook.
		 * @param props.useSessionStatus - unified status selector hook.
		 * @param props.openChild - open a child in the main column.
		 * @param props.openChildAside - open a child in the right column.
		 * @param props.refreshProjection - retry one session's projections.
		 * @param props.t - translate function.
		 * @returns the sibling switcher plus the child's own count trigger, or null on a root session.
		 */
		function SubagentMgrLineage({ lineageSessionId, displayTitle, openTitle, useSessions, useSession, useSessionStatus, openChild, openChildAside, refreshProjection, t }) {
			const address = useSession((session) => session.subagent?.address);
			const parentId = useSessions((state) => {
				if (address?.childSessionId === lineageSessionId) return address.parentSessionId;
				for (const [parent, snapshot] of Object.entries(state.projectionsBySession)) {
					if (snapshot.values.subagentCatalog?.some((entry) => entry.id === lineageSessionId)) return parent;
				}
			});
			const projections = useSessions((state) => state.projectionsBySession);
			const summaries = useSessions((state) => state.byId);
			const statuses = useSessionStatus((value) => value);
			const shared = {
				projections,
				summaries,
				statuses,
				openChild,
				openChildAside,
				refreshProjection,
				t
			};
			if (parentId === undefined) return null;
			return h(React.Fragment, null,
				h(CatalogDropdown, {
					key: lineageSessionId + ":switcher",
					...shared,
					rootSessionId: parentId,
					currentSessionId: lineageSessionId,
					displayTitle,
					openTitle,
					variant: "switcher"
				}),
				openTitle === undefined ? h(CatalogDropdown, {
					key: lineageSessionId + ":count",
					...shared,
					rootSessionId: lineageSessionId,
					variant: "count"
				}) : null);
		}
		//#endregion
		//#region automatic right-side panels
		/**
		 * Keep one right-sidebar chat panel per running direct subagent of the
		 * on-screen session, and drop it when that subagent ends. A panel the user
		 * closes while its subagent is still running stays closed for that run.
		 *
		 * Closing is not confined to the session on screen: the tab inventory spans
		 * every saved and adopted session, and a subagent that ends while its parent
		 * sits in the background still has to give its panel up. Otherwise that
		 * parent's sidebar shows the finished chat again the moment it is selected.
		 * @param ctx - client context carrying the sidebar-right and session stores.
		 * @returns a disposer releasing every subscription.
		 */
		function startSubagentPanels(ctx) {
			const sidebar = ctx.sidebarRight;
			const inventory = sidebar === undefined ? undefined : sidebar.openTabs;
			if (sidebar === undefined || inventory === undefined || typeof inventory.getSnapshot !== "function") {
				console.error("[subagent-mgm] the sidebar-right tab inventory is unavailable; automatic panels stay off");
				return () => {};
			}
			/** Children the user closed by hand during their current run. */
			const suppressed = new Set();
			/** Children whose panel this plugin has seen open during their current run. */
			const seen = new Set();
			/** Children observed running, so a later stop is a real transition. */
			const wasRunning = new Set();
			/** Children whose panel this plugin has already surfaced during their current run. */
			const handled = new Set();
			/** Sessions whose projections this plugin already asked to load. */
			const refreshed = new Set();
			let mounted;
			let scheduled = false;

			const readCatalog = (parentSessionId) => {
				const list = ctx.sessions.list.getSnapshot();
				const values = list.projectionsBySession?.[parentSessionId]?.values;
				if (values?.subagentCatalog !== undefined) return values.subagentCatalog;
				return list.byId?.[parentSessionId]?.projectionValues?.subagentCatalog;
			};
			/** Every chat panel open right now, whichever session owns it. */
			const readChatPanels = () => {
				const tabs = inventory.getSnapshot() ?? [];
				return tabs.filter((tab) => tab !== null && typeof tab === "object" && tab.kind === CHAT_KIND);
			};
			const readPanels = (parentSessionId) => readChatPanels().filter((tab) => tab.sessionId === parentSessionId);
			/** Whether the inventory still carries this record, i.e. the close did not land. */
			const isOpen = (tab) => (inventory.getSnapshot() ?? []).some(
				(open) => open !== null && typeof open === "object" && open.sessionId === tab.sessionId && open.tabId === tab.tabId
			);
			const isRunning = (childSessionId) => {
				const status = ctx.uiSession.sessionStatus.getSnapshot().get(childSessionId);
				if (status !== undefined && status.running !== undefined) return status.running;
				return ctx.sessions.list.getSnapshot().byId?.[childSessionId]?.running === true;
			};

			const reconcile = () => {
				const settings = settingsStore.getSnapshot();
				const current = sidebar.mounted.getSnapshot();
				if (mounted !== current) {
					mounted = current;
					// Run state is keyed by the child, never by the session on screen:
					// a run that ends in the background still has to be recognised as
					// one, so these sets survive a session switch and only the focus
					// record and the projection retry are rebound.
					handled.clear();
					refreshed.clear();
				}
				// Closing comes first and covers every session, on screen or not: the
				// inventory spans saved and adopted sessions alike, and a tab left
				// standing is exactly what a background session shows as a finished
				// chat the next time it is selected.
				const panelChildren = new Set();
				for (const tab of readChatPanels()) {
					const child = panelChildId(tab.contentId);
					if (child === undefined) continue;
					panelChildren.add(child);
					if (isRunning(child)) {
						wasRunning.add(child);
						continue;
					}
					if (settings.autoClose && wasRunning.has(child)) {
						try {
							sidebar.closeIn(tab.sessionId, tab.tabId);
						} catch (error) {
							console.error("[subagent-mgm] closing an ended subagent panel failed", error);
						}
						// A session whose store the runtime never minted cannot take the
						// close: keeping the run lets the pass that mounts its seat
						// retry, and pruning forgets it once the tab is gone.
						if (isOpen(tab)) continue;
					}
					// The run is over, so no trace of it may outlive it — including
					// this plugin's own close, which must never read as a user close
					// when the parent resumes the same child.
					wasRunning.delete(child);
					seen.delete(child);
					handled.delete(child);
					suppressed.delete(child);
				}
				if (current === undefined) return;
				const catalog = readCatalog(current);
				if (catalog === undefined) {
					if (!refreshed.has(current)) {
						refreshed.add(current);
						ctx.sessions.refreshProjections(current).catch(() => {});
					}
					return;
				}
				const panels = readPanels(current);
				const present = new Set();
				for (const entry of catalog) {
					if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
					present.add(entry.id);
					const address = chatAddress(current, entry.id, entry.mode);
					const panel = panels.find((tab) => panelChildId(tab.contentId) === entry.id);
					if (panel !== undefined) {
						seen.add(entry.id);
						suppressed.delete(entry.id);
					}
					if (!isRunning(entry.id)) {
						// The panel of a finished run was closed above, wherever its
						// session lives; here only that run's bookkeeping is dropped.
						wasRunning.delete(entry.id);
						seen.delete(entry.id);
						handled.delete(entry.id);
						suppressed.delete(entry.id);
						continue;
					}
					wasRunning.add(entry.id);
					if (seen.has(entry.id) && panel === undefined) {
						// The panel was open during this run and is gone: the user closed it.
						suppressed.add(entry.id);
						seen.delete(entry.id);
						continue;
					}
					if (suppressed.has(entry.id)) continue;
					if (!settings.autoOpen) continue;
					// Keeping the switch off must not steal focus from a panel the
					// user already has open in the background.
					if (panel !== undefined && settings.reveal === false) continue;
					if (handled.has(entry.id)) continue;
					handled.add(entry.id);
					// An open panel is surfaced through its own identity, so a panel the
					// shipped dropdown opened under another mode is never duplicated.
					const target = panel === undefined ? address : panel.contentId;
					try {
						sidebar.openResourceIn(current, target, { kind: CHAT_KIND });
					} catch (error) {
						suppressed.add(entry.id);
						console.error("[subagent-mgm] opening a subagent panel failed", error);
					}
				}
				// A child is forgotten only once no catalog, no open panel and no run
				// of its own still names it — a child of a background session is kept
				// for exactly as long as it can still have a panel to give up.
				const keep = (childSessionId) =>
					present.has(childSessionId) || panelChildren.has(childSessionId) || isRunning(childSessionId);
				for (const childSessionId of [...seen]) if (!keep(childSessionId)) seen.delete(childSessionId);
				for (const childSessionId of [...wasRunning]) if (!keep(childSessionId)) wasRunning.delete(childSessionId);
				for (const childSessionId of [...handled]) if (!keep(childSessionId)) handled.delete(childSessionId);
				for (const childSessionId of [...suppressed]) if (!keep(childSessionId)) suppressed.delete(childSessionId);
			};

			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				Promise.resolve().then(() => {
					scheduled = false;
					try {
						reconcile();
					} catch (error) {
						console.error("[subagent-mgm] automatic panel reconcile failed", error);
					}
				});
			};

			const disposers = [
				sidebar.mounted.subscribe(schedule),
				inventory.subscribe(schedule),
				ctx.sessions.list.subscribe(schedule),
				ctx.uiSession.sessionStatus.subscribe(schedule),
				settingsStore.subscribe(schedule)
			];
			schedule();
			return () => {
				for (const dispose of disposers) dispose();
			};
		}
		//#endregion
		//#region settings page
		/**
		 * Settings page: four switches over the host route, saved on demand.
		 * @param props.t - translate function bound to this plugin's namespace.
		 * @returns the rendered page.
		 */
		function SettingsSection({ t }) {
			const [state, setState] = useState({ status: "loading" });
			const [draft, setDraft] = useState(() => ({ ...DEFAULT_SETTINGS }));
			const [busy, setBusy] = useState("");
			const [message, setMessage] = useState("");
			const [failure, setFailure] = useState("");
			const alive = useRef(true);

			const adopt = useCallback((payload) => {
				const resolved = {};
				for (const field of SETTING_FIELDS) {
					resolved[field] = typeof payload?.[field] === "boolean" ? payload[field] : DEFAULT_SETTINGS[field];
				}
				setState({ status: "ready", value: payload, effective: resolved });
				setDraft(resolved);
				settingsStore.adopt(payload);
			}, []);

			const load = useCallback(() => {
				setState({ status: "loading" });
				setFailure("");
				fetch(SETTINGS_ROUTE, { headers: { accept: "application/json" } })
					.then((response) =>
						response
							.json()
							.catch(() => ({}))
							.then((payload) => {
								if (!response.ok) throw new Error(payload?.error ?? "HTTP " + response.status);
								return payload;
							})
					)
					.then((payload) => {
						if (alive.current) adopt(payload);
					})
					.catch((error) => {
						if (alive.current) setState({ status: "failed", error: String(error?.message ?? error) });
					});
			}, [adopt]);

			useEffect(() => {
				alive.current = true;
				load();
				return () => {
					alive.current = false;
				};
			}, [load]);

			const send = useCallback(
				(method, body, done) => {
					setBusy(method);
					setFailure("");
					setMessage("");
					fetch(SETTINGS_ROUTE, {
						method,
						headers: { "content-type": "application/json", accept: "application/json" },
						body: body === undefined ? undefined : JSON.stringify(body)
					})
						.then((response) =>
							response
								.json()
								.catch(() => ({}))
								.then((payload) => {
									if (!response.ok) throw new Error(payload?.error ?? "HTTP " + response.status);
									return payload;
								})
						)
						.then((payload) => {
							if (!alive.current) return;
							adopt(payload);
							setMessage(done);
						})
						.catch((error) => {
							if (alive.current) setFailure(String(error?.message ?? error));
						})
						.finally(() => {
							if (alive.current) setBusy("");
						});
				},
				[adopt]
			);

			const save = () => {
				const body = {};
				for (const field of SETTING_FIELDS) body[field] = draft[field];
				send("POST", body, t("settings.saved"));
			};
			const reset = () => send("DELETE", undefined, t("settings.resetDone"));

			const head = h(
				"div",
				{ className: "smgm-setHead" },
				h("h2", { className: "smgm-setTitle" }, t("settings.title")),
				h("p", { className: "smgm-setSub" }, t("settings.subtitle"))
			);
			if (state.status === "loading") {
				return h("div", { className: "smgm-set" }, head, h("div", { className: "smgm-setState" }, t("settings.loading")));
			}
			if (state.status === "failed") {
				return h(
					"div",
					{ className: "smgm-set" },
					head,
					h(
						"div",
						{ className: "smgm-setState" },
						h("span", { className: "smgm-setErr" }, t("settings.failed")),
						h("span", { className: "smgm-setNote" }, state.error),
						h(
							"div",
							{ className: "smgm-setActions" },
							h("button", { type: "button", className: "smgm-setBtn smgm-setBtnGhost", onClick: load }, t("settings.retry"))
						)
					)
				);
			}

			const effective = state.effective ?? DEFAULT_SETTINGS;
			const rows = [
				["newestFirst", "settings.newestFirst", "settings.newestFirstHint"],
				["autoOpen", "settings.autoOpen", "settings.autoOpenHint"],
				["autoClose", "settings.autoClose", "settings.autoCloseHint"],
				["reveal", "settings.reveal", "settings.revealHint"]
			].map(([field, label, hint]) =>
				h(
					"label",
					{ className: "smgm-setOpt", key: field },
					h(
						"span",
						{ className: "smgm-setSwitch" },
						h("input", {
							type: "checkbox",
							checked: draft[field] === true,
							disabled: busy !== "",
							"aria-label": t(label),
							onChange: (event) => {
								const next = event.target.checked;
								setDraft((previous) => ({ ...previous, [field]: next }));
							}
						}),
						h("span", { className: "smgm-setTrack" }, h("span", { className: "smgm-setKnob" }))
					),
					h(
						"span",
						{ className: classNames("smgm-setOptText", draft[field] !== true && "smgm-setDim") },
						h("span", { className: "smgm-setOptLabel" }, t(label)),
						h("span", { className: "smgm-setHint" }, t(hint))
					)
				)
			);
			const summary = SETTING_FIELDS.map(
				(field) => t("settings.short." + field) + " " + (effective[field] ? t("settings.on") : t("settings.off"))
			).join(t("settings.sep"));
			const stored = Object.keys(state.value?.stored ?? {}).length > 0;

			return h(
				"div",
				{ className: "smgm-set" },
				head,
				h(
					"div",
					{ className: "smgm-setCard" },
					h("span", { className: "smgm-setLabel" }, t("settings.behaviour")),
					...rows,
					h(
						"div",
						{ className: "smgm-setActions" },
						h(
							"button",
							{ type: "button", className: "smgm-setBtn", disabled: busy !== "", onClick: save },
							busy === "POST" ? t("settings.saving") : t("settings.save")
						),
						h(
							"button",
							{ type: "button", className: "smgm-setBtn smgm-setBtnGhost", disabled: busy !== "", onClick: reset },
							busy === "DELETE" ? t("settings.resetting") : t("settings.reset")
						)
					),
					failure === ""
						? null
						: h(
								"span",
								{ className: "smgm-setHint smgm-setErr", role: "alert" },
								t("settings.rejected") + " " + failure
							),
					message === "" ? null : h("span", { className: "smgm-setHint smgm-setOk", role: "status" }, message)
				),
				h(
					"div",
					{ className: "smgm-setState" },
					h("span", { className: "smgm-setLabel" }, t("settings.current")),
					h("span", null, summary),
					h("span", { className: "smgm-setNote" }, stored ? t("settings.storedAt") : t("settings.notStored")),
					h("span", { className: "smgm-setMono" }, state.value?.file ?? ""),
					h("span", { className: "smgm-setNote" }, t("settings.note"))
				)
			);
		}
		//#endregion
		/** Insert this plugin's stylesheet and own its lifetime. */
		function insertStyles() {
			if (typeof document === "undefined") return () => {};
			for (const stale of document.querySelectorAll("style[data-plugin-css=" + JSON.stringify(STYLE_TAG) + "]")) stale.remove();
			const tag = document.createElement("style");
			tag.dataset.pluginCss = STYLE_TAG;
			tag.textContent = CSS;
			document.head.append(tag);
			return () => tag.remove();
		}
		/** Required Client services: slot registration, navigation and stores. */
		const inject = ["sessions", "uiWorkspace", "slots", "locale", "sidebarRight"];
		/**
		 * Client plugin body: register the newest-first catalog and the panel keeper.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => insertStyles(), "subagent-mgm: styles");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "subagent-mgm: dictionaries");
			const t = ctx.locale.bind(NS);
			// The sidebar's hover cards wait 800ms of dwell before they open, and this
			// plugin's digest is the reason to hover a Session row at all, so the timer
			// that opens them and the grace that lets the previous card linger are both
			// wrapped once here. A failure is not worth breaking the plugin over: the
			// cards keep their shipped delay.
			ctx.effect(() => {
				const installed = installInstantHover(typeof window === "undefined" ? null : window, INSTANT_HOVER_OPEN_MS);
				if (installed === null) {
					console.warn("[subagent-mgm] the hover card delay and hand-off are unchanged");
					return () => {};
				}
				console.warn("[subagent-mgm] hover cards open at once and take turns");
				return () => uninstallInstantHover(window, installed);
			}, "subagent-mgm: instant hover cards");
			const catalogActions = (_parentSessionId) => ({
				openChild(address) {
					ctx.uiWorkspace.openSession(address);
				},
				openChildAside(address) {
					ctx.sidebarRight.openResource(chatAddress(address.parentSessionId, address.childSessionId, address.mode), {
						kind: CHAT_KIND,
						preferNewPane: true
					});
				},
				refreshProjection(parentSessionId) {
					ctx.sessions.refreshProjections(parentSessionId);
				}
			});
			// Same list-slot cell as the shipped catalog action: a lower priority wins,
			// so this entry replaces the stock trigger without touching that plugin.
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "subagent-catalog",
				order: -30,
				priority: -1,
				locale: NS,
				inject: catalogActions
			}, SubagentMgrAction));
			// The lineage slot is single, and the shipped breadcrumb switcher holds it
			// at priority 0: a lower priority is the only way to replace it, so a child
			// session keeps the newest-first ordering instead of falling back.
			ctx.slots.inject("conversation.session.header.lineage", () => ctx.slots.register({
				name: "conversation.session.header.lineage",
				priority: -1,
				locale: NS,
				inject: catalogActions
			}, SubagentMgrLineage));
			// One page in Settings; its label is localized through this plugin's own
			// namespace and re-read on every projection.
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "subagent-mgm",
						order: 37,
						label: () => t("settings.nav"),
						locale: NS
					},
					(props) => h(SettingsSection, { ...props, t })
				)
			);
			ctx.inject(["uiSession", "sidebarRight"], (scope) => {
				scope.effect(() => startSubagentPanels(scope), "subagent-mgm: automatic subagent panels");
			});
			// The sidebar row's hover seat hands over that row's Session id alone, so
			// the digest subscribes to the two client stores itself — from a scope that
			// has the session-status service, the same one the catalog strip reads, so
			// the two agree on what is running.
			ctx.inject(["uiSession"], (scope) => {
				const readStores = () => ({
					projections: scope.sessions.list.getSnapshot().projectionsBySession,
					summaries: scope.sessions.list.getSnapshot().byId,
					statuses: scope.uiSession?.sessionStatus?.getSnapshot()
				});
				const useHoverStores = () => {
					const [snapshot, setSnapshot] = useState(readStores);
					useEffect(() => {
						const update = () => setSnapshot(readStores());
						const stops = [scope.sessions.list.subscribe(update)];
						if (scope.uiSession?.sessionStatus !== undefined) stops.push(scope.uiSession.sessionStatus.subscribe(update));
						return () => {
							for (const stop of stops) stop();
						};
					}, []);
					return snapshot;
				};
				ctx.slots.inject("sidebar.session.row.hover", () => ctx.slots.register({
					name: "sidebar.session.row.hover",
					id: "subagent-digest",
					// Ahead of the schedule occupant (order 10): this section is the
					// shortest of the two and belongs directly under the card's time line.
					order: 5,
					locale: NS
				}, (props) => h(SessionRowHover, { ...props, useHoverStores, t })));
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});