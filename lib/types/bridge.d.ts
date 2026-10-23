import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { AiocqhttpMessageEvent, MessageType, sessionToString, type AstrBotMessage } from './adapter.js';
import { type SttSettings } from './stt.js';
import type { SessionStore } from './store.js';
import type { Logger } from './onebot/server.js';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /** 从 QQ（NapCat）来的用户消息 */
        'plugin:napcat-bridge': {
            kind: 'plugin:napcat-bridge';
        };
    }
}
export interface WakeConfig {
    /** AstrBot wake_prefix，默认 ["/"] */
    wakePrefix: string[];
    /** AstrBot platform_settings.ignore_bot_self_message，默认 false */
    ignoreBotSelfMessage: boolean;
    /** AstrBot platform_settings.friend_message_needs_wake_prefix，默认 false */
    friendMessageNeedsWakePrefix: boolean;
}
export interface BridgeDeps {
    agents: AgentRegistry;
    /** 新会话用的默认模型（dsh-agent-default-model） */
    defaultModel(): {
        currentSelection(): {
            provider: string;
            model: string;
            reasoningEffort?: string;
        } | undefined;
    } | undefined;
    /** 预设挂载（可选） */
    presets(): {
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    } | undefined;
    /** 判断会话日志是否已存在（可选；存在时 resume 而不是 create） */
    persistence(): {
        stat(id: string): Promise<object | undefined>;
    } | undefined;
    /** 会话事件来源（ctx.on('session/event')） */
    onSessionEvent(listener: (session: Session, event: SessionEvent) => void): () => void;
    /** dsh 附件服务（可选；没有时图片不交给模型） */
    attachments(): {
        admitPromptContent(content: readonly unknown[]): Promise<unknown[]>;
    } | undefined;
    /** 调 OneBot API（读图片时 get_image 兜底） */
    callAction(action: string, params: Record<string, unknown>): Promise<any>;
    /** 广播给其他插件 */
    emit(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void;
    /** 当前设置（每次用到时读取，设置页改了立即生效） */
    settings(): BridgeSettings;
    /** 记住每个 QQ 会话当前的 dsh 会话 id */
    store: SessionStore;
    log: Logger;
}
export interface BridgeSettings {
    cwd: string;
    wake: WakeConfig;
    /** 群消息前面加 [昵称(QQ号)]，让模型知道是谁在说话 */
    identifier: boolean;
    /** 图片交给模型 */
    imageToModel: boolean;
    /** 一条消息最多交几张图片（含引用消息里的）；0 = 不限 */
    maxImages: number;
    /** AstrBot admins_id：管理员 QQ 号 */
    admins: string[];
    /** AstrBot enable_id_white_list / id_whitelist / wl_ignore_admin_* / id_whitelist_log */
    whitelist: {
        enabled: boolean;
        ids: string[];
        ignoreAdminOnGroup: boolean;
        ignoreAdminOnFriend: boolean;
        log: boolean;
    };
    /** AstrBot rate_limit：time 秒内最多 count 条；strategy stall=排队 discard=丢弃；count 0 = 不限 */
    rateLimit: {
        count: number;
        seconds: number;
        strategy: 'stall' | 'discard';
    };
    /** AstrBot empty_mention_waiting / empty_mention_waiting_need_reply */
    emptyMention: {
        waiting: boolean;
        needReply: boolean;
    };
    /** AstrBot unique_session：群里每人单独一个会话 */
    uniqueSession: boolean;
    /** AstrBot datetime_system_prompt / group_name_display / timezone；markAdmin 为本插件新增 */
    reminder: {
        datetime: boolean;
        timezone: string;
        groupName: boolean;
        markAdmin: boolean;
    };
    /** QQ 里的指令（/help /sid /new /reset /stop）；noPermissionReply 同 AstrBot */
    commands: {
        enabled: boolean;
        noPermissionReply: boolean;
    };
    /** 新会话用的预设：主人私聊 > 私聊/群聊 > 默认（空 = 往下找） */
    presets: {
        default: string;
        private: string;
        group: string;
        adminPrivate: string;
    };
    /** 新会话用的模型，写成 提供方/模型（空 = 用 dsh 默认模型） */
    models: {
        private: string;
        group: string;
        adminPrivate: string;
    };
    stt: SttSettings;
}
/** 当前时间，格式同 AstrBot：2026-10-23 21:40 (GMT+8), Weekday: Friday */
export declare function formatNow(timezone: string, now?: Date): string;
/** dsh 会话 id：napcat-<平台>-<类型>-<会话> 去掉不安全字符。 */
export declare function dshSessionId(umo: string): string;
/**
 * WakingCheckStage.process 中与唤醒有关的部分（AstrBot 默认配置）。
 * 返回 null 表示不唤醒；否则返回处理后的 message_str（去掉了唤醒前缀）。
 */
export declare function wakingCheck(event: AiocqhttpMessageEvent, wake: WakeConfig): {
    isWake: boolean;
    messageStr: string;
    stop: boolean;
    prefixUsed: boolean;
};
export declare class Bridge {
    private readonly deps;
    private readonly chats;
    private readonly bySession;
    private readonly creating;
    /** 只 @ 不说话的人：key = 会话|QQ 号，值 = 等到什么时候 */
    private readonly waiters;
    /** 频率限制：每个会话最近处理的时间 */
    private readonly timestamps;
    private readonly off;
    constructor(deps: BridgeDeps);
    /** unified_msg_origin；开了 unique_session 时群里按 QQ号_群号 分会话（同 AstrBot）。 */
    private umoOf;
    private isAdmin;
    /** WhitelistCheckStage；另外私聊时也认发送者的 QQ 号（AstrBot 只认完整会话标识）。 */
    private allowed;
    /** RateLimitStage（固定窗口）。返回 false 表示这条被丢弃。 */
    private rateLimit;
    /** 适配器 handle_msg 的去处。 */
    handle(abm: AstrBotMessage, event: AiocqhttpMessageEvent): Promise<void>;
    private isEmptyMention;
    private dispatch;
    /** QQ 里的指令。返回 true 表示已处理（不再交给模型）。 */
    private command;
    /** /new、/reset：换一个新的 dsh 会话，旧的留在 dsh 里。 */
    private startNewSession;
    /** AstrBot _append_system_reminders；markAdmin 为本插件新增。 */
    private reminder;
    /**
     * 交给模型的内容：（群里）[昵称(QQ号)] + 文字；有引用时接 <Quoted Message>（照 AstrBot），
     * 有聊天记录时接 <Forward Message>（本插件新增）；然后 <system_reminder>；最后是图片。
     */
    private buildContent;
    private ensureChat;
    private createChat;
    private onSessionEvent;
    /** 已建立的会话（unified_msg_origin → dsh 会话 id）。 */
    sessions(): Array<{
        umo: string;
        sessionId: string;
    }>;
    dispose(): Promise<void>;
}
export { MessageType, sessionToString };
