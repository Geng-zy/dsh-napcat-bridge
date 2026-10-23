// dsh 一侧：替代 AstrBot 的事件队列和流水线里与连接有关的部分。
// - 每条转换好的消息都通过 ctx 事件 'napcat/message' 广播（给记忆等其他插件用）；
// - 按 AstrBot WakingCheckStage 的默认规则判断是否唤醒；唤醒后把 message_str 交给
//   unified_msg_origin 对应的 dsh 会话；
// - 会话一轮结束时，把模型最后一条回复的文字原样发回（AstrBot 平台不支持流式时也是整条发）。
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MessageType, sessionToString, } from './adapter.js';
import { Plain } from './components.js';
import { loadImage } from './images.js';
/** dsh 会话 id：napcat-<平台>-<类型>-<会话> 去掉不安全字符。 */
export function dshSessionId(umo) {
    return 'napcat-' + umo.replace(/[^A-Za-z0-9-]/g, '-');
}
/**
 * WakingCheckStage.process 中与唤醒有关的部分（AstrBot 默认配置）。
 * 返回 null 表示不唤醒；否则返回处理后的 message_str（去掉了唤醒前缀）。
 */
export function wakingCheck(event, wake) {
    if (wake.ignoreBotSelfMessage && event.getSelfId() === event.getSenderId()) {
        return { isWake: false, messageStr: event.message_str, stop: true };
    }
    let messageStr = event.message_str.trim();
    const messages = event.message_obj.message;
    let isWake = false;
    for (const prefix of wake.wakePrefix) {
        if (messageStr.startsWith(prefix)) {
            const first = messages[0];
            if (!event.isPrivateChat()
                && first !== undefined && first.type === 'At'
                && String(first.qq) !== String(event.getSelfId())
                && String(first.qq) !== 'all') {
                // 如果是群聊，且第一个消息段是 At 消息，但不是 At 机器人或 At 全体成员，则不唤醒
                break;
            }
            isWake = true;
            messageStr = messageStr.slice(prefix.length).trim();
            break;
        }
    }
    if (!isWake) {
        // 检查是否有at消息 / at全体成员消息 / 引用了bot的消息
        for (const m of messages) {
            // AstrBot 这里还判断 isinstance(m, AtAll)，但 aiocqhttp 适配器把 @全体 转成 At(qq="all")
            // 而不是 AtAll，所以 @全体 实际不会唤醒；这里保持同样的结果。
            if ((m.type === 'At' && String(m.qq) === String(event.getSelfId()))
                || (m.type === 'Reply' && String(m.sender_id) === String(event.getSelfId()))) {
                isWake = true;
                break;
            }
        }
        // 检查是否是私聊
        if (event.isPrivateChat() && !wake.friendMessageNeedsWakePrefix)
            isWake = true;
    }
    return { isWake, messageStr, stop: false };
}
export class Bridge {
    deps;
    chats = new Map();
    bySession = new Map();
    creating = new Map();
    off;
    constructor(deps) {
        this.deps = deps;
        this.off = deps.onSessionEvent((session, event) => this.onSessionEvent(session, event));
    }
    /** 适配器 handle_msg 的去处。 */
    async handle(abm, event) {
        const { isWake, messageStr, stop } = wakingCheck(event, this.deps.wake);
        try {
            this.deps.emit(abm, event, isWake && !stop);
        }
        catch (e) {
            this.deps.log('warn', 'napcat/message 监听器出错: ' + (e instanceof Error ? e.message : String(e)));
        }
        if (stop || !isWake)
            return;
        // 只有消息事件交给模型；通知/请求只广播
        if (abm.raw_message.post_type !== 'message')
            return;
        const own = abm.message.filter(c => c.type === 'Image');
        const quoted = abm.message.filter(c => c.type === 'Reply').flatMap(r => (r.chain ?? []).filter(c => c.type === 'Image'));
        if (messageStr === '' && own.length === 0)
            return;
        const content = await this.buildContent(abm, messageStr, own, quoted);
        const chat = await this.ensureChat(event);
        chat.replyTo = event;
        chat.handle.agent.followup(createUserMessage({
            content: content,
            source: { kind: 'plugin:napcat-bridge' },
        }));
    }
    /** 交给模型的内容：（群里）[昵称(QQ号)] + 文字，后面跟图片。 */
    async buildContent(abm, messageStr, own, quoted) {
        let text = messageStr;
        if (text === '' && own.length > 0)
            text = '[图片]';
        if (this.deps.identifier && abm.type === MessageType.GROUP_MESSAGE) {
            text = '[' + (abm.sender.nickname || abm.sender.user_id) + '(' + abm.sender.user_id + ')] ' + text;
        }
        const attachments = this.deps.attachments();
        if (!this.deps.imageToModel || attachments === undefined || own.length + quoted.length === 0) {
            return [{ type: 'text', text }];
        }
        const parts = [{ type: 'text', text }];
        let budget = this.deps.maxImages;
        let failed = 0;
        const add = async (images, label) => {
            const loaded = [];
            for (const img of images) {
                if (budget <= 0)
                    break;
                try {
                    loaded.push(await loadImage(img, this.deps.callAction));
                    budget -= 1;
                }
                catch (e) {
                    failed += 1;
                    this.deps.log('warn', '图片读取失败: ' + (e instanceof Error ? e.message : String(e)));
                }
            }
            if (loaded.length === 0)
                return;
            if (label !== undefined)
                parts.push({ type: 'text', text: label });
            for (const img of loaded)
                parts.push({ type: 'image', mediaType: img.mediaType, data: img.data, ...(img.name ? { name: img.name } : {}) });
        };
        await add(own);
        await add(quoted, '（下面是被引用消息里的图片）');
        if (failed > 0)
            parts.push({ type: 'text', text: '（有 ' + failed + ' 张图片没能读取）' });
        try {
            return await attachments.admitPromptContent(parts);
        }
        catch (e) {
            this.deps.log('warn', '图片交给 dsh 失败，只发文字: ' + (e instanceof Error ? e.message : String(e)));
            return [{ type: 'text', text: text + '（图片没能读取）' }];
        }
    }
    ensureChat(event) {
        const umo = event.unified_msg_origin;
        const existing = this.chats.get(umo);
        if (existing !== undefined)
            return Promise.resolve(existing);
        const pending = this.creating.get(umo);
        if (pending !== undefined)
            return pending;
        const task = this.createChat(umo, event).finally(() => this.creating.delete(umo));
        this.creating.set(umo, task);
        return task;
    }
    async createChat(umo, event) {
        const sessionId = dshSessionId(umo);
        const selection = this.deps.defaultModel()?.currentSelection();
        const agentOptions = selection ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined;
        const presetId = this.deps.agentPreset || undefined;
        const presets = this.deps.presets();
        const setup = presets !== undefined && presetId !== undefined
            ? (async (agentCtx) => { await presets.mount(agentCtx, presetId); })
            : undefined;
        const persistence = this.deps.persistence();
        const exists = persistence !== undefined && await persistence.stat(sessionId) !== undefined;
        let handle;
        if (exists) {
            handle = await this.deps.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: agentOptions, setup });
            this.deps.log('info', '恢复会话 ' + sessionId + '（' + umo + '）');
        }
        else {
            handle = await this.deps.agents.create({
                sessionId: SessionId(sessionId),
                meta: { cwd: this.deps.cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
                agentOptions: agentOptions,
                setup,
            });
            this.deps.log('info', '新建会话 ' + sessionId + '（' + umo + '）');
        }
        const chat = { umo, session: event.session, handle, lastText: '', replyTo: event };
        this.chats.set(umo, chat);
        this.bySession.set(String(handle.agent.session.id), umo);
        return chat;
    }
    onSessionEvent(session, event) {
        const umo = this.bySession.get(String(session.id));
        if (umo === undefined)
            return;
        const chat = this.chats.get(umo);
        if (chat === undefined)
            return;
        if (event.type === 'turn/start') {
            chat.lastText = '';
        }
        else if (event.type === 'assistant/message') {
            const text = event.data.message.content
                .filter(b => b.type === 'text')
                .map(b => b.text ?? '')
                .join('');
            if (text.trim() !== '')
                chat.lastText = text;
        }
        else if (event.type === 'turn/end') {
            const text = chat.lastText;
            chat.lastText = '';
            if (text.trim() === '')
                return;
            void chat.replyTo.send({ chain: [Plain(text)] }).catch(e => {
                this.deps.log('error', '发送回复失败（' + umo + '）: ' + (e instanceof Error ? e.message : String(e)));
            });
        }
    }
    /** 已建立的会话（unified_msg_origin → dsh 会话 id）。 */
    sessions() {
        return [...this.chats.values()].map(c => ({ umo: c.umo, sessionId: String(c.handle.agent.session.id) }));
    }
    async dispose() {
        this.off();
        const handles = [...this.chats.values()].map(c => c.handle);
        this.chats.clear();
        this.bySession.clear();
        await Promise.allSettled(handles.map(h => h.dispose()));
    }
}
export { MessageType, sessionToString };
