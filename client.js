/**
 * Browser half of dsh-subagent-mgm.
 *
 * Two behaviours for the DSH Web UI:
 *  1. The subagent catalog trigger in the conversation header lists subagents
 *     newest-first (by `createdAt`), at every nesting level.
 *  2. A running direct subagent of the on-screen session gets its chat panel in
 *     the right sidebar automatically, and that panel closes when the subagent
 *     ends. Closing it by hand while the subagent still runs is respected.
 *
 * A Settings page in the settings.section slot switches all of it on and off.
 * The switches are stored by this bundle's host half behind
 * /api/subagent-mgm/settings, so they survive a reload.
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
		const HOVER_OPEN_DELAY = 150;
		const HOVER_CLOSE_DELAY = 120;
		/** Same-origin route backed by this bundle's host half. */
		const SETTINGS_ROUTE = "/api/subagent-mgm/settings";
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
.smgm-menuBody>.smgm-node{margin-left:-2px}
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
			"settings.note": "这些开关只影响本插件的界面行为，保存后立即生效，不需要重启。"
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
			"settings.note": "These switches only steer this plugin's UI; a save takes effect at once and needs no restart."
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
		function CatalogRows({ parentSessionId, currentSessionId, catalog, projections, summaries, statuses, expanded, level, openChild, openChildAside, refreshProjection, toggleBranch, closeCatalog, t }) {
			const [now, setNow] = useState(() => Date.now());
			const settings = useSettings();
			const entries = catalog?.entries ?? [];
			const rows = settings.newestFirst ? sortNewestFirst(entries) : entries;
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
				const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage);
				const tokenMetric = totalTokens === undefined ? undefined : t("tokens.total", { value: formatTokens(totalTokens, t) });
				const durationMs = activityDuration(summary, activity, now);
				const durationMetric = durationMs === undefined ? undefined : {
					compact: formatDuration(durationMs, t),
					exact: formatExactDuration(durationMs, t)
				};
				const metrics = [tokenMetric, durationMetric?.exact].filter((value) => value !== undefined).join(" · ");
				const isExpanded = expanded.has(entry.id);
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
					if (knownLeaf) return;
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
							h("span", { className: "smgm-metricToken" }, tokenMetric ?? ""),
							h("span", {
								className: "smgm-metricDuration",
								title: durationMetric === undefined ? undefined : t("duration.exactTitle", { duration: durationMetric.exact })
							}, durationMetric?.compact ?? "")),
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
					t
				})) : null;
				return h("div", { className: "smgm-node", key: entry.id }, row, children);
			}));
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

			const positionMenu = useCallback(() => {
				const trigger = triggerRef.current;
				if (trigger === null) return;
				const rect = trigger.getBoundingClientRect();
				const width = Math.min(MENU_WIDTH, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
				setMenuPosition({
					top: rect.bottom + 5,
					left: Math.min(Math.max(MENU_VIEWPORT_MARGIN, rect.left), window.innerWidth - width - MENU_VIEWPORT_MARGIN)
				});
			}, []);

			const changeOpen = useCallback((next) => {
				if (next) {
					positionMenu();
					correctedRef.current = false;
				} else {
					setExpanded(new Set());
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
				className: "smgm-menu",
				style: menuPosition,
				onMouseEnter: cancelHoverClose,
				onMouseLeave: scheduleHoverClose
			}, h("div", {
				className: "smgm-menuBody",
				role: "tree",
				"aria-label": t("tree.aria"),
				onKeyDown: onMenuKeyDown
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
				t
			})));

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
			const readPanels = (parentSessionId) => {
				const tabs = inventory.getSnapshot() ?? [];
				return tabs.filter((tab) => tab !== null && typeof tab === "object" && tab.sessionId === parentSessionId && tab.kind === CHAT_KIND);
			};
			const isRunning = (childSessionId) => {
				const status = ctx.uiSession.sessionStatus.getSnapshot().get(childSessionId);
				if (status !== undefined && status.running !== undefined) return status.running;
				return ctx.sessions.list.getSnapshot().byId?.[childSessionId]?.running === true;
			};

			const reconcile = () => {
				const settings = settingsStore.getSnapshot();
				const current = sidebar.mounted.getSnapshot();
				if (current === undefined) {
					mounted = undefined;
					return;
				}
				if (mounted !== current) {
					mounted = current;
					seen.clear();
					wasRunning.clear();
					handled.clear();
					refreshed.clear();
				}
				const catalog = readCatalog(mounted);
				if (catalog === undefined) {
					if (!refreshed.has(mounted)) {
						refreshed.add(mounted);
						ctx.sessions.refreshProjections(mounted).catch(() => {});
					}
					return;
				}
				const panels = readPanels(mounted);
				const present = new Set();
				for (const entry of catalog) {
					if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
					present.add(entry.id);
					const address = chatAddress(mounted, entry.id, entry.mode);
					const panel = panels.find((tab) => panelChildId(tab.contentId) === entry.id);
					const running = isRunning(entry.id);
					if (panel !== undefined) {
						seen.add(entry.id);
						suppressed.delete(entry.id);
					}
					if (!running) {
						if (settings.autoClose && panel !== undefined && wasRunning.has(entry.id)) {
							try {
								sidebar.closeIn(mounted, panel.tabId);
							} catch (error) {
								console.error("[subagent-mgm] closing an ended subagent panel failed", error);
							}
						}
						wasRunning.delete(entry.id);
						handled.delete(entry.id);
						// A finished run forgets the observation, so this plugin's own
						// close can never be mistaken for the user closing the panel
						// when the parent resumes the same child.
						seen.delete(entry.id);
						if (panel === undefined) suppressed.delete(entry.id);
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
						sidebar.openResourceIn(mounted, target, { kind: CHAT_KIND });
					} catch (error) {
						suppressed.add(entry.id);
						console.error("[subagent-mgm] opening a subagent panel failed", error);
					}
				}
				for (const childSessionId of [...seen]) if (!present.has(childSessionId)) seen.delete(childSessionId);
				for (const childSessionId of [...wasRunning]) if (!present.has(childSessionId)) wasRunning.delete(childSessionId);
				for (const childSessionId of [...handled]) if (!present.has(childSessionId)) handled.delete(childSessionId);
				for (const childSessionId of [...suppressed]) if (!present.has(childSessionId)) suppressed.delete(childSessionId);
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
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});