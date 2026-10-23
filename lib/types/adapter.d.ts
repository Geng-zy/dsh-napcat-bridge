import { CQHttp, type Logger } from './onebot/server.js';
import { type OneBotEvent } from './onebot/event.js';
import { ActionFailed } from './onebot/errors.js';
import { type Component, type MessageChain } from './components.js';
export declare enum MessageType {
    GROUP_MESSAGE = "GroupMessage",
    FRIEND_MESSAGE = "FriendMessage",
    OTHER_MESSAGE = "OtherMessage"
}
/** MessageMember */
export interface MessageMember {
    user_id: string;
    nickname: string | null;
}
/** Group */
export interface Group {
    group_id: string;
    group_name?: string | null;
    group_avatar?: string | null;
    group_owner?: string | null;
    group_admins?: string[] | null;
    members?: MessageMember[] | null;
    member_count?: number | null;
}
/** AstrBotMessage */
export interface AstrBotMessage {
    type: MessageType;
    self_id: string;
    session_id: string;
    message_id: string;
    group: Group | null;
    sender: MessageMember;
    message: Component[];
    message_str: string;
    raw_message: OneBotEvent;
    timestamp: number;
}
/** MessageSesion：platform_name:message_type:session_id */
export interface MessageSession {
    platform_name: string;
    message_type: MessageType;
    session_id: string;
}
export declare function sessionToString(s: MessageSession): string;
export declare function groupId(abm: AstrBotMessage): string;
export interface AdapterOptions {
    /** platform_config.id */
    id: string;
    ws_reverse_host: string;
    ws_reverse_port: number;
    ws_reverse_token?: string;
    log: Logger;
    /** handle_msg → commit_event 的替代：转换好的消息交给这里。 */
    onMessage: (abm: AstrBotMessage, event: AiocqhttpMessageEvent) => void | Promise<void>;
}
/** AiocqhttpAdapter */
export declare class AiocqhttpAdapter {
    readonly bot: CQHttp;
    readonly id: string;
    private host;
    private port;
    private readonly log;
    private readonly onMessage;
    constructor(options: AdapterOptions);
    /** send_by_session */
    sendBySession(session: MessageSession, messageChain: MessageChain): Promise<void>;
    /** convert_message */
    convertMessage(event: OneBotEvent): Promise<AstrBotMessage | null>;
    /** _convert_handle_request_event：OneBot V11 请求类事件 */
    convertHandleRequestEvent(event: OneBotEvent): Promise<AstrBotMessage>;
    /** _convert_handle_notice_event：OneBot V11 通知类事件 */
    convertHandleNoticeEvent(event: OneBotEvent): Promise<AstrBotMessage>;
    /**
     * _convert_handle_message_event：OneBot V11 消息类事件
     * @param getReply 是否获取回复消息。这个参数是为了防止多个回复嵌套。
     */
    convertHandleMessageEvent(event: OneBotEvent, getReply?: boolean): Promise<AstrBotMessage>;
    /** run */
    run(): Promise<void>;
    /** terminate */
    terminate(): Promise<void>;
    /** create_event */
    createEvent(message: AstrBotMessage): AiocqhttpMessageEvent;
    /** handle_msg：AstrBot 在这里 commit_event 进事件队列。 */
    handleMsg(message: AstrBotMessage): Promise<void>;
}
/** AiocqhttpMessageEvent */
export declare class AiocqhttpMessageEvent {
    readonly message_obj: AstrBotMessage;
    readonly message_str: string;
    readonly session: MessageSession;
    readonly bot: CQHttp;
    private readonly log;
    constructor(message: AstrBotMessage, platformId: string, bot: CQHttp, log: Logger);
    get unified_msg_origin(): string;
    getGroupId(): string;
    getSenderId(): string;
    getSelfId(): string;
    isPrivateChat(): boolean;
    /** _from_segment_to_dict：修复部分字段 */
    static fromSegmentToDict(segment: Component): Promise<Record<string, any>>;
    /** _parse_onebot_json：解析成 OneBot json 格式 */
    static parseOnebotJson(messageChain: MessageChain): Promise<Record<string, any>[]>;
    /** _dispatch_send */
    static dispatchSend(bot: CQHttp, event: OneBotEvent | null, isGroup: boolean, sessionId: string | null, messages: Record<string, any>[]): Promise<void>;
    /** send_message：发送消息至 QQ 协议端 */
    static sendMessage(bot: CQHttp, messageChain: MessageChain, event: OneBotEvent | null, isGroup: boolean, sessionId: string | null, _log?: Logger): Promise<void>;
    /** send */
    send(message: MessageChain): Promise<void>;
    /** send_streaming（use_fallback=False 时攒成一条发；True 时按句子分段发）。 */
    sendStreaming(generator: AsyncIterable<MessageChain>, useFallback?: boolean): Promise<void>;
    /** AstrMessageEvent.process_buffer：把完整的句子逐条发出，返回剩余部分。 */
    private processBuffer;
    /** get_group：取群信息，失败时保留已有数据。 */
    getGroup(groupIdArg?: string | number): Promise<Group | null>;
}
export { ActionFailed };
