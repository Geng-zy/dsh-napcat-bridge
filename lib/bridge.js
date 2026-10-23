// dsh 一侧：替代 AstrBot 的事件队列和流水线里与"消息进出"有关的部分。
// 一条消息依次经过（顺序同 AstrBot STAGES_ORDER）：
//   唤醒（WakingCheckStage）→ 白名单（WhitelistCheckStage）→ 指令（builtin_commands）
//   → 只 @ 不说话时等下一条（handle_empty_mention）→ 频率限制（RateLimitStage）
//   → 语音转文字（PreProcessStage）→ 交给 unified_msg_origin 对应的 dsh 会话。
// 每条转换好的消息都通过 ctx 事件 'napcat/message' 广播（给记忆等其他插件用）。
// 会话一轮结束时，把模型最后一条回复的文字原样发回。
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MessageType, sessionToString, } from './adapter.js';
import { Plain } from './components.js';
import { loadImage } from './images.js';
import { extractForwards, extractQuoted } from './quoted.js';
import { transcribe } from './stt.js';
/** AstrBot handle_empty_mention 让模型主动问一句时用的提示词（原文）。 */
const EMPTY_MENTION_PROMPT = '注意，你正在社交媒体上中与用户进行聊天，用户只是通过@来唤醒你，但并未在这条消息中输入内容，他可能会在接下来一条发送他想发送的内容。'
    + '你友好地询问用户想要聊些什么或者需要什么帮助，回复要符合人设，不要太过机械化。'
    + '请注意，你仅需要输出要回复用户的内容，不要输出其他任何东西';
/** AstrBot @session_waiter(60) */
const EMPTY_MENTION_WAIT_MS = 60_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** 当前时间，格式同 AstrBot：2026-10-23 21:40 (GMT+8), Weekday: Friday */
export function formatNow(timezone, now = new Date()) {
    const make = (tz) => new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hour12: false, weekday: 'long', timeZoneName: 'short',
    });
    let fmt;
    try {
        fmt = make(timezone || undefined);
    }
    catch {
        fmt = make(undefined);
    }
    const p = {};
    for (const part of fmt.formatToParts(now))
        p[part.type] = part.value;
    const hour = p.hour === '24' ? '00' : p.hour;
    return p.year + '-' + p.month + '-' + p.day + ' ' + hour + ':' + p.minute + ' (' + p.timeZoneName + '), Weekday: ' + (p.weekday ?? WEEKDAYS[now.getDay()]);
}
/** "provider/model" → agentOptions；格式不对返回 undefined。 */
function parseModel(text) {
    const i = text.indexOf('/');
    if (i <= 0 || i === text.length - 1)
        return undefined;
    return { provider: text.slice(0, i).trim(), model: text.slice(i + 1).trim() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e));
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
        return { isWake: false, messageStr: event.message_str, stop: true, prefixUsed: false };
    }
    let messageStr = event.message_str.trim();
    const messages = event.message_obj.message;
    let isWake = false;
    let prefixUsed = false;
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
            prefixUsed = true;
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
    return { isWake, messageStr, stop: false, prefixUsed };
}
export class Bridge {
    deps;
    chats = new Map();
    bySession = new Map();
    creating = new Map();
    /** 只 @ 不说话的人：key = 会话|QQ 号，值 = 等到什么时候 */
    waiters = new Map();
    /** 频率限制：每个会话最近处理的时间 */
    timestamps = new Map();
    off;
    constructor(deps) {
        this.deps = deps;
        this.off = deps.onSessionEvent((session, event) => this.onSessionEvent(session, event));
    }
    /** unified_msg_origin；开了 unique_session 时群里按 QQ号_群号 分会话（同 AstrBot）。 */
    umoOf(event, s) {
        if (s.uniqueSession && event.message_obj.type === MessageType.GROUP_MESSAGE) {
            return sessionToString({ ...event.session, session_id: event.getSenderId() + '_' + event.getGroupId() });
        }
        return event.unified_msg_origin;
    }
    isAdmin(event, s) {
        return s.admins.includes(event.getSenderId());
    }
    /** WhitelistCheckStage；另外私聊时也认发送者的 QQ 号（AstrBot 只认完整会话标识）。 */
    allowed(event, admin, s) {
        const wl = s.whitelist;
        const ids = wl.ids.map(i => String(i).trim()).filter(i => i !== '');
        if (!wl.enabled || ids.length === 0)
            return true;
        const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE;
        if (admin && isGroup && wl.ignoreAdminOnGroup)
            return true;
        if (admin && !isGroup && wl.ignoreAdminOnFriend)
            return true;
        if (ids.includes(event.unified_msg_origin) || ids.includes(String(event.getGroupId()).trim()))
            return true;
        if (!isGroup && ids.includes(event.getSenderId()))
            return true;
        if (wl.log)
            this.deps.log('info', '会话 ' + event.unified_msg_origin + ' 不在白名单里，消息没有交给模型。需要的话在设置页「访问控制」里把群号或 QQ 号加进白名单。');
        return false;
    }
    /** RateLimitStage（固定窗口）。返回 false 表示这条被丢弃。 */
    async rateLimit(umo, s) {
        const { count, seconds, strategy } = s.rateLimit;
        if (count <= 0)
            return true;
        const windowMs = seconds * 1000;
        while (true) {
            const now = Date.now();
            const list = (this.timestamps.get(umo) ?? []).filter(t => t >= now - windowMs);
            this.timestamps.set(umo, list);
            if (list.length < count) {
                list.push(now);
                return true;
            }
            const wait = list[0] + windowMs - now + 300;
            if (strategy === 'discard') {
                this.deps.log('info', '会话 ' + umo + ' 触发频率限制，这条消息被丢弃，' + (wait / 1000).toFixed(1) + ' 秒后恢复。');
                return false;
            }
            this.deps.log('info', '会话 ' + umo + ' 触发频率限制，等 ' + (wait / 1000).toFixed(1) + ' 秒再处理。');
            await sleep(wait);
        }
    }
    /** 适配器 handle_msg 的去处。 */
    async handle(abm, event) {
        const s = this.deps.settings();
        const woke = wakingCheck(event, s.wake);
        let { isWake } = woke;
        const { stop, prefixUsed } = woke;
        let messageStr = woke.messageStr;
        const umo = this.umoOf(event, s);
        const isMessage = abm.raw_message.post_type === 'message';
        // 只 @ 过她的人，60 秒内的下一条有内容的消息算作唤醒（AstrBot 在下一条前插一个 @）
        const waiterKey = umo + '|' + event.getSenderId();
        const waitUntil = this.waiters.get(waiterKey);
        if (!stop && !isWake && isMessage && waitUntil !== undefined) {
            if (waitUntil < Date.now()) {
                this.waiters.delete(waiterKey);
            }
            else if (messageStr.trim() !== '') {
                this.waiters.delete(waiterKey);
                isWake = true;
            }
        }
        try {
            this.deps.emit(abm, event, isWake && !stop);
        }
        catch (e) {
            this.deps.log('warn', 'napcat/message 监听器出错: ' + errText(e));
        }
        if (stop || !isWake)
            return;
        // 只有消息事件交给模型；通知/请求只广播
        if (!isMessage)
            return;
        const admin = this.isAdmin(event, s);
        if (!this.allowed(event, admin, s))
            return;
        if (s.commands.enabled && prefixUsed && await this.command(messageStr, event, umo, admin, s))
            return;
        if (s.emptyMention.waiting && this.isEmptyMention(abm, event, s)) {
            this.waiters.set(waiterKey, Date.now() + EMPTY_MENTION_WAIT_MS);
            if (s.emptyMention.needReply)
                await this.dispatch(event, umo, [{ type: 'text', text: EMPTY_MENTION_PROMPT }]);
            return;
        }
        if (!await this.rateLimit(umo, s))
            return;
        // 语音转文字（PreProcessStage）
        const records = abm.message.filter(c => c.type === 'Record');
        for (const record of records) {
            let piece = '[语音]';
            if (s.stt.mode !== 'off') {
                try {
                    const text = await transcribe(record, s.stt, this.deps.callAction);
                    piece = text !== '' ? '[语音] ' + text : '[语音，没听清]';
                }
                catch (e) {
                    this.deps.log('warn', '语音转文字失败: ' + errText(e));
                    piece = '[语音，转文字失败]';
                }
            }
            messageStr = messageStr === '' ? piece : messageStr + ' ' + piece;
        }
        const own = abm.message.filter(c => c.type === 'Image');
        const hasForward = abm.message.some(c => c.type === 'Forward');
        if (messageStr === '' && own.length === 0 && !hasForward)
            return;
        const content = await this.buildContent(abm, messageStr, own, admin, s);
        await this.dispatch(event, umo, content);
    }
    isEmptyMention(abm, event, s) {
        const messages = abm.message;
        if (messages.length !== 1)
            return false;
        const m = messages[0];
        if (m.type === 'At' && String(m.qq) === String(event.getSelfId()))
            return true;
        return m.type === 'Plain' && s.wake.wakePrefix.includes(String(m.text).trim());
    }
    async dispatch(event, umo, content) {
        const chat = await this.ensureChat(event, umo);
        chat.replyTo = event;
        chat.handle.agent.followup(createUserMessage({
            content: content,
            source: { kind: 'plugin:napcat-bridge' },
        }));
    }
    /** QQ 里的指令。返回 true 表示已处理（不再交给模型）。 */
    async command(messageStr, event, umo, admin, s) {
        const name = messageStr.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!['help', 'sid', 'new', 'reset', 'stop'].includes(name))
            return false;
        const reply = (text) => event.send({ chain: [Plain(text)] }).catch(e => {
            this.deps.log('error', '发送指令回复失败: ' + errText(e));
        });
        const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE;
        // AstrBot SHARED_GROUP_ADMIN：私聊谁都能用；群里要管理员（本插件也认 QQ 群主和群管理）
        const groupRole = String(event.message_obj.raw_message.sender?.role ?? '');
        const sharedAdmin = !isGroup || admin || groupRole === 'owner' || groupRole === 'admin';
        if ((name === 'new' || name === 'reset') && !sharedAdmin) {
            if (s.commands.noPermissionReply)
                await reply('只有管理员能在群里用 /' + name + '。');
            return true;
        }
        const chat = this.chats.get(umo);
        if (name === 'help') {
            await reply(['可用指令：', '/new  开始新的对话（旧对话保留在 dsh 里）', '/reset  同 /new', '/stop  停止她正在进行的回复', '/sid  查看本会话的标识'].join('\n'));
        }
        else if (name === 'sid') {
            const sessionId = chat !== undefined ? String(chat.handle.agent.session.id) : (this.deps.store.get(umo) ?? dshSessionId(umo));
            await reply(['会话标识：' + umo, '你的 QQ：' + event.getSenderId(), 'dsh 会话：' + sessionId].join('\n'));
        }
        else if (name === 'stop') {
            if (chat === undefined) {
                await reply('现在没有在进行的回复。');
            }
            else {
                chat.handle.agent.cancel({ kind: 'user' });
                await reply('已停止。');
            }
        }
        else {
            await this.startNewSession(umo);
            await reply('已开始新的对话。');
        }
        return true;
    }
    /** /new、/reset：换一个新的 dsh 会话，旧的留在 dsh 里。 */
    async startNewSession(umo) {
        const next = dshSessionId(umo) + '-' + Date.now().toString(36);
        this.deps.store.set(umo, next);
        const chat = this.chats.get(umo);
        if (chat === undefined)
            return;
        this.chats.delete(umo);
        this.bySession.delete(String(chat.handle.agent.session.id));
        await chat.handle.dispose().catch(e => this.deps.log('warn', '关闭旧会话失败: ' + errText(e)));
        this.deps.log('info', umo + ' 换到新会话 ' + next);
    }
    /** AstrBot _append_system_reminders；markAdmin 为本插件新增。 */
    reminder(abm, admin, s) {
        const parts = [];
        if (s.reminder.markAdmin && admin)
            parts.push('Sender role: admin (QQ ' + abm.sender.user_id + ')');
        if (s.reminder.groupName && abm.group?.group_name)
            parts.push('Group name: ' + abm.group.group_name);
        if (s.reminder.datetime)
            parts.push('Current datetime: ' + formatNow(s.reminder.timezone));
        return parts.length > 0 ? '<system_reminder>' + parts.join('\n') + '</system_reminder>' : undefined;
    }
    /**
     * 交给模型的内容：（群里）[昵称(QQ号)] + 文字；有引用时接 <Quoted Message>（照 AstrBot），
     * 有聊天记录时接 <Forward Message>（本插件新增）；然后 <system_reminder>；最后是图片。
     */
    async buildContent(abm, messageStr, own, admin, s) {
        const settings = s;
        const callAction = this.deps.callAction;
        const safe = async (what, task) => {
            try {
                return await task();
            }
            catch (e) {
                this.deps.log('warn', what + '失败: ' + errText(e));
                return null;
            }
        };
        const quoted = await safe('整理引用内容', () => extractQuoted(abm.message, callAction));
        const forwarded = await safe('展开聊天记录', () => extractForwards(abm.message, callAction));
        let text = messageStr;
        if (text === '' && own.length > 0)
            text = '[图片]';
        if (text === '' && forwarded !== null)
            text = '[聊天记录]';
        if (settings.identifier && abm.type === MessageType.GROUP_MESSAGE) {
            text = '[' + (abm.sender.nickname || abm.sender.user_id) + '(' + abm.sender.user_id + ')] ' + text;
        }
        const texts = [{ type: 'text', text }];
        if (quoted !== null)
            texts.push({ type: 'text', text: quoted.text });
        if (forwarded !== null)
            texts.push({ type: 'text', text: forwarded.text });
        const reminder = this.reminder(abm, admin, s);
        if (reminder !== undefined)
            texts.push({ type: 'text', text: reminder });
        const asImage = (ref) => ({ type: 'Image', file: ref, url: ref.startsWith('http') ? ref : '', _type: '', path: '' });
        const quotedImages = (quoted?.imageRefs ?? []).map(asImage);
        const forwardImages = (forwarded?.imageRefs ?? []).map(asImage);
        const attachments = this.deps.attachments();
        if (!settings.imageToModel || attachments === undefined || own.length + quotedImages.length + forwardImages.length === 0) {
            return texts;
        }
        const parts = [...texts];
        let budget = settings.maxImages > 0 ? settings.maxImages : Infinity;
        let failed = 0;
        const add = async (images, label) => {
            const loaded = [];
            for (const img of images) {
                if (budget <= 0)
                    break;
                try {
                    loaded.push(await loadImage(img, callAction));
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
        await add(quotedImages, '（下面是被引用消息里的图片）');
        await add(forwardImages, '（下面是聊天记录里的图片）');
        if (failed > 0)
            parts.push({ type: 'text', text: '（有 ' + failed + ' 张图片没能读取）' });
        try {
            return await attachments.admitPromptContent(parts);
        }
        catch (e) {
            this.deps.log('warn', '图片交给 dsh 失败，只发文字: ' + (e instanceof Error ? e.message : String(e)));
            return texts;
        }
    }
    ensureChat(event, umo) {
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
        const settings = this.deps.settings();
        const sessionId = this.deps.store.get(umo) ?? dshSessionId(umo);
        const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE;
        const adminPrivate = !isGroup && settings.admins.includes(event.getSenderId());
        // 预设和模型：主人私聊 > 私聊/群聊 > 默认
        const presetId = (adminPrivate ? settings.presets.adminPrivate : '') || (isGroup ? settings.presets.group : settings.presets.private) || settings.presets.default || undefined;
        const modelText = (adminPrivate ? settings.models.adminPrivate : '') || (isGroup ? settings.models.group : settings.models.private);
        const chosen = modelText !== '' ? parseModel(modelText) : undefined;
        if (modelText !== '' && chosen === undefined)
            this.deps.log('warn', '模型「' + modelText + '」格式不对，应写成 提供方/模型；改用默认模型');
        const selection = chosen ?? this.deps.defaultModel()?.currentSelection();
        const agentOptions = selection ? { provider: selection.provider, model: selection.model, ...('reasoningEffort' in selection && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined;
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
                meta: { cwd: settings.cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
                agentOptions: agentOptions,
                setup,
            });
            this.deps.log('info', '新建会话 ' + sessionId + '（' + umo + (presetId ? '，预设 ' + presetId : '') + (chosen ? '，模型 ' + modelText : '') + '）');
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
