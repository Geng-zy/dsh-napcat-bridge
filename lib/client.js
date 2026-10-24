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
			workspacePathHint: "QQ 会话在 dsh 里使用的目录（绝对路径）。留空用 dsh 进程当前目录。",
			agentPreset: "默认的 Agent 预设",
			agentPresetHint: "QQ 会话使用的预设 id，留空用 dsh 的默认预设。",
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
			access: "访问控制",
			accessHint: "谁能让她回话，以及每个会话多快能处理一条。管理员在群里和私聊都可以不受白名单限制。",
			admins: "管理员 QQ 号",
			adminsHint: "多个用空格或逗号分开。管理员可以在群里用 /new /reset，可以不受白名单限制，开了「告诉模型管理员身份」时她也会知道。",
			whitelistEnabled: "启用白名单",
			whitelistEnabledHint: "白名单是空的时候不检查，谁都能找她。",
			whitelist: "白名单",
			whitelistHint: "群号、QQ 号（只对私聊有效）或完整会话标识（发 /sid 可以查），多个用空格或逗号分开。",
			wlAdminGroup: "群里管理员不受白名单限制",
			wlAdminFriend: "私聊管理员不受白名单限制",
			wlLog: "不在白名单时记日志",
			wlLogHint: "日志里会写出被挡下的会话标识，方便你加进白名单。",
			rateCount: "频率限制：最多几条",
			rateCountHint: "同一个会话在下面的时间窗口里最多处理几条消息。0 表示不限。",
			rateSeconds: "频率限制：时间窗口（秒）",
			rateSecondsHint: "默认 60 秒。",
			rateStrategy: "超出以后",
			rateStrategyHint: "排队：等窗口过去再处理；丢弃：直接不处理。",
			rateStall: "排队等",
			rateDiscard: "丢弃",
			invalidPositive: "请填正整数",
			emptyWaiting: "只 @ 她不说话时等下一条",
			emptyWaitingHint: "有人只 @ 她、或只发唤醒前缀时，把这个人 60 秒内的下一条当成对她说的。",
			emptyReply: "只 @ 她时先让她问一句",
			emptyReplyHint: "让她先自然地问一句「想聊什么」。",
			markAdmin: "告诉模型管理员身份",
			markAdminHint: "发送者是管理员时，在给模型的提示里写明（本插件新增，AstrBot 没有）。",
			groupName: "告诉模型群名",
			groupNameHint: "在给模型的提示里写上当前群名。",
			datetime: "告诉模型当前时间",
			datetimeHint: "在给模型的提示里写上日期、时间和星期。",
			timezone: "时区",
			timezoneHint: "IANA 时区名，例如 Asia/Shanghai。",
			stt: "语音转文字",
			sttHint: "收到语音时转成文字交给她。关闭时她只会看到「[语音]」。",
			sttMode: "方式",
			sttOff: "关闭",
			sttCommandMode: "本机命令",
			sttOpenai: "OpenAI 兼容接口",
			sttCommand: "命令",
			sttCommandHint: "在 dsh 所在的机器上运行，{file} 换成语音文件路径（wav），命令输出的内容就是转出来的文字。例如 sherpa-onnx 的离线识别命令。",
			sttApiUrl: "接口地址",
			sttApiUrlHint: "写到 /v1 为止，例如 https://api.siliconflow.cn/v1；插件会请求 /audio/transcriptions。",
			sttApiKey: "接口 Key",
			sttApiKeyHint: "不会显示出来；留空表示保持当前 Key。",
			keySet: "已设置 Key。",
			keyUnset: "没有设置 Key。",
			sttModel: "模型",
			sttModelHint: "例如 FunAudioLLM/SenseVoiceSmall。",
			video: "视频",
			videoHint: "DeepSeek 模型看不了视频原件，所以用 ffmpeg 从视频里截几张画面当图片给她看，前面附一句「视频，时长 0:32，以下是截取的 4 张画面」。没有 ffmpeg 或关掉时她只看到「[视频]」。截图也算在「每条消息最多几张图片」里。",
			videoFrames: "视频抽帧",
			videoFramesHint: "找不到 ffmpeg 时自动当作关闭。",
			videoMaxFrames: "每个视频最多截几张",
			videoMaxFramesHint: "在整段视频里平均分布，第一张取开头附近。张数越多看得越全，也越费钱。",
			videoSecondsPerFrame: "短视频少截：每多少秒最多一张",
			videoSecondsPerFrameHint: "默认 5：10 秒的视频只截 2 张，不会硬凑满。",
			videoMaxEdge: "截图最长边（像素）",
			videoMaxEdgeHint: "默认 1024。再大对看清内容帮助不大，只会多花钱。",
			videoMaxMB: "超过多大只截封面（MB）",
			videoMaxMBHint: "太大的视频处理慢，只截一张。",
			videoMaxMinutes: "超过多长只截封面（分钟）",
			videoMaxMinutesHint: "太长的视频只截一张。",
			videoTimeout: "处理超时（秒）",
			videoTimeoutHint: "一个视频最多处理这么久，超时就只写 [视频]。",
			ffmpegPath: "ffmpeg 位置",
			ffmpegPathHint: "一般不用填。留空时先找下面「安装」装到插件目录里的，再找系统里的。",
			ffmpegChecking: "正在查找 ffmpeg…",
			ffmpegFound: "已找到 ffmpeg（{source}）：{version}",
			ffmpegSourceConfigured: "上面填的位置",
			ffmpegSourceBundled: "插件目录",
			ffmpegSourceSystem: "系统里的",
			ffmpegMissing: "没找到 ffmpeg，视频只会写成「[视频]」。可以点下面的「安装 ffmpeg」（要能连上 GitHub）；服务器连不上 GitHub 时，用有管理员权限的用户运行 sudo apt install -y ffmpeg，再点「重新查找」。",
			ffmpegInstall: "安装 ffmpeg",
			ffmpegInstallConfirm: "从 GitHub（BtbN/FFmpeg-Builds）下载独立版 ffmpeg，大约 140MB，核对 SHA256 后放进插件目录，不需要管理员权限，也不改系统。现在安装吗？",
			ffmpegInstallYes: "确认安装",
			ffmpegInstallNo: "取消",
			ffmpegUnsupported: "一键安装只支持 Linux（x64 / arm64），这台机器是 {platform}。请自己安装 ffmpeg，例如 Mac 上运行 brew install ffmpeg。",
			ffmpegDownloading: "正在下载 {asset}：{percent}（{received} / {total} MB）",
			ffmpegVerifying: "正在核对 SHA256…",
			ffmpegExtracting: "正在解压…",
			ffmpegDone: "安装完成：{version}",
			ffmpegFailed: "安装失败：{error}",
			ffmpegRecheck: "重新查找",
			sessionHint: "这些设置只影响新建的会话；已经在聊的会话发 /new 之后才会用上。",
			silenceToken: "「不发」暗号",
			paceSec: "发消息节奏",
			paceHint: "让她像真人一样回消息：发之前按打字速度等一会儿；群里两条之间隔开，一段时间里不刷屏。同一个会话的消息按顺序发。只管她自己的回复（包括主动聊天），别的插件代发的不受影响。",
			typingPrivate: "私聊里模拟打字",
			typingGroup: "群里模拟打字",
			typingCharsPerMinute: "打字速度（每分钟几个字）",
			typingCharsPerMinuteHint: "0 表示不等。默认 60：30 个字等 30 秒。",
			typingMinSeconds: "最少等几秒",
			typingMaxSeconds: "最多等几秒",
			typingMaxSecondsHint: "长回复也不会让人等太久。",
			groupMinGapSeconds: "群里两条之间至少隔几秒",
			groupMaxPerWindow: "群里一段时间最多发几条",
			groupWindowSeconds: "这段时间是几秒",
			sendMaxWaitSeconds: "最多排队等几秒",
			sendMaxWaitSecondsHint: "为了守上面的频率要等太久时，这条就不发了（日志里会记）。",
			silenceTokenHint: "她的回复以这个开头时不发到 QQ。别的插件主动唤醒她（比如定时主动聊天）时，她用它表示这次不说话。留空表示不用暗号。",
			uniqueSession: "群里每人单独一个会话",
			uniqueSessionHint: "打开后同一个群里每个人和她的对话分开记。",
			adminPrivatePreset: "管理员私聊用的预设",
			privatePreset: "私聊用的预设",
			groupPreset: "群聊用的预设",
			presetOverrideHint: "留空就用上一级：管理员私聊 → 私聊 → 默认的 Agent 预设。",
			adminPrivateModel: "管理员私聊用的模型",
			privateModel: "私聊用的模型",
			groupModel: "群聊用的模型",
			modelHint: "写成 提供方/模型，例如 deepseek-official/deepseek-flash（用 API Key 的 DeepSeek）；留空用上一级，都空就用 dsh 的默认模型。",
			adminPrivateReasoning: "管理员私聊的思考等级",
			privateReasoning: "其他私聊的思考等级",
			groupReasoning: "群聊的思考等级",
			reasoningHint: "DeepSeek 的思考深度：不思考 / 低 / 高 / 最高，越高越慢、越费 token。改了以后，这个会话下一条消息起生效（正在回复的等它说完），聊天记录不变。",
			reasoningOff: "不思考（off）",
			reasoningLow: "低（low）",
			reasoningHigh: "高（high）",
			reasoningMax: "最高（max）",
			commands: "指令",
			commandsHint: "以唤醒前缀开头，例如 /help、/sid、/new、/reset、/stop。群里 /new 和 /reset 只有管理员、群主和群管理能用。",
			commandsEnabled: "启用 QQ 里的指令",
			noPermissionReply: "没有权限时回一句",
			noPermissionReplyHint: "关掉的话没有权限的人用指令时她什么都不说。",
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
			access: "Access control",
			accessHint: "Who can get a reply, and how fast each chat is processed. Admins can bypass the allowlist.",
			admins: "Admin QQ numbers",
			adminsHint: "Separate with spaces or commas. Admins can use /new and /reset in groups and may bypass the allowlist.",
			whitelistEnabled: "Enable allowlist",
			whitelistEnabledHint: "An empty allowlist is not enforced.",
			whitelist: "Allowlist",
			whitelistHint: "Group numbers, QQ numbers (private chats) or full session keys (see /sid), separated by spaces or commas.",
			wlAdminGroup: "Admins bypass the allowlist in groups",
			wlAdminFriend: "Admins bypass the allowlist in private chats",
			wlLog: "Log blocked chats",
			wlLogHint: "The log names the blocked session key so you can add it.",
			rateCount: "Rate limit: max messages",
			rateCountHint: "Messages one chat may have processed per window. 0 means no limit.",
			rateSeconds: "Rate limit: window (seconds)",
			rateSecondsHint: "Default 60.",
			rateStrategy: "When exceeded",
			rateStrategyHint: "Queue waits for the window; drop discards the message.",
			rateStall: "Queue",
			rateDiscard: "Drop",
			invalidPositive: "Enter a positive integer",
			emptyWaiting: "Wait after an empty mention",
			emptyWaitingHint: "When someone only @-mentions her or sends just a wake prefix, their next message within 60 s is treated as addressed to her.",
			emptyReply: "Ask back on an empty mention",
			emptyReplyHint: "She first asks what they want to talk about.",
			markAdmin: "Tell the model about admins",
			markAdminHint: "Note in the prompt when the sender is an admin (not in AstrBot).",
			groupName: "Tell the model the group name",
			groupNameHint: "Adds the group name to the prompt.",
			datetime: "Tell the model the time",
			datetimeHint: "Adds date, time and weekday to the prompt.",
			timezone: "Time zone",
			timezoneHint: "IANA name, e.g. Asia/Shanghai.",
			stt: "Speech to text",
			sttHint: "Transcribe voice messages for her. When off she only sees [语音].",
			sttMode: "Method",
			sttOff: "Off",
			sttCommandMode: "Local command",
			sttOpenai: "OpenAI-compatible API",
			sttCommand: "Command",
			sttCommandHint: "Runs on the dsh machine; {file} becomes the voice file path (wav) and its output is the text.",
			sttApiUrl: "API base URL",
			sttApiUrlHint: "Up to /v1, e.g. https://api.siliconflow.cn/v1; the plugin calls /audio/transcriptions.",
			sttApiKey: "API key",
			sttApiKeyHint: "Never shown; leave blank to keep the current key.",
			keySet: "A key is set.",
			keyUnset: "No key is set.",
			sttModel: "Model",
			sttModelHint: "e.g. FunAudioLLM/SenseVoiceSmall.",
			video: "Video",
			videoHint: "DeepSeek models cannot take video, so ffmpeg grabs a few frames and sends them as images with a note such as \"video, 0:32, 4 frames follow\". Without ffmpeg, or when off, she only sees [视频]. Frames count toward the per-message image limit.",
			videoFrames: "Grab video frames",
			videoFramesHint: "Treated as off when ffmpeg is not found.",
			videoMaxFrames: "Max frames per video",
			videoMaxFramesHint: "Spread evenly over the video, the first near the start. More frames show more and cost more.",
			videoSecondsPerFrame: "Short videos: at most one frame per N seconds",
			videoSecondsPerFrameHint: "Default 5: a 10-second clip gets 2 frames.",
			videoMaxEdge: "Frame long edge (px)",
			videoMaxEdgeHint: "Default 1024. Larger rarely helps and costs more.",
			videoMaxMB: "Cover only above (MB)",
			videoMaxMBHint: "Large videos get a single frame.",
			videoMaxMinutes: "Cover only above (minutes)",
			videoMaxMinutesHint: "Long videos get a single frame.",
			videoTimeout: "Timeout (seconds)",
			videoTimeoutHint: "Per video; on timeout she only sees [视频].",
			ffmpegPath: "ffmpeg path",
			ffmpegPathHint: "Usually blank: the copy installed below into the plugin directory is used first, then the system one.",
			ffmpegChecking: "Looking for ffmpeg…",
			ffmpegFound: "ffmpeg found ({source}): {version}",
			ffmpegSourceConfigured: "configured path",
			ffmpegSourceBundled: "plugin directory",
			ffmpegSourceSystem: "system",
			ffmpegMissing: "ffmpeg not found; videos become [视频]. Use Install below (needs GitHub access), or run sudo apt install -y ffmpeg on the server and click Check again.",
			ffmpegInstall: "Install ffmpeg",
			ffmpegInstallConfirm: "Download a static ffmpeg (about 140 MB) from GitHub BtbN/FFmpeg-Builds, verify its SHA256 and put it in the plugin directory. No admin rights needed and the system is not changed. Install now?",
			ffmpegInstallYes: "Install",
			ffmpegInstallNo: "Cancel",
			ffmpegUnsupported: "One-click install supports Linux (x64 / arm64) only; this machine is {platform}. Install ffmpeg yourself, e.g. brew install ffmpeg on a Mac.",
			ffmpegDownloading: "Downloading {asset}: {percent} ({received} / {total} MB)",
			ffmpegVerifying: "Verifying SHA256…",
			ffmpegExtracting: "Extracting…",
			ffmpegDone: "Installed: {version}",
			ffmpegFailed: "Install failed: {error}",
			ffmpegRecheck: "Check again",
			sessionHint: "These apply to new sessions; an existing chat picks them up after /new.",
			silenceToken: "Silence token",
			paceSec: "Sending rhythm",
			paceHint: "Makes her reply like a person: waits by typing speed before sending, and spaces out messages in groups. Messages in one chat keep their order. Only her own replies are affected.",
			typingPrivate: "Simulate typing in private chats",
			typingGroup: "Simulate typing in groups",
			typingCharsPerMinute: "Typing speed (chars/min)",
			typingCharsPerMinuteHint: "0 disables. Default 60.",
			typingMinSeconds: "Minimum wait (s)",
			typingMaxSeconds: "Maximum wait (s)",
			typingMaxSecondsHint: "Caps the wait for long replies.",
			groupMinGapSeconds: "Min gap between group messages (s)",
			groupMaxPerWindow: "Max group messages per window",
			groupWindowSeconds: "Window (s)",
			sendMaxWaitSeconds: "Max queue wait (s)",
			sendMaxWaitSecondsHint: "A message that would wait longer is dropped (logged).",
			silenceTokenHint: "Replies starting with this are not sent. Used when another plugin wakes her and she decides to stay quiet. Blank disables.",
			uniqueSession: "One session per person in groups",
			uniqueSessionHint: "Keeps each person's conversation separate within a group.",
			adminPrivatePreset: "Preset for admin private chats",
			privatePreset: "Preset for private chats",
			groupPreset: "Preset for group chats",
			presetOverrideHint: "Blank falls back: admin private → private → default preset.",
			adminPrivateModel: "Model for admin private chats",
			privateModel: "Model for private chats",
			groupModel: "Model for group chats",
			modelHint: "provider/model, e.g. deepseek-official/deepseek-flash; blank falls back to the next level, then dsh's default model.",
			adminPrivateReasoning: "Reasoning for admin private chats",
			privateReasoning: "Reasoning for other private chats",
			groupReasoning: "Reasoning for group chats",
			reasoningHint: "DeepSeek thinking depth. Takes effect from the chat's next message (after any reply in progress); history is kept.",
			reasoningOff: "Off",
			reasoningLow: "Low",
			reasoningHigh: "High",
			reasoningMax: "Max",
			commands: "Commands",
			commandsHint: "Start with a wake prefix: /help, /sid, /new, /reset, /stop. In groups only admins, the owner and group admins can use /new and /reset.",
			commandsEnabled: "Enable QQ commands",
			noPermissionReply: "Reply when not permitted",
			noPermissionReplyHint: "When off, she stays silent on commands the sender may not use.",
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
			".napcatb-testRow{display:flex;align-items:center;flex-wrap:wrap;gap:10px}",
			".napcatb-confirm{display:grid;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px)}",
			".napcatb-result,.napcatb-hint{overflow-wrap:anywhere}",
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
		var RATE_STRATEGIES = ["stall", "discard"];
		var STT_MODES = ["off", "command", "openai"];
		var REASONING = ["off", "low", "high", "max"];
		var BOOLS = [
			"friend_message_needs_wake_prefix", "ignore_bot_self_message", "identifier", "imageToModel",
			"whitelistEnabled", "whitelistIgnoreAdminOnGroup", "whitelistIgnoreAdminOnFriend", "whitelistLog",
			"emptyMentionWaiting", "emptyMentionNeedReply", "uniqueSession",
			"datetimeReminder", "groupNameDisplay", "markAdmin", "commandsEnabled", "noPermissionReply",
			"videoFrames", "typingPrivate", "typingGroup"
		];
		var TEXTS = [
			"ws_reverse_host", "id", "workspacePath", "agentPreset", "timezone",
			"privateAgentPreset", "groupAgentPreset", "adminPrivateAgentPreset",
			"privateModel", "groupModel", "adminPrivateModel",
			"sttCommand", "sttApiUrl", "sttModel", "ffmpegPath", "silenceToken"
		];
		/** 整数字段：[字段, 最小值] */
		var INTS = [
			["ws_reverse_port", 1, 65535], ["maxImages", 0], ["rateLimitCount", 0], ["rateLimitSeconds", 1],
			["videoMaxFrames", 1], ["videoSecondsPerFrame", 1], ["videoMaxEdge", 64], ["videoMaxMB", 1],
			["videoMaxMinutes", 1], ["videoTimeoutSeconds", 5],
			["typingCharsPerMinute", 0], ["typingMinSeconds", 0], ["typingMaxSeconds", 0], ["groupMinGapSeconds", 0], ["groupMaxPerWindow", 0], ["groupWindowSeconds", 1], ["sendMaxWaitSeconds", 0]
		];
		var LISTS = ["wake_prefix", "admins", "whitelist"];
		var SECRETS = ["ws_reverse_token", "sttApiKey"];
		//#endregion

		//#region 表单模型
		function createForm(scope) {
			var specs = INTS.map(function (x) { return intField(x[0], x[1], x[2] === undefined ? Number.MAX_SAFE_INTEGER : x[2]); }).concat([
				enumField("logLevel", LOG_LEVELS),
				enumField("rateLimitStrategy", RATE_STRATEGIES),
				enumField("sttMode", STT_MODES),
				enumField("adminPrivateReasoning", REASONING), enumField("privateReasoning", REASONING), enumField("groupReasoning", REASONING)
			], LISTS.map(listField), BOOLS.map(boolField), TEXTS.map(function (f) { return P.settingsTextField(f); }));
			var secrets = SECRETS.map(function (field) {
				return { field: field, write: function (text) { return scope.mutate([{ op: "set", path: [field], value: text }]); } };
			});
			var form = new P.SettingsFormModel(scope, specs, secrets);
			var all = INTS.map(function (x) { return x[0]; }).concat(["logLevel", "rateLimitStrategy", "sttMode", "adminPrivateReasoning", "privateReasoning", "groupReasoning"], LISTS, BOOLS, TEXTS, SECRETS);
			// 设置服务不把密钥发给浏览器，只告诉它有没有设置；由 refreshSecrets 向服务查询
			var secretSet = {};
			function compute() {
				var state = Object.assign({}, form.shell());
				all.forEach(function (f) { state[f] = form.field(f); });
				state.secretSet = Object.assign({}, secretSet);
				return state;
			}
			var store = form.bind(compute);
			return {
				form: form,
				store: store,
				setSecrets: function (next) {
					if (JSON.stringify(next) === JSON.stringify(secretSet)) return;
					secretSet = next;
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

		/** ffmpeg 状态和一键安装（GET/POST <dsh>/api/napcat-bridge/ffmpeg[/install]）。 */
		function FfmpegStatus(props) {
			var t = props.t;
			var stHook = React.useState(null);
			var st = stHook[0], setSt = stHook[1];
			var errHook = React.useState(null);
			var err = errHook[0], setErr = errHook[1];
			var url = function (path) { return new URL("api/napcat-bridge/" + path, document.baseURI).href; };
			function load(method, path) {
				return fetch(url(path), { method: method, credentials: "same-origin", cache: "no-store" })
					.then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
					.then(function (next) { setErr(null); setSt(next); return next; },
						function (error) { setErr(error && error.message || String(error)); });
			}
			React.useEffect(function () { load("GET", "ffmpeg"); }, []);
			var busy = st && st.install && ["downloading", "verifying", "extracting"].indexOf(st.install.state) >= 0;
			React.useEffect(function () {
				if (!busy) return void 0;
				var timer = setInterval(function () { load("GET", "ffmpeg"); }, 1000);
				return function () { clearInterval(timer); };
			}, [busy]);
			// 页面内确认（不用 window.confirm：dsh 桌面端里浏览器弹窗可能不显示）
			var askHook = React.useState(false);
			var asking = askHook[0], setAsking = askHook[1];
			function install() {
				setAsking(false);
				load("POST", "ffmpeg/install");
			}
			var mb = function (n) { return typeof n === "number" ? (n / 1048576).toFixed(0) : "?"; };
			var lines = [];
			if (err) lines.push({ tone: "error", text: t("testFailed", { error: err }) });
			else if (!st) lines.push({ tone: "hint", text: t("ffmpegChecking") });
			else {
				if (st.found) {
					var source = t(st.found.source === "configured" ? "ffmpegSourceConfigured" : st.found.source === "bundled" ? "ffmpegSourceBundled" : "ffmpegSourceSystem");
					lines.push({ tone: "ok", text: t("ffmpegFound", { source: source, version: st.found.version }) });
				} else {
					lines.push({ tone: "warn", text: t("ffmpegMissing") });
					if (!st.installSupported) lines.push({ tone: "hint", text: t("ffmpegUnsupported", { platform: st.platform }) });
				}
				var ins = st.install || { state: "idle" };
				if (ins.state === "downloading") {
					var percent = ins.total ? Math.floor((ins.received || 0) * 100 / ins.total) + "%" : "…";
					lines.push({ tone: "hint", text: t("ffmpegDownloading", { asset: ins.asset || "ffmpeg", percent: percent, received: mb(ins.received), total: mb(ins.total) }) });
				} else if (ins.state === "verifying") lines.push({ tone: "hint", text: t("ffmpegVerifying") });
				else if (ins.state === "extracting") lines.push({ tone: "hint", text: t("ffmpegExtracting") });
				else if (ins.state === "done") lines.push({ tone: "ok", text: t("ffmpegDone", { version: ins.version || "" }) });
				else if (ins.state === "failed") lines.push({ tone: "error", text: t("ffmpegFailed", { error: ins.error || "?" }) });
			}
			var canInstall = st && !st.found && st.installSupported && !busy;
			return h("div", { className: "napcatb-test" },
				canInstall && asking ? h("div", { className: "napcatb-confirm", role: "group", "aria-label": t("ffmpegInstall") },
					h("p", { className: "napcatb-hint" }, t("ffmpegInstallConfirm")),
					h("div", { className: "napcatb-testRow" },
						h(P.Button, { size: "sm", onClick: install }, t("ffmpegInstallYes")),
						h(P.Button, { size: "sm", onClick: function () { setAsking(false); } }, t("ffmpegInstallNo")))) : null,
				h("div", { className: "napcatb-testRow" },
					canInstall && !asking ? h(P.Button, { size: "sm", onClick: function () { setAsking(true); } }, t("ffmpegInstall")) : null,
					h(P.Button, { size: "sm", disabled: busy, onClick: function () { load("GET", "ffmpeg"); } }, t("ffmpegRecheck"))),
				lines.map(function (line, i) {
					return h("p", { key: i, className: line.tone === "hint" ? "napcatb-hint" : "napcatb-result napcatb-" + line.tone, role: i === 0 ? "status" : void 0 }, line.text);
				}));
		}

		function Select(props) {
			var field = props.state[props.field];
			return h("div", { className: "napcatb-field" },
				h("label", { className: "napcatb-label", htmlFor: "napcat-bridge-" + props.field }, h(Label, { text: props.label, hint: props.hint })),
				h("select", {
					id: "napcat-bridge-" + props.field,
					className: "napcatb-select",
					value: field.text || props.fallback,
					disabled: props.disabled,
					onChange: function (event) { props.edit(props.field, event.target.value); }
				}, props.options.map(function (o) { return h("option", { key: o.value, value: o.value }, o.label); })));
		}

		function Secret(props) {
			var t = props.t;
			var set = props.state.secretSet[props.field] === true;
			return h(P.SettingsSecretField, {
				id: "napcat-bridge-" + props.field,
				label: h(Label, { text: props.label, hint: props.hint }),
				disabled: props.disabled,
				text: props.state[props.field].text,
				configured: set,
				stateLabel: set ? props.setLabel : props.unsetLabel,
				onEdit: function (text) { props.edit(props.field, text); }
			});
		}

		function SettingsPage(props) {
			var t = props.t;
			if (props.view === "summary") return t("summary");
			var state = props.useNapcatForm(function (s) { return s; });
			var disabled = !state.writable || state.saving;
			var common = { t: t, state: state, disabled: disabled, edit: props.edit, resetField: props.resetField };
			var sttMode = state.sttMode.text || "off";
			var reasoningOptions = REASONING.map(function (v) { return { value: v, label: t("reasoning" + v.charAt(0).toUpperCase() + v.slice(1)) }; });
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
						h(Secret, Object.assign({ field: "ws_reverse_token", label: t("token"), hint: t("tokenHint"), setLabel: t("tokenSet"), unsetLabel: t("tokenUnset") }, common)),
						h(ConnectionTest, { t: t, dirty: state.dirty }),
						h(Value, Object.assign({ field: "id", label: t("platformId"), hint: t("platformIdHint") }, common)))),
				h(Section, { title: t("access"), hint: t("accessHint") },
					h(Value, Object.assign({ field: "admins", label: t("admins"), hint: t("adminsHint") }, common)),
					h(Toggle, Object.assign({ field: "whitelistEnabled", label: t("whitelistEnabled"), hint: t("whitelistEnabledHint") }, common)),
					h(Value, Object.assign({ field: "whitelist", label: t("whitelist"), hint: t("whitelistHint") }, common)),
					h(Toggle, Object.assign({ field: "whitelistIgnoreAdminOnGroup", label: t("wlAdminGroup") }, common)),
					h(Toggle, Object.assign({ field: "whitelistIgnoreAdminOnFriend", label: t("wlAdminFriend") }, common)),
					h(Toggle, Object.assign({ field: "whitelistLog", label: t("wlLog"), hint: t("wlLogHint") }, common)),
					h(Value, Object.assign({ field: "rateLimitCount", label: t("rateCount"), hint: t("rateCountHint"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "rateLimitSeconds", label: t("rateSeconds"), hint: t("rateSecondsHint"), numeric: true, invalidLabel: t("invalidPositive") }, common)),
					h(Select, Object.assign({ field: "rateLimitStrategy", label: t("rateStrategy"), hint: t("rateStrategyHint"), fallback: "stall", options: [{ value: "stall", label: t("rateStall") }, { value: "discard", label: t("rateDiscard") }] }, common))),
				h(Section, { title: t("wake"), hint: t("wakeHint") },
					h(Value, Object.assign({ field: "wake_prefix", label: t("wakePrefix"), hint: t("wakePrefixHint") }, common)),
					h(Toggle, Object.assign({ field: "friend_message_needs_wake_prefix", label: t("friendNeedsPrefix"), hint: t("friendNeedsPrefixHint") }, common)),
					h(Toggle, Object.assign({ field: "ignore_bot_self_message", label: t("ignoreSelf"), hint: t("ignoreSelfHint") }, common)),
					h(Toggle, Object.assign({ field: "emptyMentionWaiting", label: t("emptyWaiting"), hint: t("emptyWaitingHint") }, common)),
					h(Toggle, Object.assign({ field: "emptyMentionNeedReply", label: t("emptyReply"), hint: t("emptyReplyHint") }, common))),
				h(Section, { title: t("model") },
					h(Toggle, Object.assign({ field: "identifier", label: t("identifier"), hint: t("identifierHint") }, common)),
					h(Toggle, Object.assign({ field: "markAdmin", label: t("markAdmin"), hint: t("markAdminHint") }, common)),
					h(Toggle, Object.assign({ field: "groupNameDisplay", label: t("groupName"), hint: t("groupNameHint") }, common)),
					h(Toggle, Object.assign({ field: "datetimeReminder", label: t("datetime"), hint: t("datetimeHint") }, common)),
					h(Value, Object.assign({ field: "timezone", label: t("timezone"), hint: t("timezoneHint") }, common)),
					h(Toggle, Object.assign({ field: "imageToModel", label: t("imageToModel"), hint: t("imageToModelHint") }, common)),
					h(Value, Object.assign({ field: "maxImages", label: t("maxImages"), hint: t("maxImagesHint"), numeric: true, invalidLabel: t("invalidCount") }, common))),
				h(Section, { title: t("stt"), hint: t("sttHint") },
					h(Select, Object.assign({ field: "sttMode", label: t("sttMode"), fallback: "off", options: [{ value: "off", label: t("sttOff") }, { value: "command", label: t("sttCommandMode") }, { value: "openai", label: t("sttOpenai") }] }, common)),
					sttMode === "command" ? h(Value, Object.assign({ field: "sttCommand", label: t("sttCommand"), hint: t("sttCommandHint") }, common)) : null,
					sttMode === "openai" ? h(Value, Object.assign({ field: "sttApiUrl", label: t("sttApiUrl"), hint: t("sttApiUrlHint") }, common)) : null,
					sttMode === "openai" ? h(Secret, Object.assign({ field: "sttApiKey", label: t("sttApiKey"), hint: t("sttApiKeyHint"), setLabel: t("keySet"), unsetLabel: t("keyUnset") }, common)) : null,
					sttMode === "openai" ? h(Value, Object.assign({ field: "sttModel", label: t("sttModel"), hint: t("sttModelHint") }, common)) : null),
				h(Section, { title: t("video"), hint: t("videoHint") },
					h(Toggle, Object.assign({ field: "videoFrames", label: t("videoFrames"), hint: t("videoFramesHint") }, common)),
					h(FfmpegStatus, { t: t }),
					h(Value, Object.assign({ field: "videoMaxFrames", label: t("videoMaxFrames"), hint: t("videoMaxFramesHint"), numeric: true, invalidLabel: t("invalidPositive") }, common)),
					h(Value, Object.assign({ field: "videoSecondsPerFrame", label: t("videoSecondsPerFrame"), hint: t("videoSecondsPerFrameHint"), numeric: true, invalidLabel: t("invalidPositive") }, common)),
					h(Value, Object.assign({ field: "videoMaxEdge", label: t("videoMaxEdge"), hint: t("videoMaxEdgeHint"), numeric: true, invalidLabel: t("invalid") }, common)),
					h(Value, Object.assign({ field: "videoMaxMB", label: t("videoMaxMB"), hint: t("videoMaxMBHint"), numeric: true, invalidLabel: t("invalidPositive") }, common)),
					h(Value, Object.assign({ field: "videoMaxMinutes", label: t("videoMaxMinutes"), hint: t("videoMaxMinutesHint"), numeric: true, invalidLabel: t("invalidPositive") }, common)),
					h(Value, Object.assign({ field: "videoTimeoutSeconds", label: t("videoTimeout"), hint: t("videoTimeoutHint"), numeric: true, invalidLabel: t("invalid") }, common)),
					h(Value, Object.assign({ field: "ffmpegPath", label: t("ffmpegPath"), hint: t("ffmpegPathHint") }, common))),
				h(Section, { title: t("session"), hint: t("sessionHint") },
					h(Value, Object.assign({ field: "workspacePath", label: t("workspacePath"), hint: t("workspacePathHint") }, common)),
					h(Toggle, Object.assign({ field: "uniqueSession", label: t("uniqueSession"), hint: t("uniqueSessionHint") }, common)),
					h(Value, Object.assign({ field: "agentPreset", label: t("agentPreset"), hint: t("agentPresetHint") }, common)),
					h(Value, Object.assign({ field: "adminPrivateAgentPreset", label: t("adminPrivatePreset"), hint: t("presetOverrideHint") }, common)),
					h(Value, Object.assign({ field: "privateAgentPreset", label: t("privatePreset"), hint: t("presetOverrideHint") }, common)),
					h(Value, Object.assign({ field: "groupAgentPreset", label: t("groupPreset"), hint: t("presetOverrideHint") }, common)),
					h(Value, Object.assign({ field: "adminPrivateModel", label: t("adminPrivateModel"), hint: t("modelHint") }, common)),
					h(Value, Object.assign({ field: "privateModel", label: t("privateModel"), hint: t("modelHint") }, common)),
					h(Value, Object.assign({ field: "groupModel", label: t("groupModel"), hint: t("modelHint") }, common)),
					h(Select, Object.assign({ field: "adminPrivateReasoning", label: t("adminPrivateReasoning"), hint: t("reasoningHint"), fallback: "high", options: reasoningOptions }, common)),
					h(Select, Object.assign({ field: "privateReasoning", label: t("privateReasoning"), hint: t("reasoningHint"), fallback: "low", options: reasoningOptions }, common)),
					h(Select, Object.assign({ field: "groupReasoning", label: t("groupReasoning"), hint: t("reasoningHint"), fallback: "low", options: reasoningOptions }, common)),
					h(Value, Object.assign({ field: "silenceToken", label: t("silenceToken"), hint: t("silenceTokenHint") }, common))),
				h(Section, { title: t("paceSec"), hint: t("paceHint") },
					h(Toggle, Object.assign({ field: "typingPrivate", label: t("typingPrivate") }, common)),
					h(Toggle, Object.assign({ field: "typingGroup", label: t("typingGroup") }, common)),
					h(Value, Object.assign({ field: "typingCharsPerMinute", label: t("typingCharsPerMinute"), hint: t("typingCharsPerMinuteHint"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "typingMinSeconds", label: t("typingMinSeconds"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "typingMaxSeconds", label: t("typingMaxSeconds"), hint: t("typingMaxSecondsHint"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "groupMinGapSeconds", label: t("groupMinGapSeconds"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "groupMaxPerWindow", label: t("groupMaxPerWindow"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "groupWindowSeconds", label: t("groupWindowSeconds"), numeric: true, invalidLabel: t("invalidCount") }, common)),
					h(Value, Object.assign({ field: "sendMaxWaitSeconds", label: t("sendMaxWaitSeconds"), hint: t("sendMaxWaitSecondsHint"), numeric: true, invalidLabel: t("invalidCount") }, common))),
				h(Section, { title: t("commands"), hint: t("commandsHint") },
					h(Toggle, Object.assign({ field: "commandsEnabled", label: t("commandsEnabled") }, common)),
					h(Toggle, Object.assign({ field: "noPermissionReply", label: t("noPermissionReply"), hint: t("noPermissionReplyHint") }, common))),
				h(Section, { title: t("log") },
					h(Select, Object.assign({ field: "logLevel", label: t("logLevel"), hint: t("logLevelHint"), fallback: "info", options: LOG_LEVELS.map(function (l) { return { value: l, label: l }; }) }, common))));
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
					var next = {};
					((row && row.secrets) || []).forEach(function (x) { if (x.path.length === 1) next[x.path[0]] = x.set === true; });
					model.setSecrets(next);
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
