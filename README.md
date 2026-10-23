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
4. 按 AstrBot 的默认唤醒规则决定交不交给模型：
   - **私聊**：都交给模型。
   - **群聊**：@ 机器人、引用机器人的消息、或以唤醒前缀（默认 `/`）开头时才交给模型，唤醒前缀会去掉。
5. 每个会话对应一个 dsh 会话。会话标识按 AstrBot 的 `平台ID:消息类型:会话ID` 来分，群聊的会话 ID 是群号，私聊的是对方 QQ 号。
6. 交给模型的内容：群消息前面加 `[昵称(QQ号)]`；图片（包括商城表情、被引用消息里的图片）作为附件一起交给模型。
7. 模型一轮结束后，把最后一条回复的文字发回去：私聊用 `send_private_msg`，群聊用 `send_group_msg`。

## 和 AstrBot 不同的地方

| | AstrBot | 本插件 |
|---|---|---|
| 消息时间 | 收到的时间 | QQ 上的发送时间 |
| 重复消息 | 照常处理 | 同一条消息（机器人 QQ + 消息 ID）10 分钟内只处理一次 |
| @ 查名片 | 每次都查 | 缓存 10 分钟 |
| 群名 | 用事件里带的（NapCat 常常不带） | 没带时查 `get_group_info`，缓存 30 分钟 |
| 小黄脸 | 只留编号 | 文字里写成 `[表情:微笑]` |
| 商城表情 | NapCat 以图片段发来，当普通图片 | 照样当图片，文字里再写 `[表情:名字]` |
| 通知、请求 | 只有发送者 QQ 号，昵称也填 QQ 号 | 查真实名字，并写一句中文描述放在 `event_text`（谁进群、退群、撤回了什么、戳了谁、加好友等） |
| 群里谁在说话 | 默认不告诉模型 | 群消息前面加 `[昵称(QQ号)]`（`identifier`） |
| 图片 | 由 AstrBot 流水线另外处理 | 作为 dsh 附件交给模型（`imageToModel`），模型要支持看图，如 deepseek-flash |

## 安装

```bash
dsh plugin --profile web add github:Geng-zy/dsh-napcat-bridge#v0.3.0
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
- 改了监听地址或端口，插件会自动换新地址重新监听，NapCat 会自动重连；
- Token 不会显示出来，只提示有没有设置；留空保存表示不改；
- 页面用 dsh 自带的表单组件和颜色，深色/浅色主题自动跟随 dsh。

也可以直接改 profile 的 `cordis.patch.yml`，两边是同一份配置。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `id` | `napcat` | 平台 ID，会话标识的第一段 |
| `ws_reverse_host` | `0.0.0.0` | 监听地址 |
| `ws_reverse_port` | `6199` | 监听端口 |
| `ws_reverse_token` | 空 | 连接 Token，留空则不校验 |
| `wake_prefix` | `["/"]` | 唤醒前缀 |
| `friend_message_needs_wake_prefix` | `false` | 私聊是否也需要唤醒前缀 |
| `ignore_bot_self_message` | `false` | 是否忽略机器人自己发出的消息 |
| `workspacePath` | 空 | QQ 会话的工作目录，留空用 dsh 进程当前目录 |
| `agentPreset` | 空 | QQ 会话使用的 agent 预设 |
| `identifier` | `true` | 群消息交给模型时前面加 `[昵称(QQ号)]` |
| `imageToModel` | `true` | 图片作为附件交给模型 |
| `maxImages` | `0` | 一条消息最多交给模型几张图片，0 = 不限 |
| `logLevel` | `info` | 日志级别 |

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
pnpm install
pnpm run build
pnpm test        # 单元测试
pnpm run e2e     # 端到端：真实 dsh + 假模型接口 + 假 NapCat，需要 dsh 在 PATH 上或设置 DSH_BIN
```

## 许可证

AGPL-3.0-or-later。代码移植自 AstrBot（AGPL-3.0-or-later）和 aiocqhttp（MIT），署名见 [NOTICE.md](NOTICE.md)。
