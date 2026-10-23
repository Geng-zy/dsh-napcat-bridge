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
4. 照 AstrBot 流水线的顺序过一遍：唤醒 → 白名单 → 指令 → 只 @ 不说话时等下一条 → 频率限制 → 语音转文字。唤醒规则同 AstrBot 默认：
   - **私聊**：都交给模型。
   - **群聊**：@ 机器人、引用机器人的消息、或以唤醒前缀（默认 `/`）开头时才交给模型，唤醒前缀会去掉。
5. 每个会话对应一个 dsh 会话（发 /new 或 /reset 换新的），新会话按"管理员私聊 > 私聊/群聊 > 默认"选预设和模型。会话标识按 AstrBot 的 `平台ID:消息类型:会话ID` 来分，群聊的会话 ID 是群号，私聊的是对方 QQ 号。
6. 交给模型的内容：群消息前面加 `[昵称(QQ号)]`；`<system_reminder>` 里写当前时间、群名、发送者是不是管理员；有引用时接上 `<Quoted Message>(昵称): 内容</Quoted Message>`，引用的是聊天记录会逐层展开；直接发来的聊天记录写成 `<Forward Message>`；图片（包括商城表情、引用和聊天记录里的图片）作为附件一起交给模型。
7. 模型一轮结束后，把最后一条回复的文字发回去：私聊用 `send_private_msg`，群聊用 `send_group_msg`。

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

## 安装

```bash
dsh plugin --profile web add github:Geng-zy/dsh-napcat-bridge#v0.5.4
```

然后在 profile 的 `cordis.patch.yml` 里写配置（行 id 固定是 `napcat-bridge`）：

```yaml
- id: napcat-bridge
  config:
    ws_reverse_host: 127.0.0.1
    ws_reverse_port: 6199
    ws_reverse_token: 换成你自己的随机字符串
    workspacePath: /home/you/qq-workspace
```

NapCat 那边在「网络配置」里新建一个 **WebSocket 客户端**：
- 地址填 `ws://127.0.0.1:6199/ws`
- Token 和上面的 `ws_reverse_token` 一致
- 消息格式选 `array`

## 设置页

装好后在 dsh 侧栏 **插件** → **dsh-napcat-bridge** 打开设置页，下面所有配置项都能在网页里改，点保存后立即生效，不用重启 dsh：
- 监听地址、端口、Token、平台 ID 在默认收起的「连接」框里；Token 下面的「测试连接」会告诉你 NapCat 有没有连上、Token 对不对；
- 每项的说明在名称右上角的小角标里，鼠标移上去显示；
- 改了监听地址或端口，插件会自动换新地址重新监听，NapCat 会自动重连；
- Token 不会显示出来，只提示有没有设置；留空保存表示不改；
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
| 会话 | `workspacePath` | 空 | QQ 会话的工作目录 |
| | `uniqueSession` | `false` | 群里每人单独一个会话 |
| | `agentPreset` | 空 | 默认预设 |
| | `adminPrivateAgentPreset` / `privateAgentPreset` / `groupAgentPreset` | 空 | 分类型预设 |
| | `adminPrivateModel` / `privateModel` / `groupModel` | 空 | 分类型模型，写成 `提供方/模型` |
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

// 服务
ctx.napcat.callAction('get_group_info', { group_id: 123 })
ctx.napcat.sendBySession({ platform_name: 'napcat', message_type: 'FriendMessage', session_id: '123' }, { chain: [{ type: 'Plain', text: '你好' }] })
ctx.napcat.sessions()   // [{ umo, sessionId }]
```

## 开发

```bash
scripts/setup-test-env.sh          # 装官方 Node 和 dsh 到 .cache/test-env（DSH_VERSION 可指定 dsh 版本）
scripts/check.sh                   # 安装依赖、编译、单元测试、端到端测试（真实 dsh + 假模型 + 假 NapCat）、扫描密钥
node scripts/check-upstreams.mjs   # 看 dsh、AstrBot、aiocqhttp、NapCat、Linux QQ、QFace、Node 有没有新版本（对照 upstreams.json）
node scripts/update-qface.mjs      # 从 QFace 重新生成小黄脸名字表
```

`lib/` 是编译产物，要提交进仓库（dsh 从 GitHub 安装时不跑构建）。

## 许可证

AGPL-3.0-or-later。代码移植自 AstrBot（AGPL-3.0-or-later）和 aiocqhttp（MIT），署名见 [NOTICE.md](NOTICE.md)。
