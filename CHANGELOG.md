# 更新记录

## 0.4.0

- 引用的消息交给模型（照搬 AstrBot 流水线的 quoted_message_parser）：写成 `<Quoted Message>(昵称): 内容</Quoted Message>`；引用的是聊天记录时调 `get_forward_msg` 展开，记录里套着的记录继续展开（最多 32 次）；引用和聊天记录里的图片一起交给模型。
- 直接发来的聊天记录也展开，写成 `<Forward Message>…</Forward Message>`（AstrBot 没有这一项）。
- 设置页：监听地址、端口、Token、平台 ID 放进默认收起的「连接」框；Token 下面加「测试连接」按钮；说明改成名称右上角的小角标，鼠标移上去显示。
- 新增状态接口 `GET <dsh>/api/napcat-bridge/status`（需先登录 dsh 网页，不返回 Token），设置页的测试按钮用它。

## 0.3.0

- 新增设置页：dsh 侧栏「插件」→ dsh-napcat-bridge，全部配置项可在网页里改，保存即生效；外观跟随 dsh 主题。
- 所有配置项改为在线生效：改监听地址或端口时自动重新监听，其他设置下一条消息起生效。
- 每条消息交给模型的图片数量默认不限（`maxImages` 默认 0）。

## 0.2.0

在照搬 AstrBot 的基础上补了这些：

- 消息时间用 QQ 上的发送时间（`timestamp`）。
- 同一条消息 10 分钟内只处理一次（防止 NapCat 配了两个连接或重启时重复推送）。
- @ 查名片、陌生人昵称缓存 10 分钟；群名没带时查一次，缓存 30 分钟。
- 小黄脸写成 `[表情:名字]`；商城表情当图片，文字里写 `[表情:名字]`。
- 通知和请求查真实名字，并写成一句中文描述（`event_text`），撤回通知会带上被撤回的文字。
- 群消息交给模型时前面加 `[昵称(QQ号)]`（配置 `identifier`）。
- 图片（含商城表情、被引用消息里的图片）作为 dsh 附件交给模型（配置 `imageToModel`、`maxImages`）。

## 0.1.0

- 照搬 AstrBot 4.29.1 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。
