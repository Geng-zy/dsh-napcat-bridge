import z from '@deepseek-ai/schemastery';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AiocqhttpAdapter, AiocqhttpMessageEvent, MessageType, type AstrBotMessage, type MessageSession } from './adapter.js';
import type { MessageChain } from './components.js';
export * from './adapter.js';
export * from './components.js';
export { ActionFailed, ApiNotAvailable, NetworkError } from './onebot/errors.js';
export interface Config {
    id: string;
    ws_reverse_host: string;
    ws_reverse_port: number;
    ws_reverse_token: string;
    wake_prefix: string[];
    friend_message_needs_wake_prefix: boolean;
    ignore_bot_self_message: boolean;
    workspacePath: string;
    agentPreset: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
export declare const Config: z<Config>;
export declare const name = "dsh-napcat-bridge";
export declare const inject: string[];
/** 给其他插件（如记忆插件）用的服务：ctx.napcat */
export interface NapcatService {
    adapter: AiocqhttpAdapter;
    /** 调用任意 OneBot API */
    callAction(action: string, params?: Record<string, unknown>): Promise<any>;
    /** 按会话主动发送（AstrBot send_by_session） */
    sendBySession(session: MessageSession, chain: MessageChain): Promise<void>;
    /** 已建立的会话 */
    sessions(): Array<{
        umo: string;
        sessionId: string;
    }>;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        napcat: NapcatService;
    }
    interface Events {
        /** 每条转换好的 OneBot 消息/通知/请求；isWake 表示是否会交给模型 */
        'napcat/message'(abm: AstrBotMessage, event: AiocqhttpMessageEvent, isWake: boolean): void;
    }
}
type Context = CordisContext & {
    agents: AgentRegistry;
    agentDefaultModel?: {
        currentSelection(): {
            provider: string;
            model: string;
            reasoningEffort?: string;
        } | undefined;
    };
    agentPresets?: {
        mount(agentCtx: unknown, id?: string): Promise<{
            id: string;
        }>;
    };
    sessionPersistence?: {
        stat(id: string): Promise<object | undefined>;
    };
};
export declare function apply(ctx: Context, config: Config): void;
export { MessageType };
