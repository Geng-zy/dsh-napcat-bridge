// dsh 插件入口：照 AstrBot 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。
import z from '@deepseek-ai/schemastery';
import { AiocqhttpAdapter, MessageType, sessionToString } from './adapter.js';
import { Bridge } from './bridge.js';
import { findFfmpeg, installFfmpeg, platformTag } from './ffmpeg.js';
import { Media } from './media.js';
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
    // 视频（本插件新增）：用 ffmpeg 截几张画面当图片交给模型
    videoFrames: z.boolean().default(true).volatile().description('视频抽帧：截几张画面交给模型（找不到 ffmpeg 时自动当作关闭）'),
    videoMaxFrames: z.natural().min(1).default(4).volatile().description('每个视频最多截几张'),
    videoSecondsPerFrame: z.natural().min(1).default(5).volatile().description('短视频少截：每多少秒最多一张'),
    videoMaxEdge: z.natural().min(64).default(1024).volatile().description('截图最长边（像素）'),
    videoMaxMB: z.natural().min(1).default(100).volatile().description('超过这么大（MB）只截封面'),
    videoMaxMinutes: z.natural().min(1).default(10).volatile().description('超过这么长（分钟）只截封面'),
    videoTimeoutSeconds: z.natural().min(5).default(30).volatile().description('处理一个视频最多用几秒，超时只写 [视频]'),
    ffmpegPath: z.string().default('').volatile().description('ffmpeg 位置；留空先找插件自己装的，再找系统里的'),
    silenceToken: z.string().default('[不发]').volatile().description('她的回复以这个开头时不发出去（主动唤醒时她决定不说话用）'),
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
    const callAction = (action, params = {}) => adapter.bot.callAction(action, params);
    const videoSettings = () => ({
        enabled: get('videoFrames'),
        maxFrames: get('videoMaxFrames'),
        secondsPerFrame: get('videoSecondsPerFrame'),
        maxEdge: get('videoMaxEdge'),
        maxMB: get('videoMaxMB'),
        maxMinutes: get('videoMaxMinutes'),
        timeoutSeconds: get('videoTimeoutSeconds'),
        ffmpegPath: get('ffmpegPath'),
    });
    const sttSettings = () => ({ mode: get('sttMode'), command: get('sttCommand'), apiUrl: get('sttApiUrl'), apiKey: get('sttApiKey'), model: get('sttModel') });
    const media = new Media({
        callAction,
        attachments: () => ctx.get('attachments'),
        settings: () => ({ imageToModel: get('imageToModel'), maxImages: get('maxImages'), stt: sttSettings(), video: videoSettings() }),
        log,
    });
    const bridge = new Bridge({
        agents: ctx.agents,
        defaultModel: () => ctx.get('agentDefaultModel'),
        presets: () => ctx.get('agentPresets'),
        persistence: () => ctx.get('sessionPersistence'),
        media,
        callAction,
        onSessionEvent: listener => ctx.on('session/event', ((session, event) => listener(session, event))),
        emit: (abm, event, isWake) => ctx.emit('napcat/message', abm, event, isWake),
        prompt: payload => ctx.serial('napcat/prompt', payload),
        sent: payload => ctx.emit('napcat/sent', payload),
        sessionChanged: change => ctx.emit('napcat/session-changed', change),
        sendBySession: (session, chain) => adapter.sendBySession(session, chain),
        selfId: () => adapter.bot.connections()[0]?.selfId,
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
            stt: sttSettings(),
            video: videoSettings(),
            silenceToken: get('silenceToken') ?? '[不发]',
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
        callAction,
        sendBySession: async (session, chain) => {
            await adapter.sendBySession(session, chain);
            const text = chain.chain.filter(c => c.type === 'Plain').map(c => String(c.text ?? '')).join('');
            bridge.notifySent({ umo: sessionToString(session), session, text, chain, source: 'service', time: Date.now() });
        },
        sessions: () => bridge.sessions(),
        sessionInfo: sessionId => bridge.sessionInfo(sessionId),
        sessionInfoByUmo: umo => bridge.sessionInfoByUmo(umo),
        rotateSession: umo => bridge.rotateSession(umo),
        media,
        wake: (umo, content) => bridge.wake(umo, content),
    };
    ctx.provide('napcat', service);
    // 视频抽帧用的 ffmpeg：设置页查状态、一键安装
    let install = { state: 'idle' };
    const ffmpegStatus = async (fresh) => {
        const found = await findFfmpeg(get('ffmpegPath'), fresh);
        return {
            found: found ?? null,
            installSupported: platformTag() !== undefined,
            platform: process.platform + '-' + process.arch,
            install,
        };
    };
    const startInstall = () => {
        if (['downloading', 'verifying', 'extracting'].includes(install.state))
            return;
        install = { state: 'downloading' };
        log('info', '开始安装 ffmpeg');
        installFfmpeg({ onProgress: next => { install = next; } }).then(found => {
            install = { state: 'done', version: found.version, finishedAt: Date.now() };
            log('info', 'ffmpeg 已安装：' + found.version);
        }, (error) => {
            install = { state: 'failed', error: errText(error), finishedAt: Date.now() };
            log('error', '安装 ffmpeg 失败: ' + errText(error));
        });
    };
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
    // 视频：GET <dsh>/api/napcat-bridge/ffmpeg 查状态；POST <dsh>/api/napcat-bridge/ffmpeg/install 开始安装
    ctx.on('connection/request', (async (req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        const json = (code, value) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(value));
        };
        if (path.endsWith('/napcat-bridge/status'))
            return json(200, await status());
        if (path.endsWith('/napcat-bridge/ffmpeg') && req.method === 'GET')
            return json(200, await ffmpegStatus(true));
        if (path.endsWith('/napcat-bridge/ffmpeg/install')) {
            if (req.method !== 'POST')
                return json(405, { error: 'POST only' });
            startInstall();
            return json(200, await ffmpegStatus(false));
        }
        return next();
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
