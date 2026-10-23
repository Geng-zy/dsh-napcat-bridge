// dsh 插件入口：照 AstrBot 的 aiocqhttp（OneBot v11）适配器，把 NapCat 接到 dsh。
import z from '@deepseek-ai/schemastery';
import { AiocqhttpAdapter, MessageType } from './adapter.js';
import { Bridge } from './bridge.js';
export * from './adapter.js';
export * from './components.js';
export { ActionFailed, ApiNotAvailable, NetworkError } from './onebot/errors.js';
export const Config = z.object({
    id: z.string().default('napcat').description('平台 ID，会话标识 unified_msg_origin 的第一段（AstrBot 的机器人 ID）'),
    ws_reverse_host: z.string().default('0.0.0.0').description('反向 WebSocket 监听地址（AstrBot 默认 0.0.0.0）'),
    ws_reverse_port: z.natural().default(6199).description('反向 WebSocket 端口（AstrBot 默认 6199）'),
    ws_reverse_token: z.string().role('secret').default('').description('反向 WebSocket Token，与 NapCat 里填的一致；留空则不校验'),
    wake_prefix: z.array(z.string()).default(['/']).description('唤醒前缀（AstrBot 默认 ["/"]）'),
    friend_message_needs_wake_prefix: z.boolean().default(false).description('私聊是否也需要唤醒前缀'),
    ignore_bot_self_message: z.boolean().default(false).description('是否忽略机器人自己发出的消息'),
    workspacePath: z.string().default('').description('QQ 会话的工作目录（绝对路径）；留空用 dsh 进程当前目录'),
    agentPreset: z.string().default('').description('QQ 会话使用的 agent 预设 id；留空用默认预设'),
    logLevel: z.union(['debug', 'info', 'warn', 'error']).default('info').description('日志级别'),
});
export const name = 'dsh-napcat-bridge';
// agentDefaultModel / agentPresets / sessionPersistence 是可选的，用到时再 ctx.get
export const inject = ['agents'];
const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
export function apply(ctx, config) {
    const log = (level, message) => {
        if (RANK[level] < RANK[config.logLevel])
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
        onSessionEvent: listener => ctx.on('session/event', ((session, event) => listener(session, event))),
        emit: (abm, event, isWake) => ctx.emit('napcat/message', abm, event, isWake),
        cwd: config.workspacePath || process.cwd(),
        agentPreset: config.agentPreset,
        wake: {
            wakePrefix: config.wake_prefix,
            ignoreBotSelfMessage: config.ignore_bot_self_message,
            friendMessageNeedsWakePrefix: config.friend_message_needs_wake_prefix,
        },
        log,
    });
    const adapter = new AiocqhttpAdapter({
        id: config.id,
        ws_reverse_host: config.ws_reverse_host,
        ws_reverse_port: config.ws_reverse_port,
        ws_reverse_token: config.ws_reverse_token,
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
    ctx.effect(() => {
        void adapter.run().then(() => log('info', '反向 WebSocket 已监听 ' + config.ws_reverse_host + ':' + config.ws_reverse_port), error => log('error', '启动反向 WebSocket 失败: ' + (error instanceof Error ? error.message : String(error))));
        return async () => {
            await adapter.terminate();
            await bridge.dispose();
        };
    }, 'napcat-bridge');
}
export { MessageType };
