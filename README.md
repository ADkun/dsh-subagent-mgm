# dsh-subagent-mgm

DeepSeek Harness Web UI 插件（bundle）：管理子智能体的目录顺序与右侧栏面板。

## 它做什么

1. **子智能体目录按创建时间倒序**。会话顶部「N 个子智能体」的展开菜单里，最新的子智能体排在最上面；展开的每一层下级目录同样按创建时间倒序。行的内容（状态点、标题、模式、活跃耗时、token 数、在侧边栏打开按钮、键盘导航、悬停展开）与原版一致，只改了顺序。点进某个子智能体会话后，会话顶部那枚**面包屑切换器**（列出父会话的兄弟子智能体）同样被接管，也按创建时间倒序；它旁边保留「这个子智能体自己的子目录」计数入口，行为与原版一致。
2. **跟随子智能体自动开合右侧栏面板**。当前屏幕上这个会话有子智能体在运行时，自动在右侧栏打开它的会话；子智能体结束时自动关闭该面板。
   - 已经存在的子智能体被父智能体再次派活（可继续模式）、重新开始工作时同样会自动打开；若它的面板还开在后台标签里，则把它拎到前台并展开右栏，而不是再开一个。
   - 每次运行只自动处理一次：同一个子智能体连续运行期间不会反复把右栏抢回前台，用户可以自己切走。
   - 用户手动提前关闭：该子智能体本次运行期间不会再被自动打开（下次重新运行时会恢复自动打开）。
   - 用户手动打开：插件不会去关它，除非该子智能体结束。
   - 只处理当前会话的**直接**子智能体；面板打开方式是「已在则复用」，不会为每次自动打开强行新建分栏。
3. **设置页**：设置里多一页「子智能体管理」（排在官方插件设置页之后）。四个开关——
   - 子智能体目录/面包屑按创建时间倒序（关掉即回到官方原顺序）；
   - 子智能体开始运行时自动打开右侧栏面板；
   - 子智能体结束时自动关闭该面板；
   - 把已开在后台的面板拎到前台（关掉就完全不抢焦点，只保证面板已存在）。

   保存会写入本插件的设置文件，可一键恢复默认；刷新后仍然生效，页面上同时显示当前生效值与设置文件路径。

## 实现要点

- 浏览器半边通过 `window.__ModuleLoader__.load({ id: 'dsh-subagent-mgm', factory })` 注册，`exports.inject` 声明所需服务：`sessions`、`uiWorkspace`、`slots`、`locale`、`sidebarRight`。
- 目录：以 list slot 的 shadow 机制（同一 `id`、更低 `priority` 生效）接管 `conversation.session.header.actions` 里的 `subagent-catalog` 座位，复用官方 `@deepseek-ai/dsh-client-ui-subagent` 的标记结构、样式与行为，类名前缀改为 `smgm-`，文案注册在自有命名空间 `subagentMgr`。
- 面包屑：子智能体会话的标题位是 single slot `conversation.session.header.lineage`，官方在这里放的就是那枚兄弟切换器。single slot 没有 `id` 可复用，只能用更低的 `priority: -1` 抢在官方（priority 0）前面，否则进入子智能体后会退回原版顺序。
- 面板：订阅 `ctx.sidebarRight.mounted`、`ctx.sidebarRight.openTabs`、`ctx.sessions.list`、`ctx.uiSession.sessionStatus`，每次变更后按「目录 ∩ 运行状态 ∩ 已打开标签」对账；标签地址形如 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`，与官方子智能体聊天资源提供者一致。
- 设置页：在官方 `settings.section`（list slot，scope root）注册一页，`id: subagent-mgm`、`order: 37`、`label: () => t('settings.nav')`。开关存在浏览器侧的订阅式 store 里，目录排序和面板对账各自在每次计算时读一次，所以改完立即生效，不需要重启，也不需要刷新页面。
- 宿主半边：用 `ctx.inject(['webServer'], …)` 注册 `prefix` 路由 `/api/subagent-mgm`，其 `/settings` 支持 GET / POST / DELETE；设置写入 `<DSH_PROFILE_DIR|DSH_HOME|~/.dsh>/subagent-mgm.json`（先写临时文件再 rename 原子替换，权限 0600），字段优先级为「已保存文件 → 本行 Config → 内置默认」，行默认值写在本 bundle 的 `cordis.patch.yml`。路由沿用与 connection 服务相同的同源栅栏：没有认证的非浏览器客户端收到 401，跨站 Origin / 伪造 Host 收到 403。

## 自检

`node verify.mjs`（随包保留，不参与 bundle 装载）：从 `client.js` 原文抽出 `sortNewestFirst`、`chatAddress`、`panelChildId` 与 `startSubagentPanels`，用假上下文驱动对账状态机，覆盖排序、面板身份解析，以及“运行即开 / 结束即关 / 用户关掉不再抢回 / 父智能体再次派活重新打开 / 已开面板只拎到前台不重复开”等断言；第三组是针对面包屑半边的**静态**接线检查（shadow 优先级、兄弟切换器与自身计数入口、展开时补拉子目录、两侧字典与样式类齐全）。共 117 项：除上述行为断言外，还包括设置页开关的行为与静态接线，以及直接驱动宿主路由处理器的 GET / POST / DELETE、越权与方法/字段校验、字段优先级链（临时目录里跑，不碰你自己的设置文件）。页面渲染本身是 React/DOM，只做静态接线检查，不驱动浏览器。

## 安装 / 卸载

安装（在 DSH 里让 agent 执行，或直接用插件管理器的 bundle 安装）：

```
plugin_manager action: install_bundle target: D:\dsh\dsh-subagent-mgm
```

安装后刷新页面生效；若改动的是宿主半边（`index.js` / `cordis.patch.yml`），需要重装 bundle 或重启 dsh 才会装载（只改浏览器半边 `client.js` 刷新即可）。卸载用插件管理器的 `remove_bundle`，目标 `dsh-subagent-mgm`；卸载后官方原版目录立刻恢复（本插件只是 shadow 了那个座位，没有改动官方包）。

## 已知边界

- 「跟随自动开合」只覆盖当前会话的直接子智能体；更深的层级请用目录里的「在侧边栏打开」按钮。
- 自动打开的面板与用户自己打开的面板是同一个标签，因此关闭时两者无差别。
- 需要官方子智能体 UI 的聊天资源（`dsh-resource://subagentchat/...`）；若该提供者不可用，插件只保留目录倒序，并在控制台报错而不是反复重试。