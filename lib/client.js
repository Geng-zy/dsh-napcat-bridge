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
			connectionHint: "NapCat 在「网络配置」里新建 WebSocket 客户端，地址填 ws://<本机地址>:<端口>/ws，Token 与这里一致。改监听地址或端口后插件会自动重新监听，NapCat 会自动重连。",
			host: "监听地址",
			hostHint: "0.0.0.0 表示所有网卡都能连（AstrBot 默认）；NapCat 和 dsh 在同一台机器上时建议填 127.0.0.1。",
			port: "端口",
			portHint: "1–65535，AstrBot 默认 6199。",
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
			portHint: "1–65535; AstrBot uses 6199.",
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
			".napcatb-section+.napcatb-section{border-top:.5px solid var(--dsw-alias-border-l3);padding-top:16px}",
			".napcatb-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;margin:0}",
			".napcatb-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".napcatb-toggle{display:grid;gap:4px}",
			".napcatb-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}",
			".napcatb-field{display:grid;gap:6px}",
			".napcatb-label{color:var(--dsw-alias-label-primary);font-size:13px}",
			".napcatb-select{justify-self:start;min-width:160px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,transparent);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px);padding:6px 8px;font:inherit;font-size:13px}"
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
		function Section(props) {
			return h("section", { className: "napcatb-section" },
				h("h3", { className: "napcatb-title" }, props.title),
				props.hint ? h("p", { className: "napcatb-hint" }, props.hint) : null,
				props.children);
		}

		function Toggle(props) {
			var field = props.state[props.field];
			return h("div", { className: "napcatb-toggle" },
				h("div", { className: "napcatb-toggleRow" },
					h("span", null, props.label),
					h(P.Switch, {
						checked: field.text === "true",
						label: props.label,
						disabled: props.disabled,
						onChange: function (checked) { props.edit(props.field, checked ? "true" : "false"); }
					})),
				props.hint ? h("p", { className: "napcatb-hint" }, props.hint) : null);
		}

		function Value(props) {
			var t = props.t;
			return h(P.SettingsValueField, Object.assign({
				id: "napcat-bridge-" + props.field,
				label: props.label,
				hint: props.hint,
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
				h(Section, { title: t("connection"), hint: t("connectionHint") },
					h(Value, Object.assign({ field: "ws_reverse_host", label: t("host"), hint: t("hostHint") }, common)),
					h(Value, Object.assign({ field: "ws_reverse_port", label: t("port"), hint: t("portHint"), numeric: true, invalidLabel: t("invalidPort") }, common)),
					h(P.SettingsSecretField, {
						id: "napcat-bridge-token",
						label: t("token"),
						hint: t("tokenHint"),
						disabled: disabled,
						text: token.text,
						configured: state.tokenConfigured,
						stateLabel: state.tokenConfigured ? t("tokenSet") : t("tokenUnset"),
						onEdit: function (text) { props.edit("ws_reverse_token", text); }
					}),
					h(Value, Object.assign({ field: "id", label: t("platformId"), hint: t("platformIdHint") }, common))),
				h(Section, { title: t("wake"), hint: t("wakeHint") },
					h(Value, Object.assign({ field: "wake_prefix", label: t("wakePrefix"), hint: t("wakePrefixHint") }, common)),
					h(Toggle, Object.assign({ field: "friend_message_needs_wake_prefix", label: t("friendNeedsPrefix") }, common)),
					h(Toggle, Object.assign({ field: "ignore_bot_self_message", label: t("ignoreSelf") }, common))),
				h(Section, { title: t("model") },
					h(Toggle, Object.assign({ field: "identifier", label: t("identifier"), hint: t("identifierHint") }, common)),
					h(Toggle, Object.assign({ field: "imageToModel", label: t("imageToModel"), hint: t("imageToModelHint") }, common)),
					h(Value, Object.assign({ field: "maxImages", label: t("maxImages"), hint: t("maxImagesHint"), numeric: true, invalidLabel: t("invalidCount") }, common))),
				h(Section, { title: t("session") },
					h(Value, Object.assign({ field: "workspacePath", label: t("workspacePath"), hint: t("workspacePathHint") }, common)),
					h(Value, Object.assign({ field: "agentPreset", label: t("agentPreset"), hint: t("agentPresetHint") }, common))),
				h(Section, { title: t("log") },
					h("label", { className: "napcatb-field", htmlFor: "napcat-bridge-logLevel" },
						h("span", { className: "napcatb-label" }, t("logLevel")),
						h("select", {
							id: "napcat-bridge-logLevel",
							className: "napcatb-select",
							value: state.logLevel.text || "info",
							disabled: disabled,
							onChange: function (event) { props.edit("logLevel", event.target.value); }
						}, LOG_LEVELS.map(function (level) { return h("option", { key: level, value: level }, level); })),
						h("p", { className: "napcatb-hint" }, t("logLevelHint")))));
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
