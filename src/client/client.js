// dsh-napcat-bridge 设置页（浏览器一侧）。
// 注册到 dsh「插件」页的 plugins.bundle.config 扩展点：在插件页打开本插件即可看到。
// 表单读写 dsh 设置服务里本插件的配置行（id: napcat-bridge），保存后插件立即读到新值。
// 只用 dsh 自带的表单组件和 --dsw-* 颜色变量，外观随 dsh 的主题（深色/浅色）变化。
// 这个文件不经过打包，构建时原样复制到 lib/client.js。
window.__ModuleLoader__.load({
	id: "dsh-napcat-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var reactModule = require("react");
		var React = typeof reactModule.createElement === "function" ? reactModule : reactModule.default;
		var P = require("@deepseek-ai/dsh-client-ui-primitives");
		var h = React.createElement;

		/** 词条命名空间 */
		var NS = "napcatBridge";
		/** 插件包名（plugins.bundle.config 的 key） */
		var PACKAGE = "dsh-napcat-bridge";
		/** 设置服务里的配置行 id（cordis.patch.yml 里的 id） */
		var SECTION = "napcat-bridge";

		var zh = {
			summary: "把 NapCat（OneBot v11）接到 dsh，照搬 AstrBot 的 aiocqhttp 适配器。",
			connection: "连接",
			connectionHint: "NapCat 在「网络配置」里新建 WebSocket 客户端，地址填 ws://<地址>:<端口>/ws，Token 与这里一致。改监听地址或端口后插件会自动重新监听，NapCat 会自动重连。",
			host: "监听地址",
			hostHint: "0.0.0.0 表示所有网卡都能连；NapCat 和 dsh 在同一台机器上时可以填 127.0.0.1，只允许本机连。",
			port: "端口",
			portHint: "1–65535。",
			token: "Token",
			tokenHint: "留空表示保持当前 Token。与 NapCat 里填的一致；没有 Token 时不校验，任何人都能连。",
			tokenSet: "已设置 Token。",
			tokenUnset: "没有设置 Token，连接不校验。",
			platformId: "平台 ID",
			platformIdHint: "会话标识的第一段（平台ID:消息类型:会话ID）。改了以后已有的 QQ 会话会对应到新的 dsh 会话。",
			wake: "唤醒",
			wakeHint: "私聊默认都交给模型；群里 @ 她、引用她的消息、或以唤醒前缀开头才交给模型。",
			wakePrefix: "唤醒前缀",
			wakePrefixHint: "多个用空格或逗号分开，例如 / #。全部删掉表示不用前缀唤醒。",
			friendNeedsPrefix: "私聊也需要唤醒前缀",
			ignoreSelf: "忽略她自己发出的消息",
			model: "交给模型的内容",
			identifier: "群消息前面加 [昵称(QQ号)]",
			identifierHint: "让她分得清群里谁在说话。",
			imageToModel: "图片交给模型",
			imageToModelHint: "包括商城表情和被引用消息里的图片。模型要能看图（如 deepseek-flash）。",
			maxImages: "每条消息最多几张图片",
			maxImagesHint: "0 表示不限。",
			session: "会话",
			workspacePath: "工作目录",
			workspacePathHint: "QQ 会话在 dsh 里使用的目录（绝对路径）。留空用 dsh 进程当前目录。只影响新建的会话。",
			agentPreset: "Agent 预设",
			agentPresetHint: "QQ 会话使用的预设 id，留空用默认预设。只影响新建的会话。",
			log: "日志",
			logLevel: "日志级别",
			logLevelHint: "debug 会记录每条收到的原始消息，排查问题时再开。",
			friendNeedsPrefixHint: "打开后私聊也要以唤醒前缀开头才交给模型。",
			ignoreSelfHint: "她在别的设备上用这个 QQ 号发的消息，NapCat 也会推过来；打开后这些消息不交给模型。",
			test: "测试连接",
			testing: "测试中…",
			testUsesSaved: "测试用的是已保存的设置。",
			testOk: "已连接：{who}，Token 校验通过。",
			testOkNoToken: "已连接：{who}。没有设置 Token，任何人都能连。",
			testConnectedApiFailed: "NapCat 已连上，但调用接口没有成功：{error}",
			testRejectedMissing: "{minutes} 分钟内有 NapCat 来连接，但没带 Token。请在 NapCat 里填上和这里一致的 Token。",
			testRejectedWrong: "{minutes} 分钟内有 NapCat 来连接，但 Token 不对。请检查 NapCat 里填的 Token。",
			testNoClient: "插件正在监听 {address}，但还没有 NapCat 连上来。请在 NapCat 里新建 WebSocket 客户端并填对地址和 Token。",
			testNotListening: "插件没有在监听 {address}，可能端口被占用，请换一个端口。",
			testFailed: "测试失败：{error}",
			overridden: "已修改",
			reset: "恢复默认",
			invalid: "格式不对",
			invalidPort: "请填 1–65535 的整数",
			invalidCount: "请填 0 或正整数",
			readOnly: "本部署的设置为只读。",
			unavailable: "插件当前没有加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "没有保存成功，修改已保留，请检查后重试。"
		};
		var en = {
			summary: "Connect NapCat (OneBot v11) to dsh, a port of AstrBot's aiocqhttp adapter.",
			connection: "Connection",
			connectionHint: "In NapCat, add a WebSocket client at ws://<host>:<port>/ws with the same token. Changing the address or port makes the plugin listen again; NapCat reconnects by itself.",
			host: "Listen address",
			hostHint: "0.0.0.0 accepts every interface (AstrBot's default); use 127.0.0.1 when NapCat runs on the same machine.",
			port: "Port",
			portHint: "1–65535.",
			token: "Token",
			tokenHint: "Leave blank to keep the current token. Must match NapCat; without a token, connections are not checked.",
			tokenSet: "A token is set.",
			tokenUnset: "No token: connections are not checked.",
			platformId: "Platform ID",
			platformIdHint: "First part of the session key (platform:type:session). Changing it maps QQ chats to new dsh sessions.",
			wake: "Wake",
			wakeHint: "Private chats always reach the model; in groups only an @, a reply to her, or a wake prefix does.",
			wakePrefix: "Wake prefixes",
			wakePrefixHint: "Separate with spaces or commas, e.g. / #. Remove all to disable prefixes.",
			friendNeedsPrefix: "Private chats need a wake prefix too",
			ignoreSelf: "Ignore messages she sent herself",
			model: "What the model receives",
			identifier: "Prefix group messages with [nickname(QQ)]",
			identifierHint: "So she can tell who is speaking in a group.",
			imageToModel: "Send images to the model",
			imageToModelHint: "Including market stickers and images in quoted messages. The model must accept images (e.g. deepseek-flash).",
			maxImages: "Max images per message",
			maxImagesHint: "0 means no limit.",
			session: "Sessions",
			workspacePath: "Working directory",
			workspacePathHint: "Absolute directory QQ sessions use in dsh; blank uses the dsh process directory. Affects new sessions only.",
			agentPreset: "Agent preset",
			agentPresetHint: "Preset id for QQ sessions; blank uses the default. Affects new sessions only.",
			log: "Logging",
			logLevel: "Log level",
			logLevelHint: "debug logs every raw message; turn it on only while troubleshooting.",
			friendNeedsPrefixHint: "When on, private chats also need a wake prefix to reach the model.",
			ignoreSelfHint: "NapCat also reports messages this QQ account sends from other devices; when on, they are not sent to the model.",
			test: "Test connection",
			testing: "Testing…",
			testUsesSaved: "The test uses the saved settings.",
			testOk: "Connected: {who}; token accepted.",
			testOkNoToken: "Connected: {who}. No token is set, so anyone can connect.",
			testConnectedApiFailed: "NapCat is connected but the API call failed: {error}",
			testRejectedMissing: "Within {minutes} min a NapCat tried to connect without a token. Set the same token in NapCat.",
			testRejectedWrong: "Within {minutes} min a NapCat tried to connect with a wrong token. Check the token in NapCat.",
			testNoClient: "Listening on {address}, but no NapCat has connected. Add a WebSocket client in NapCat with this address and token.",
			testNotListening: "Not listening on {address}; the port may be in use. Try another port.",
			testFailed: "Test failed: {error}",
			overridden: "Changed",
			reset: "Reset",
			invalid: "Invalid value",
			invalidPort: "Enter an integer from 1 to 65535",
			invalidCount: "Enter 0 or a positive integer",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "The plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "Not saved; your edits are kept for you to correct."
		};

		var CSS = [
			".napcatb-section{display:grid;gap:12px;padding:4px 0 8px}",
			".napcatb-section,.napcatb-details+.napcatb-section{border-top:.5px solid var(--dsw-alias-border-l3);padding-top:16px}",
			".napcatb-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;margin:0}",
			".napcatb-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".napcatb-labelText{display:inline-flex;align-items:flex-start;gap:2px}",
			".napcatb-tip{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;margin-top:-4px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:600;line-height:1;cursor:help;user-select:none}",
			".napcatb-tip:hover,.napcatb-tip:focus-visible{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-tertiary);outline:none}",
			".napcatb-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:center;gap:16px;font-size:13px;line-height:1.5;display:flex}",
			".napcatb-field{display:grid;gap:6px}",
			".napcatb-label{color:var(--dsw-alias-label-primary);font-size:13px}",
			".napcatb-select{justify-self:start;min-width:160px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,transparent);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px);padding:6px 8px;font:inherit;font-size:13px}",
			".napcatb-details{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg,10px);padding:0 14px}",
			".napcatb-summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:12px 0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}",
			".napcatb-summary::-webkit-details-marker{display:none}",
			".napcatb-chevron{display:inline-block;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;font-size:16px;line-height:1}",
			".napcatb-details[open] .napcatb-chevron{transform:rotate(90deg)}",
			".napcatb-detailsBody{display:grid;gap:12px;padding:4px 0 16px}",
			".napcatb-test{display:grid;gap:6px;margin-top:-4px}",
			".napcatb-testRow{display:flex;align-items:center;gap:10px}",
			".napcatb-result{margin:0;font-size:12px;line-height:1.5}",
			".napcatb-ok{color:var(--dsw-alias-state-success-primary,#2f9e44)}",
			".napcatb-warn{color:var(--dsw-alias-state-warning-primary,#d97706)}",
			".napcatb-error{color:var(--dsw-alias-state-error-primary)}",
			"@media (prefers-reduced-motion:reduce){.napcatb-chevron{transition:none}}"
		].join("\n");
		var CSS_ID = "dsh-napcat-bridge/settings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = PACKAGE;
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		//#region 字段格式：文字 ↔ 配置值
		function boolField(field) {
			return {
				field: field,
				format: function (v) { return v === true ? "true" : "false"; },
				parse: function (text) { return text === "true" ? { kind: "set", value: true } : text === "false" ? { kind: "set", value: false } : void 0; }
			};
		}
		function intField(field, min, max) {
			return {
				field: field,
				format: function (v) { return typeof v === "number" ? String(v) : ""; },
				parse: function (text) {
					var s = text.trim();
					if (s === "") return { kind: "clear" };
					var n = Number(s);
					return Number.isSafeInteger(n) && n >= min && n <= max ? { kind: "set", value: n } : void 0;
				}
			};
		}
		function listField(field) {
			return {
				field: field,
				format: function (v) { return Array.isArray(v) ? v.join(" ") : ""; },
				parse: function (text) {
					return { kind: "set", value: text.split(/[\s,，]+/).filter(function (x) { return x !== ""; }) };
				}
			};
		}
		function enumField(field, choices) {
			var text = P.settingsTextField(field);
			return {
				field: field,
				format: text.format,
				parse: function (s) { var v = s.trim(); return v === "" ? { kind: "clear" } : choices.indexOf(v) >= 0 ? { kind: "set", value: v } : void 0; }
			};
		}
		var LOG_LEVELS = ["debug", "info", "warn", "error"];
		var BOOLS = ["friend_message_needs_wake_prefix", "ignore_bot_self_message", "identifier", "imageToModel"];
		var TEXTS = ["ws_reverse_host", "id", "workspacePath", "agentPreset"];
		//#endregion

		//#region 表单模型
		function createForm(scope) {
			var specs = [
				intField("ws_reverse_port", 1, 65535),
				intField("maxImages", 0, Number.MAX_SAFE_INTEGER),
				listField("wake_prefix"),
				enumField("logLevel", LOG_LEVELS)
			].concat(BOOLS.map(boolField), TEXTS.map(function (f) { return P.settingsTextField(f); }));
			var secrets = [{
				field: "ws_reverse_token",
				write: function (text) { return scope.mutate([{ op: "set", path: ["ws_reverse_token"], value: text }]); }
			}];
			var form = new P.SettingsFormModel(scope, specs, secrets);
			var all = ["ws_reverse_port", "maxImages", "wake_prefix", "logLevel", "ws_reverse_token"].concat(BOOLS, TEXTS);
			// 设置服务不把 Token 发给浏览器，只告诉它有没有设置；由 refreshToken 向服务查询
			var tokenConfigured = false;
			function compute() {
				var state = Object.assign({}, form.shell());
				all.forEach(function (f) { state[f] = form.field(f); });
				state.tokenConfigured = tokenConfigured;
				return state;
			}
			var store = form.bind(compute);
			return {
				form: form,
				store: store,
				setTokenConfigured: function (value) {
					if (value === tokenConfigured) return;
					tokenConfigured = value;
					store.set(compute());
				}
			};
		}
		//#endregion

		//#region 页面
		/** 名称 + 右上角的小角标；鼠标移上去（或键盘聚焦）显示说明。 */
		function Label(props) {
			if (!props.hint) return props.text;
			return h("span", { className: "napcatb-labelText" },
				props.text,
				h(P.Tooltip, { label: props.hint, side: "top", delayMs: 150, maxWidth: 320 },
					h("span", { className: "napcatb-tip", tabIndex: 0, role: "img", "aria-label": props.hint }, "?")));
		}

		function Section(props) {
			return h("section", { className: "napcatb-section" },
				h("h3", { className: "napcatb-title" }, h(Label, { text: props.title, hint: props.hint })),
				props.children);
		}

		function Toggle(props) {
			var field = props.state[props.field];
			return h("div", { className: "napcatb-toggleRow" },
				h(Label, { text: props.label, hint: props.hint }),
				h(P.Switch, {
					checked: field.text === "true",
					label: props.label,
					disabled: props.disabled,
					onChange: function (checked) { props.edit(props.field, checked ? "true" : "false"); }
				}));
		}

		function Value(props) {
			var t = props.t;
			return h(P.SettingsValueField, Object.assign({
				id: "napcat-bridge-" + props.field,
				label: h(Label, { text: props.label, hint: props.hint }),
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: props.invalidLabel || t("invalid"),
				numeric: props.numeric === true,
				disabled: props.disabled
			}, props.state[props.field], {
				onEdit: function (text) { props.edit(props.field, text); },
				onReset: function () { props.resetField(props.field); }
			}));
		}

		/** 把状态接口的结果写成一句话和语气（ok / warn / error）。 */
		function describeStatus(t, st) {
			if (!st.listening) return { tone: "error", text: t("testNotListening", { address: st.address }) };
			var conns = st.connections || [];
			if (conns.length > 0) {
				if (st.login && st.login.user_id !== undefined && st.login.user_id !== null) {
					var who = (st.login.nickname ? st.login.nickname + " " : "") + "(" + st.login.user_id + ")";
					return { tone: "ok", text: t(st.tokenSet ? "testOk" : "testOkNoToken", { who: who }) };
				}
				return { tone: "warn", text: t("testConnectedApiFailed", { error: st.loginError || "?" }) };
			}
			if (st.lastRejected) {
				var minutes = Math.max(1, Math.round((Date.now() - st.lastRejected.at) / 60000));
				var key = String(st.lastRejected.status).indexOf("401") === 0 ? "testRejectedMissing" : "testRejectedWrong";
				return { tone: "error", text: t(key, { minutes: minutes }) };
			}
			return { tone: "warn", text: t("testNoClient", { address: st.address }) };
		}

		function ConnectionTest(props) {
			var t = props.t;
			var stateHook = React.useState(null);
			var result = stateHook[0], setResult = stateHook[1];
			var busyHook = React.useState(false);
			var busy = busyHook[0], setBusy = busyHook[1];
			function run() {
				setBusy(true);
				var url = new URL("api/napcat-bridge/status", document.baseURI).href;
				fetch(url, { credentials: "same-origin", cache: "no-store" })
					.then(function (res) {
						if (!res.ok) throw new Error("HTTP " + res.status);
						return res.json();
					})
					.then(function (st) { setResult(describeStatus(t, st)); },
						function (error) { setResult({ tone: "error", text: t("testFailed", { error: error && error.message || String(error) }) }); })
					.finally(function () { setBusy(false); });
			}
			return h("div", { className: "napcatb-test" },
				h("div", { className: "napcatb-testRow" },
					h(P.Button, { size: "sm", disabled: busy, onClick: run }, busy ? t("testing") : t("test")),
					props.dirty ? h("span", { className: "napcatb-hint" }, t("testUsesSaved")) : null),
				result ? h("p", { className: "napcatb-result napcatb-" + result.tone, role: "status" }, result.text) : null);
		}

		function SettingsPage(props) {
			var t = props.t;
			if (props.view === "summary") return t("summary");
			var state = props.useNapcatForm(function (s) { return s; });
			var disabled = !state.writable || state.saving;
			var common = { t: t, state: state, disabled: disabled, edit: props.edit, resetField: props.resetField };
			var token = state.ws_reverse_token;
			return h(P.SettingsForm, {
				labels: { unavailable: t("unavailable"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") },
				state: state,
				onSave: props.save,
				onDiscard: props.discard
			},
				h("details", { className: "napcatb-details" },
					h("summary", { className: "napcatb-summary" },
						h("span", { className: "napcatb-chevron", "aria-hidden": true }, "›"),
						h(Label, { text: t("connection"), hint: t("connectionHint") })),
					h("div", { className: "napcatb-detailsBody" },
						h(Value, Object.assign({ field: "ws_reverse_host", label: t("host"), hint: t("hostHint") }, common)),
						h(Value, Object.assign({ field: "ws_reverse_port", label: t("port"), hint: t("portHint"), numeric: true, invalidLabel: t("invalidPort") }, common)),
						h(P.SettingsSecretField, {
							id: "napcat-bridge-token",
							label: h(Label, { text: t("token"), hint: t("tokenHint") }),
							disabled: disabled,
							text: token.text,
							configured: state.tokenConfigured,
							stateLabel: state.tokenConfigured ? t("tokenSet") : t("tokenUnset"),
							onEdit: function (text) { props.edit("ws_reverse_token", text); }
						}),
						h(ConnectionTest, { t: t, dirty: state.dirty }),
						h(Value, Object.assign({ field: "id", label: t("platformId"), hint: t("platformIdHint") }, common)))),
				h(Section, { title: t("wake"), hint: t("wakeHint") },
					h(Value, Object.assign({ field: "wake_prefix", label: t("wakePrefix"), hint: t("wakePrefixHint") }, common)),
					h(Toggle, Object.assign({ field: "friend_message_needs_wake_prefix", label: t("friendNeedsPrefix"), hint: t("friendNeedsPrefixHint") }, common)),
					h(Toggle, Object.assign({ field: "ignore_bot_self_message", label: t("ignoreSelf"), hint: t("ignoreSelfHint") }, common))),
				h(Section, { title: t("model") },
					h(Toggle, Object.assign({ field: "identifier", label: t("identifier"), hint: t("identifierHint") }, common)),
					h(Toggle, Object.assign({ field: "imageToModel", label: t("imageToModel"), hint: t("imageToModelHint") }, common)),
					h(Value, Object.assign({ field: "maxImages", label: t("maxImages"), hint: t("maxImagesHint"), numeric: true, invalidLabel: t("invalidCount") }, common))),
				h(Section, { title: t("session") },
					h(Value, Object.assign({ field: "workspacePath", label: t("workspacePath"), hint: t("workspacePathHint") }, common)),
					h(Value, Object.assign({ field: "agentPreset", label: t("agentPreset"), hint: t("agentPresetHint") }, common))),
				h(Section, { title: t("log") },
					h("div", { className: "napcatb-field" },
						h("label", { className: "napcatb-label", htmlFor: "napcat-bridge-logLevel" }, h(Label, { text: t("logLevel"), hint: t("logLevelHint") })),
						h("select", {
							id: "napcat-bridge-logLevel",
							className: "napcatb-select",
							value: state.logLevel.text || "info",
							disabled: disabled,
							onChange: function (event) { props.edit("logLevel", event.target.value); }
						}, LOG_LEVELS.map(function (level) { return h("option", { key: level, value: level }, level); })))));
		}
		//#endregion

		//#region 入口
		var inject = ["slots", "locale", "configForms", "remote", "remote.settings"];

		function apply(ctx) {
			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "napcat-bridge: dictionaries");
			var scope = ctx.configForms.get(SECTION);
			var model = createForm(scope);
			ctx.effect(function () { return function () { model.form.dispose(); }; }, "napcat-bridge: form");
			var disposed = false;
			ctx.effect(function () { return function () { disposed = true; }; }, "napcat-bridge: lifetime");
			function refreshToken() {
				ctx.remote.settings.describe().then(function (response) {
					if (disposed || !response.ok) return;
					var row = response.value.namespaces.find(function (n) { return n.ns === SECTION; });
					var secret = row && (row.secrets || []).find(function (x) { return x.path.length === 1 && x.path[0] === "ws_reverse_token"; });
					model.setTokenConfigured(secret !== void 0 && secret.set === true);
				}, function () {});
			}
			refreshToken();
			ctx.effect(function () { return scope.subscribe(refreshToken); }, "napcat-bridge: token state");
			ctx.effect(function () {
				return ctx.configForms.whileServed([SECTION], function () {
					return ctx.slots.inject("plugins.bundle.config", function () {
						return ctx.slots.register({
							name: "plugins.bundle.config",
							key: PACKAGE,
							locale: NS,
							inject: function () { return Object.assign({ hooks: { napcatForm: model.store } }, model.form.actions()); }
						}, SettingsPage);
					});
				});
			}, "napcat-bridge: page");
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.SettingsPage = SettingsPage;
		return module.exports;
	}
});
