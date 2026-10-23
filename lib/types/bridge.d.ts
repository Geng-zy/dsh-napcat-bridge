import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { AiocqhttpMessageEvent, MessageType, sessionToString, type AstrBotMessage } from './adapter.js';
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
    log: Logger;
}
export interface BridgeSettings {
    cwd: string;
    agentPreset: string;
    wake: WakeConfig;
    /** 群消息前面加 [昵称(QQ号)]，让模型知道是谁在说话 */
    identifier: boolean;
    /** 图片交给模型 */
    imageToModel: boolean;
    /** 一条消息最多交几张图片（含引用消息里的）；0 = 不限 */
    maxImages: number;
}
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
};
export declare class Bridge {
    private readonly deps;
    private readonly chats;
    private readonly bySession;
    private readonly creating;
    private readonly off;
    constructor(deps: BridgeDeps);
    /** 适配器 handle_msg 的去处。 */
    handle(abm: AstrBotMessage, event: AiocqhttpMessageEvent): Promise<void>;
    /** 交给模型的内容：（群里）[昵称(QQ号)] + 文字，后面跟图片。 */
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
