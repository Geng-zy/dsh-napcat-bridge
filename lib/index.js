// dsh 插件入口：照 AstrBot 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。
import z from '@deepseek-ai/schemastery';
import { AiocqhttpAdapter, MessageType } from './adapter.js';
import { Bridge } from './bridge.js';
export * from './adapter.js';
export * from './components.js';
export { ActionFailed, ApiNotAvailable, NetworkError } from './onebot/errors.js';
// 每项都标 .volatile()：dsh 的设置服务只对这种字段提供在线编辑，保存后插件不重启、直接读到新值。
export const Config = z.object({
    id: z.string().default('napcat').volatile().description('平台 ID，会话标识 unified_msg_origin 的第一段（AstrBot 的机器人 ID）'),
    ws_reverse_host: z.string().default('0.0.0.0').volatile().description('反向 WebSocket 监听地址（AstrBot 默认 0.0.0.0）'),
    ws_reverse_port: z.natural().max(65535).default(6199).volatile().description('反向 WebSocket 端口（AstrBot 默认 6199）'),
    ws_reverse_token: z.string().role('secret').default('').volatile().description('反向 WebSocket Token，与 NapCat 里填的一致；留空则不校验'),
    wake_prefix: z.array(z.string()).default(['/']).volatile().description('唤醒前缀（AstrBot 默认 ["/"]）'),
    friend_message_needs_wake_prefix: z.boolean().default(false).volatile().description('私聊是否也需要唤醒前缀'),
    ignore_bot_self_message: z.boolean().default(false).volatile().description('是否忽略机器人自己发出的消息'),
    workspacePath: z.string().default('').volatile().description('QQ 会话的工作目录（绝对路径）；留空用 dsh 进程当前目录'),
    agentPreset: z.string().default('').volatile().description('QQ 会话使用的 agent 预设 id；留空用默认预设'),
    identifier: z.boolean().default(true).volatile().description('群消息交给模型时前面加 [昵称(QQ号)]'),
    imageToModel: z.boolean().default(true).volatile().description('图片（含商城表情、引用消息里的图片）作为附件交给模型；模型要支持看图（如 deepseek-flash）'),
    maxImages: z.natural().default(0).volatile().description('一条消息最多交给模型几张图片；0 = 不限'),
    logLevel: z.union(['debug', 'info', 'warn', 'error']).default('info').volatile().description('日志级别'),
});
export const name = 'dsh-napcat-bridge';
// agentDefaultModel / agentPresets / sessionPersistence 是可选的，用到时再 ctx.get
export const inject = ['agents'];
const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** 多久检查一次监听地址/端口有没有被设置页改过。 */
const ADDRESS_POLL_MS = 1000;
export function apply(ctx, live) {
    const get = (key) => live[key].get();
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
        settings: () => ({
            cwd: get('workspacePath') || process.cwd(),
            agentPreset: get('agentPreset'),
            wake: {
                wakePrefix: [...get('wake_prefix')],
                ignoreBotSelfMessage: get('ignore_bot_self_message'),
                friendMessageNeedsWakePrefix: get('friend_message_needs_wake_prefix'),
            },
            identifier: get('identifier'),
            imageToModel: get('imageToModel'),
            maxImages: get('maxImages'),
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
