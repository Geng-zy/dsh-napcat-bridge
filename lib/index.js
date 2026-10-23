// dsh 插件入口：照 AstrBot 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。
import z from '@deepseek-ai/schemastery';
import { AiocqhttpAdapter, MessageType } from './adapter.js';
import { Bridge } from './bridge.js';
import { SessionStore, defaultDataDir } from './store.js';
import { join } from 'node:path';
export * from './adapter.js';
export * from './components.js';
export { ActionFailed, ApiNotAvailable, NetworkError } from './onebot/errors.js';
// 每项都标 .volatile()：dsh 的设置服务只对这种字段提供在线编辑，保存后插件不重启、直接读到新值。
export const Config = z.object({
    id: z.string().default('napcat').volatile().description('平台 ID，会话标识 unified_msg_origin 的第一段（AstrBot 的机器人 ID）'),
    ws_reverse_host: z.string().default('0.0.0.0').volatile().description('反向 WebSocket 监听地址（AstrBot 默认 0.0.0.0）'),
    ws_reverse_port: z.natural().max(65535).default(6199).volatile().description('反向 WebSocket 端口（AstrBot 默认 6199）'),
    ws_reverse_token: z.string().role('secret').volatile().description('反向 WebSocket Token，与 NapCat 里填的一致；留空则不校验'),
    wake_prefix: z.array(z.string()).default(['/']).volatile().description('唤醒前缀（AstrBot 默认 ["/"]）'),
    friend_message_needs_wake_prefix: z.boolean().default(false).volatile().description('私聊是否也需要唤醒前缀'),
    ignore_bot_self_message: z.boolean().default(false).volatile().description('是否忽略机器人自己发出的消息'),
    workspacePath: z.string().default('').volatile().description('QQ 会话的工作目录（绝对路径）；留空用 dsh 进程当前目录'),
    agentPreset: z.string().default('').volatile().description('QQ 会话使用的 agent 预设 id；留空用默认预设'),
    identifier: z.boolean().default(true).volatile().description('群消息交给模型时前面加 [昵称(QQ号)]'),
    imageToModel: z.boolean().default(true).volatile().description('图片（含商城表情、引用消息里的图片）作为附件交给模型；模型要支持看图（如 deepseek-flash）'),
    maxImages: z.natural().default(0).volatile().description('一条消息最多交给模型几张图片；0 = 不限'),
    // 访问控制（AstrBot platform_settings / admins_id）
    admins: z.array(z.string()).default([]).volatile().description('管理员 QQ 号'),
    whitelistEnabled: z.boolean().default(true).volatile().description('启用白名单（名单为空时不检查）'),
    whitelist: z.array(z.string()).default([]).volatile().description('白名单：群号、QQ 号（私聊）或完整会话标识'),
    whitelistIgnoreAdminOnGroup: z.boolean().default(true).volatile().description('群里管理员不受白名单限制'),
    whitelistIgnoreAdminOnFriend: z.boolean().default(true).volatile().description('私聊管理员不受白名单限制'),
    whitelistLog: z.boolean().default(true).volatile().description('不在白名单时记日志'),
    rateLimitCount: z.natural().default(30).volatile().description('频率限制：时间窗口内最多处理几条（0 = 不限）'),
    rateLimitSeconds: z.natural().min(1).default(60).volatile().description('频率限制：时间窗口（秒）'),
    rateLimitStrategy: z.union(['stall', 'discard']).default('stall').volatile().description('超出后：stall 排队等，discard 丢弃'),
    // 唤醒
    emptyMentionWaiting: z.boolean().default(true).volatile().description('只 @ 她不说话时，等这个人 60 秒内的下一条'),
    emptyMentionNeedReply: z.boolean().default(true).volatile().description('只 @ 她时先让她问一句'),
    uniqueSession: z.boolean().default(false).volatile().description('群里每人单独一个会话'),
    // 交给模型的内容
    datetimeReminder: z.boolean().default(true).volatile().description('告诉模型当前时间'),
    timezone: z.string().default('Asia/Shanghai').volatile().description('时区'),
    groupNameDisplay: z.boolean().default(true).volatile().description('告诉模型群名'),
    markAdmin: z.boolean().default(true).volatile().description('发送者是管理员时告诉模型'),
    // 指令
    commandsEnabled: z.boolean().default(true).volatile().description('启用 QQ 里的指令（/help /sid /new /reset /stop）'),
    noPermissionReply: z.boolean().default(true).volatile().description('没有权限用指令时回一句'),
    // 按聊天类型选预设和模型（只影响新建的会话）
    privateAgentPreset: z.string().default('').volatile().description('私聊用的预设'),
    groupAgentPreset: z.string().default('').volatile().description('群聊用的预设'),
    adminPrivateAgentPreset: z.string().default('').volatile().description('管理员私聊用的预设'),
    privateModel: z.string().default('').volatile().description('私聊用的模型（提供方/模型）'),
    groupModel: z.string().default('').volatile().description('群聊用的模型（提供方/模型）'),
    adminPrivateModel: z.string().default('').volatile().description('管理员私聊用的模型（提供方/模型）'),
    // 语音转文字
    sttMode: z.union(['off', 'command', 'openai']).default('off').volatile().description('语音转文字：off 关闭，command 本机命令，openai 兼容接口'),
    sttCommand: z.string().default('').volatile().description('本机命令，{file} 换成语音文件路径，输出就是文字'),
    sttApiUrl: z.string().default('').volatile().description('OpenAI 兼容接口地址（到 /v1 为止）'),
    sttApiKey: z.string().role('secret').volatile().description('接口 Key'),
    sttModel: z.string().default('').volatile().description('转写模型名'),
    logLevel: z.union(['debug', 'info', 'warn', 'error']).default('info').volatile().description('日志级别'),
});
export const name = 'dsh-napcat-bridge';
// agentDefaultModel / agentPresets / sessionPersistence 是可选的，用到时再 ctx.get
export const inject = ['agents'];
const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** 多久检查一次监听地址/端口有没有被设置页改过。 */
const ADDRESS_POLL_MS = 1000;
export function apply(ctx, live) {
    // 密钥字段不设默认值（设置页才能分清"没设置"和"设成空"），读不到时当空字符串
    const get = (key) => (live[key]?.get() ?? (key === 'ws_reverse_token' || key === 'sttApiKey' ? '' : undefined));
    const log = (level, message) => {
        if (RANK[level] < RANK[get('logLevel')])
            return;
        const line = '[napcat-bridge] ' + message;
        if (level === 'error')
            console.error(line);
        else if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
    };
    const bridge = new Bridge({
        agents: ctx.agents,
        defaultModel: () => ctx.get('agentDefaultModel'),
        presets: () => ctx.get('agentPresets'),
        persistence: () => ctx.get('sessionPersistence'),
        attachments: () => ctx.get('attachments'),
        callAction: (action, params) => adapter.bot.callAction(action, params),
        onSessionEvent: listener => ctx.on('session/event', ((session, event) => listener(session, event))),
        emit: (abm, event, isWake) => ctx.emit('napcat/message', abm, event, isWake),
        store: new SessionStore(join(defaultDataDir(), 'sessions.json')),
        settings: () => ({
            cwd: get('workspacePath') || process.cwd(),
            wake: {
                wakePrefix: [...get('wake_prefix')],
                ignoreBotSelfMessage: get('ignore_bot_self_message'),
                friendMessageNeedsWakePrefix: get('friend_message_needs_wake_prefix'),
            },
            identifier: get('identifier'),
            imageToModel: get('imageToModel'),
            maxImages: get('maxImages'),
            admins: get('admins').map(String),
            whitelist: {
                enabled: get('whitelistEnabled'),
                ids: get('whitelist').map(String),
                ignoreAdminOnGroup: get('whitelistIgnoreAdminOnGroup'),
                ignoreAdminOnFriend: get('whitelistIgnoreAdminOnFriend'),
                log: get('whitelistLog'),
            },
            rateLimit: { count: get('rateLimitCount'), seconds: get('rateLimitSeconds'), strategy: get('rateLimitStrategy') },
            emptyMention: { waiting: get('emptyMentionWaiting'), needReply: get('emptyMentionNeedReply') },
            uniqueSession: get('uniqueSession'),
            reminder: { datetime: get('datetimeReminder'), timezone: get('timezone'), groupName: get('groupNameDisplay'), markAdmin: get('markAdmin') },
            commands: { enabled: get('commandsEnabled'), noPermissionReply: get('noPermissionReply') },
            presets: { default: get('agentPreset'), private: get('privateAgentPreset'), group: get('groupAgentPreset'), adminPrivate: get('adminPrivateAgentPreset') },
            models: { private: get('privateModel'), group: get('groupModel'), adminPrivate: get('adminPrivateModel') },
            stt: { mode: get('sttMode'), command: get('sttCommand'), apiUrl: get('sttApiUrl'), apiKey: get('sttApiKey'), model: get('sttModel') },
        }),
        log,
    });
    const adapter = new AiocqhttpAdapter({
        id: () => get('id'),
        ws_reverse_host: get('ws_reverse_host'),
        ws_reverse_port: get('ws_reverse_port'),
        ws_reverse_token: () => get('ws_reverse_token'),
        log,
        onMessage: (abm, event) => bridge.handle(abm, event),
    });
    const service = {
        adapter,
        callAction: (action, params = {}) => adapter.bot.callAction(action, params),
        sendBySession: (session, chain) => adapter.sendBySession(session, chain),
        sessions: () => bridge.sessions(),
    };
    ctx.provide('napcat', service);
    // 设置页「测试连接」：GET <dsh>/api/napcat-bridge/status。
    // 挂在 dsh 的 /api 钩子上，请求先通过 dsh 网页的登录校验才会到这里；返回里不含 Token。
    const status = async () => {
        const bot = adapter.bot;
        const connections = bot.connections();
        let login;
        let loginError;
        if (connections.length > 0) {
            try {
                const info = await Promise.race([
                    bot.callAction('get_login_info', { self_id: connections[0].selfId }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('5 秒内没有回应')), 5000)),
                ]);
                login = { user_id: info?.user_id, nickname: info?.nickname };
            }
            catch (error) {
                loginError = error instanceof Error ? error.message : String(error);
            }
        }
        const rejected = bot.lastRejected !== undefined && Date.now() - bot.lastRejected.at < 10 * 60_000 ? bot.lastRejected : undefined;
        return {
            listening: bot.listening,
            address: get('ws_reverse_host') + ':' + get('ws_reverse_port'),
            tokenSet: get('ws_reverse_token') !== '',
            connections,
            login,
            loginError,
            lastRejected: rejected,
        };
    };
    ctx.on('connection/request', (async (req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!path.endsWith('/napcat-bridge/status'))
            return next();
        const body = JSON.stringify(await status());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
    }));
    // 本插件自带设置页（client.js），告诉 dsh 不用按 schema 自动生成表单
    ctx.inject(['settings'], child => {
        child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'napcat-bridge: settings policy');
    });
    const errText = (error) => (error instanceof Error ? error.message : String(error));
    ctx.effect(() => {
        let address = get('ws_reverse_host') + ':' + get('ws_reverse_port');
        let switching = adapter.run().then(() => log('info', '反向 WebSocket 已监听 ' + address), (error) => log('error', '启动反向 WebSocket 失败: ' + errText(error)));
        // 设置页改了监听地址或端口：关掉旧的服务，用新地址重新监听（NapCat 会自动重连）
        const timer = setInterval(() => {
            const host = get('ws_reverse_host');
            const port = get('ws_reverse_port');
            const next = host + ':' + port;
            if (next === address)
                return;
            address = next;
            switching = switching.then(() => adapter.restart(host, port)).then(() => log('info', '监听地址已改为 ' + next), (error) => log('error', '改用新监听地址失败: ' + errText(error)));
        }, ADDRESS_POLL_MS);
        return async () => {
            clearInterval(timer);
            await switching;
            await adapter.terminate();
            await bridge.dispose();
        };
    }, 'napcat-bridge');
}
export { MessageType };
