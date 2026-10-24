# dsh-napcat-bridge

把 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot v11）接到 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）的插件。

连接方式和消息处理照搬 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 的 aiocqhttp 适配器，只是把接收方从 AstrBot 换成了 dsh，并在它的基础上补了几处（见下面「和 AstrBot 不同的地方」）。这个插件只负责连接和传数据，人设、记忆、权限等交给别的插件。

## 工作方式

1. 插件开一个反向 WebSocket 服务（默认 `0.0.0.0:6199`，路径 `/ws`），NapCat 作为客户端连进来。
   - 握手时校验 `Authorization: Bearer <token>`：缺失返回 401，错误返回 403。
   - 支持 `X-Client-Role` 为 `Universal`、`Event`、`API` 三种连接。
2. NapCat 推来的消息、通知、请求，按 AstrBot 的规则转成统一的消息对象（`AstrBotMessage`）：
   - **文字**：相邻几段合并，前后空白去掉。
   - **@**：调 `get_group_member_info` 查群名片，没有名片再调 `get_stranger_info` 查昵称，在文字里写成 `@名片(QQ号)`。开头 @ 机器人自己的那个不写进文字。
   - **引用**：调 `get_msg` 取回被引用的消息，只取一层。
   - **文件**：调 `get_group_file_url` / `get_private_file_url` 换成下载地址。
   - **markdown**：当文字。
   - **QQ 管家**（2854196310）的消息：忽略。
   - **通知、请求**：不交给模型，只通过事件广播。
3. 每条消息都会发出 dsh 事件 `napcat/message`，给其他插件用。
4. 照 AstrBot 流水线的顺序过一遍：唤醒 → 白名单 → 指令 → 只 @ 不说话时等下一条 → 频率限制 → 语音转文字（视频截图是本插件新增）。唤醒规则同 AstrBot 默认：
   - **私聊**：都交给模型。
   - **群聊**：@ 机器人、引用机器人的消息、或以唤醒前缀（默认 `/`）开头时才交给模型，唤醒前缀会去掉。
5. 每个会话对应一个 dsh 会话（发 /new 或 /reset 换新的），新会话按"管理员私聊 > 私聊/群聊 > 默认"选预设和模型。会话标识按 AstrBot 的 `平台ID:消息类型:会话ID` 来分，群聊的会话 ID 是群号，私聊的是对方 QQ 号。
6. 交给模型的内容：群消息前面加 `[昵称(QQ号)]`；`<system_reminder>` 里写当前时间、群名、发送者是不是管理员；有引用时接上 `<Quoted Message>(昵称): 内容</Quoted Message>`，引用的是聊天记录会逐层展开；直接发来的聊天记录写成 `<Forward Message>`；图片（包括商城表情、引用和聊天记录里的图片）作为附件一起交给模型；视频在文字里写 `[视频]`，有 ffmpeg 时另外截几张画面当图片给模型。交给模型前先发 `napcat/prompt`，其他插件（例如记忆）可以往里加内容。
7. 模型一轮结束后，把最后一条回复的文字发回去：私聊用 `send_private_msg`，群聊用 `send_group_msg`，然后发 `napcat/sent`。发之前按「发消息节奏」像真人一样等一会儿：按打字速度（默认每分钟 60 字，最少 2 秒、最多 30 秒）；群里两条之间至少隔 5 秒、一分钟最多 5 条，超出就排队，排队超过 2 分钟这条就不发。同一个会话的消息按顺序发。

## 和 AstrBot 不同的地方

| | AstrBot | 本插件 |
|---|---|---|
| 消息时间 | 收到的时间 | QQ 上的发送时间 |
| 重复消息 | 照常处理 | 同一条消息（机器人 QQ + 消息 ID）10 分钟内只处理一次 |
| @ 查名片 | 每次都查 | 缓存 10 分钟 |
| 群名 | 用事件里带的（NapCat 常常不带） | 没带时查 `get_group_info`，缓存 30 分钟 |
| 小黄脸 | 只留编号 | 文字里写成 `[表情:微笑]` |
| 商城表情 | NapCat 以图片段发来，当普通图片 | 一样当普通图片交给模型 |
| 通知、请求 | 只有发送者 QQ 号，昵称也填 QQ 号 | 查真实名字，并写一句中文描述放在 `event_text`（谁进群、退群、撤回了什么、戳了谁、加好友等） |
| 群里谁在说话 | 默认不告诉模型 | 群消息前面加 `[昵称(QQ号)]`（`identifier`） |
| 图片 | 由 AstrBot 流水线另外处理 | 作为 dsh 附件交给模型（`imageToModel`），模型要支持看图，如 deepseek-flash |
| 引用 | 流水线整理成 `<Quoted Message>`，展开引用的聊天记录 | 照搬同样的做法 |
| 白名单 | 只认群号或完整会话标识 | 私聊还认 QQ 号 |
| 只 @ 不说话时等下一条 | 等这个会话里任何人的下一条 | 只等那个人的下一条 |
| 管理员身份 | 不告诉模型 | 可以写进 `<system_reminder>` |
| 指令 | 私聊时不带前缀也能触发 | 必须带唤醒前缀，免得聊天里说到 new 也被当成指令 |
| 直接发来的聊天记录 | 不展开 | 展开成 `<Forward Message>` |
| 视频 | 不交给模型 | 文字里写 `[视频]`；有 ffmpeg 时截几张画面当图片交给模型（DeepSeek 模型收不了视频原件），设置页可以一键安装 ffmpeg |
| 发消息节奏 | 没有 | 模拟打字速度；群里限制发言频率（见上面第 7 条） |
| 给其他插件的接口 | — | 交给模型前的 `napcat/prompt`、发出后的 `napcat/sent`、会话信息、换会话、媒体转换（见「给其他插件用」） |

## 安装

```bash
dsh plugin --profile web add github:Geng-zy/dsh-napcat-bridge#v0.9.1
```

然后在 profile 的 `cordis.patch.yml` 里写配置（行 id 固定是 `napcat-bridge`）：

```yaml
- id: napcat-bridge
  config:
    ws_reverse_host: 0.0.0.0
    ws_reverse_port: 6199
    ws_reverse_token: 换成你自己的随机字符串
    workspacePath: /home/you/qq-workspace
```

NapCat 那边在「网络配置」里新建一个 **WebSocket 客户端**：
- 地址填 `ws://127.0.0.1:6199/ws`（NapCat 和 dsh 在同一台机器上时；不在同一台就填 dsh 那台机器的地址）
- Token 和上面的 `ws_reverse_token` 一致
- 消息格式选 `array`

## 设置页

装好后在 dsh 侧栏 **插件** → **dsh-napcat-bridge** 打开设置页，下面所有配置项都能在网页里改，点保存后立即生效，不用重启 dsh：
- 监听地址、端口、Token、平台 ID 在默认收起的「连接」框里；Token 下面的「测试连接」会告诉你 NapCat 有没有连上、Token 对不对；
- 每项的说明在名称右上角的小角标里，鼠标移上去显示；
- 改了监听地址或端口，插件会自动换新地址重新监听，NapCat 会自动重连；
- Token 不会显示出来，只提示有没有设置；留空保存表示不改；
- 「视频」分组显示有没有找到 ffmpeg；Linux（x64 / arm64）上没有时可以点「安装 ffmpeg」，从 GitHub [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) 下载独立版（约 140MB），核对 SHA256 后放进 `<DSH_HOME>/napcat-bridge/ffmpeg/`，不需要管理员权限；
- 页面用 dsh 自带的表单组件和颜色，深色/浅色主题自动跟随 dsh。

也可以直接改 profile 的 `cordis.patch.yml`，两边是同一份配置。

## 配置项

都可以在设置页里改，分组同设置页。

| 分组 | 配置 | 默认值 | 说明 |
|---|---|---|---|
| 连接 | `ws_reverse_host` | `0.0.0.0` | 监听地址 |
| | `ws_reverse_port` | `6199` | 监听端口 |
| | `ws_reverse_token` | 不设 | 连接 Token，不设则不校验 |
| | `id` | `napcat` | 平台 ID，会话标识的第一段 |
| 访问控制 | `admins` | `[]` | 管理员 QQ 号 |
| | `whitelistEnabled` | `true` | 启用白名单（名单为空时不检查） |
| | `whitelist` | `[]` | 群号、QQ 号（私聊）或完整会话标识 |
| | `whitelistIgnoreAdminOnGroup` / `…OnFriend` | `true` | 管理员不受白名单限制 |
| | `whitelistLog` | `true` | 不在白名单时记日志 |
| | `rateLimitCount` / `rateLimitSeconds` / `rateLimitStrategy` | `30` / `60` / `stall` | 频率限制，0 = 不限；stall 排队，discard 丢弃 |
| 唤醒 | `wake_prefix` | `["/"]` | 唤醒前缀 |
| | `friend_message_needs_wake_prefix` | `false` | 私聊也要唤醒前缀 |
| | `ignore_bot_self_message` | `false` | 忽略她自己发出的消息 |
| | `emptyMentionWaiting` / `emptyMentionNeedReply` | `true` / `true` | 只 @ 不说话时等下一条 / 先问一句 |
| 交给模型的内容 | `identifier` | `true` | 群消息前面加 `[昵称(QQ号)]` |
| | `markAdmin` | `true` | 发送者是管理员时告诉模型 |
| | `groupNameDisplay` | `true` | 告诉模型群名 |
| | `datetimeReminder` / `timezone` | `true` / `Asia/Shanghai` | 告诉模型当前时间 |
| | `imageToModel` / `maxImages` | `true` / `0` | 图片交给模型；每条最多几张，0 = 不限 |
| 语音转文字 | `sttMode` | `off` | `off` / `command`（本机命令）/ `openai`（兼容接口） |
| | `sttCommand` | 空 | 本机命令，`{file}` 换成语音文件路径，输出就是文字 |
| | `sttApiUrl` / `sttApiKey` / `sttModel` | 空 | OpenAI 兼容接口（到 /v1 为止）、Key、模型 |
| 视频 | `videoFrames` | `true` | 视频抽帧（找不到 ffmpeg 时自动当作关闭；关掉 `imageToModel` 时也不截） |
| | `videoMaxFrames` | `4` | 每个视频最多截几张，整段平均分布 |
| | `videoSecondsPerFrame` | `5` | 短视频少截：每多少秒最多一张 |
| | `videoMaxEdge` | `1024` | 截图最长边（像素） |
| | `videoMaxMB` / `videoMaxMinutes` | `100` / `10` | 超过这么大或这么长只截封面 |
| | `videoTimeoutSeconds` | `30` | 一个视频最多处理几秒，超时只写 `[视频]` |
| | `ffmpegPath` | 空 | ffmpeg 位置；空 = 先找插件自己装的，再找系统里的 |
| 会话 | `workspacePath` | 空 | QQ 会话的工作目录 |
| | `uniqueSession` | `false` | 群里每人单独一个会话 |
| | `agentPreset` | 空 | 默认预设 |
| | `adminPrivateAgentPreset` / `privateAgentPreset` / `groupAgentPreset` | 空 | 分类型预设 |
| | `adminPrivateModel` / `privateModel` / `groupModel` | 空 | 分类型模型，写成 `提供方/模型`（用 API Key 的 DeepSeek 是 `deepseek-official/deepseek-flash`） |
| | `adminPrivateReasoning` / `privateReasoning` / `groupReasoning` | `high` / `low` / `low` | 分类型思考等级（DeepSeek：`off` / `low` / `high` / `max`）；改了以后，那个会话下一条消息起生效（正在回复的等说完），聊天记录不变 |
| | `silenceToken` | `[不发]` | 她的回复以这个开头时不发出去（主动唤醒时她决定不说话） |
| 发消息节奏 | `typingPrivate` / `typingGroup` | `true` / `true` | 私聊、群里模拟打字 |
| | `typingCharsPerMinute` / `typingMinSeconds` / `typingMaxSeconds` | `60` / `2` / `30` | 打字速度（0 = 不等）、最少和最多等几秒 |
| | `groupMinGapSeconds` / `groupMaxPerWindow` / `groupWindowSeconds` | `5` / `5` / `60` | 同一个群她两条之间至少隔几秒、一段时间里最多几条（0 = 不限） |
| | `sendMaxWaitSeconds` | `120` | 为了守频率最多排队几秒，超过就不发 |
| 指令 | `commandsEnabled` / `noPermissionReply` | `true` / `true` | QQ 指令；没有权限时回一句 |
| 日志 | `logLevel` | `info` | 日志级别 |

## QQ 指令

以唤醒前缀开头：`/help`、`/sid`（查看会话标识，加白名单时用）、`/new`、`/reset`（换一个新的 dsh 会话）、`/stop`（停止她正在进行的回复）。群里 `/new`、`/reset` 只有管理员、群主、群管理能用。

## 给其他插件用

```ts
// 每条消息（包括没唤醒的群消息、通知、请求）
ctx.on('napcat/message', (abm, event, isWake) => {
  abm.session_id   // 群号或对方 QQ 号
  abm.sender       // { user_id, nickname }
  abm.message_str  // 纯文字
  abm.message      // 消息段
  abm.raw_message  // NapCat 原始数据
  abm.timestamp    // QQ 上的发送时间（秒）
  abm.event_text   // 通知和请求的中文描述，例如「小明(42) 撤回了一条消息：……」
})

// 交给模型之前（按顺序等每个监听者，最多等 30 秒）：直接改 payload.content，往前后插文字或图片
ctx.on('napcat/prompt', async payload => {
  payload.info        // 会话信息，见下面 sessionInfo
  payload.newSession  // 这是这个 dsh 会话的第一轮
  payload.message     // 唤醒她的那条消息（AstrBotMessage）
  payload.content.unshift({ type: 'text', text: '<记忆>……</记忆>' })
  payload.content.push({ type: 'image', mediaType: 'image/png', data: '<base64>' })  // 插件一统一交给 dsh 附件服务
})

// 她发出了一条 QQ 消息（一轮说完的回复，或者别的插件用 sendBySession 发的）
ctx.on('napcat/sent', ({ umo, session, text, chain, source, time }) => {})

// QQ 会话换了新的 dsh 会话（/new、/reset，或者调用了 rotateSession）
ctx.on('napcat/session-changed', ({ umo, oldSessionId, newSessionId, reason }) => {})

// 服务
ctx.napcat.callAction('get_group_info', { group_id: 123 })
ctx.napcat.sendBySession({ platform_name: 'napcat', message_type: 'FriendMessage', session_id: '123' }, { chain: [{ type: 'Plain', text: '你好' }] })
ctx.napcat.sessions()                  // [{ umo, sessionId }]
ctx.napcat.sessionInfo(dsh会话id)       // { umo, sessionId, platformId, selfId, type: 'private'|'group', userId?, groupId?, adminPrivate }；
                                       // 建会话之前就登记好，预设里的插件在 setup 时就能查到；不是 QQ 会话时 undefined
ctx.napcat.sessionInfoByUmo(umo)
await ctx.napcat.rotateSession(umo)    // 换一个新的 dsh 会话，旧的留在 dsh 里；返回 { oldSessionId, newSessionId }
await ctx.napcat.wake(umo, 内容)       // 主动唤醒她（来源 plugin:napcat-bridge-wake）；回复照常发到 QQ，以「不发」暗号开头时不发
await ctx.napcat.media.convert(消息段)  // 图片原图、语音转文字、视频截图（按本插件的设置）→ { text, parts, used, failed }
await ctx.napcat.media.admit(内容)      // 交给 dsh 附件服务（插件一在 napcat/prompt 之后会自动做，自己发内容时才用）
```

## 开发

```bash
scripts/setup-test-env.sh          # 装官方 Node 和 dsh 到 .cache/test-env（DSH_VERSION 可指定 dsh 版本）
scripts/check.sh                   # 安装依赖、编译、单元测试、端到端测试（真实 dsh + 假模型 + 假 NapCat）、扫描密钥
node scripts/check-upstreams.mjs   # 看 dsh、AstrBot、aiocqhttp、NapCat、Linux QQ、QFace、Node、ffmpeg 构建有没有新版本（对照 upstreams.json）
node scripts/update-qface.mjs      # 从 QFace 重新生成小黄脸名字表
```

`lib/` 是编译产物，要提交进仓库（dsh 从 GitHub 安装时不跑构建）。

## 许可证

AGPL-3.0-or-later。代码移植自 AstrBot（AGPL-3.0-or-later）和 aiocqhttp（MIT），署名见 [NOTICE.md](NOTICE.md)。一键安装的 ffmpeg 是运行时从 BtbN/FFmpeg-Builds 下载的 LGPL 版，不随本插件分发。
