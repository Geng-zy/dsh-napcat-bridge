// dsh 一侧：替代 AstrBot 的事件队列和流水线里与"消息进出"有关的部分。
// 一条消息依次经过（顺序同 AstrBot STAGES_ORDER）：
//   唤醒（WakingCheckStage）→ 白名单（WhitelistCheckStage）→ 指令（builtin_commands）
//   → 只 @ 不说话时等下一条（handle_empty_mention）→ 频率限制（RateLimitStage）
//   → 语音转文字（PreProcessStage）→ 交给 unified_msg_origin 对应的 dsh 会话。
// 每条转换好的消息都通过 ctx 事件 'napcat/message' 广播（给记忆等其他插件用）。
// 交给模型前先发 'napcat/prompt'，其他插件可以往内容里加东西（本插件新增）。
// 会话一轮结束时，把模型最后一条回复的文字原样发回，并发 'napcat/sent'（本插件新增）。
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MessageType, sessionToString, } from './adapter.js';
import { Plain } from './components.js';
import { extractForwards, extractQuoted } from './quoted.js';
import { Pacer } from './pacer.js';
/** 'napcat/prompt' 监听者最多等多久，超时就按当时的内容发出去。 */
const PROMPT_HOOK_MS = 30_000;
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
    /** dsh 会话 id → QQ 会话信息（建会话之前就登记，预设里的插件启动时就能查到） */
    infos = new Map();
    /** 只 @ 不说话的人：key = 会话|QQ 号，值 = 等到什么时候 */
    waiters = new Map();
    /** 频率限制：每个会话最近处理的时间 */
    timestamps = new Map();
    off;
    pacer;
    constructor(deps) {
        this.deps = deps;
        this.pacer = new Pacer({ settings: () => deps.settings().pace, log: deps.log, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
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
                await this.dispatch(event, umo, abm, [{ type: 'text', text: EMPTY_MENTION_PROMPT }]);
            return;
        }
        if (!await this.rateLimit(umo, s))
            return;
        // 语音转文字（PreProcessStage）
        for (const record of abm.message.filter(c => c.type === 'Record')) {
            const piece = await this.deps.media.voiceText(record);
            messageStr = messageStr === '' ? piece : messageStr + ' ' + piece;
        }
        const own = abm.message.filter(c => c.type === 'Image');
        const videos = abm.message.filter(c => c.type === 'Video');
        const hasForward = abm.message.some(c => c.type === 'Forward');
        // 本插件新增：视频（AstrBot 不处理）在文字里写 [视频]，有 ffmpeg 时另外附几张截图
        for (let i = 0; i < videos.length; i++)
            messageStr = messageStr === '' ? '[视频]' : messageStr + ' [视频]';
        if (messageStr === '' && own.length === 0 && !hasForward)
            return;
        const content = await this.buildContent(abm, messageStr, own, videos, admin, s);
        await this.dispatch(event, umo, abm, content);
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
    targetOf(event, umo) {
        const isGroup = event.message_obj.type === MessageType.GROUP_MESSAGE;
        const isUnique = isGroup && umo !== event.unified_msg_origin;
        return {
            umo, session: event.session, isGroup, isUnique,
            ...(isGroup ? { groupId: String(event.getGroupId()) } : {}),
            ...(!isGroup ? { userId: String(event.message_obj.session_id) } : isUnique ? { userId: event.getSenderId() } : {}),
            senderId: event.getSenderId(),
            selfId: event.getSelfId(),
            send: chain => event.send(chain),
        };
    }
    async dispatch(event, umo, abm, content) {
        const target = this.targetOf(event, umo);
        const chat = await this.ensureChat(target);
        chat.send = target.send;
        // 本插件新增：交给模型前让其他插件（记忆等）往内容里加东西
        const payload = { info: chat.info, newSession: chat.fresh, message: abm, content: [...content] };
        chat.fresh = false;
        let timer;
        try {
            await Promise.race([
                this.deps.prompt(payload),
                new Promise(resolve => {
                    timer = setTimeout(() => {
                        this.deps.log('warn', 'napcat/prompt 监听器 ' + PROMPT_HOOK_MS / 1000 + ' 秒没有完成，先按现有内容发给模型');
                        resolve(undefined);
                    }, PROMPT_HOOK_MS);
                }),
            ]);
        }
        catch (e) {
            this.deps.log('warn', 'napcat/prompt 监听器出错: ' + errText(e));
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
        const parts = Array.isArray(payload.content) ? [...payload.content] : content;
        const admitted = await this.deps.media.admit(parts);
        chat.handle.agent.followup(createUserMessage({
            content: admitted,
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
            await this.startNewSession(umo, 'command');
            await reply('已开始新的对话。');
        }
        return true;
    }
    /** /new、/reset、rotateSession：换一个新的 dsh 会话，旧的留在 dsh 里。返回新旧会话 id。 */
    async startNewSession(umo, reason) {
        const pending = this.creating.get(umo);
        if (pending !== undefined)
            await pending.catch(() => undefined);
        const chat = this.chats.get(umo);
        const oldSessionId = chat !== undefined ? String(chat.handle.agent.session.id) : (this.deps.store.get(umo) ?? dshSessionId(umo));
        let next = dshSessionId(umo) + '-' + Date.now().toString(36);
        if (next === oldSessionId)
            next += '-1';
        this.deps.store.set(umo, next);
        if (chat !== undefined) {
            this.chats.delete(umo);
            this.bySession.delete(oldSessionId);
            await chat.handle.dispose().catch(e => this.deps.log('warn', '关闭旧会话失败: ' + errText(e)));
        }
        this.deps.log('info', umo + ' 换到新会话 ' + next);
        const change = { umo, oldSessionId, newSessionId: next, reason };
        try {
            this.deps.sessionChanged(change);
        }
        catch (e) {
            this.deps.log('warn', 'napcat/session-changed 监听器出错: ' + errText(e));
        }
        return { oldSessionId, newSessionId: next };
    }
    /** 给其他插件用：让某个 QQ 会话换一个新的 dsh 会话（下一条消息进新会话）。 */
    rotateSession(umo) {
        return this.startNewSession(umo, 'rotate');
    }
    /** dsh 会话 id → QQ 会话信息。 */
    sessionInfo(sessionId) {
        return this.infos.get(sessionId);
    }
    /** QQ 会话（unified_msg_origin）→ 当前的会话信息。 */
    sessionInfoByUmo(umo) {
        const chat = this.chats.get(umo);
        if (chat !== undefined)
            return chat.info;
        const id = this.deps.store.get(umo) ?? dshSessionId(umo);
        return this.infos.get(id);
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
     * 有聊天记录时接 <Forward Message>（本插件新增）；然后 <system_reminder>；最后是图片和视频截图。
     * 返回的内容还没交给 dsh 附件服务（dispatch 里统一交）。
     */
    async buildContent(abm, messageStr, own, videos, admin, s) {
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
        const media = this.deps.media;
        if (!settings.imageToModel || !media.canAttach() || own.length + quotedImages.length + forwardImages.length + videos.length === 0) {
            return texts;
        }
        const parts = [...texts];
        let budget = settings.maxImages > 0 ? settings.maxImages : Infinity;
        let failed = 0;
        const add = async (images, label) => {
            const got = await media.convert(images, budget);
            budget -= got.used;
            failed += got.failed;
            if (got.parts.length === 0)
                return;
            if (label !== undefined)
                parts.push({ type: 'text', text: label });
            parts.push(...got.parts);
        };
        await add(own);
        await add(quotedImages, '（下面是被引用消息里的图片）');
        await add(forwardImages, '（下面是聊天记录里的图片）');
        // 本插件新增：视频截图（每个视频前面有一句说明）
        for (const video of videos) {
            if (budget <= 0)
                break;
            const v = await media.video(video, budget);
            budget -= v.parts.filter(p => p.type === 'image').length;
            parts.push(...v.parts);
        }
        if (failed > 0)
            parts.push({ type: 'text', text: '（有 ' + failed + ' 张图片没能读取）' });
        return parts;
    }
    ensureChat(target) {
        const umo = target.umo;
        const existing = this.chats.get(umo);
        if (existing !== undefined)
            return Promise.resolve(existing);
        const pending = this.creating.get(umo);
        if (pending !== undefined)
            return pending;
        const task = this.createChat(target).finally(() => this.creating.delete(umo));
        this.creating.set(umo, task);
        return task;
    }
    /**
     * 本插件新增：其他插件主动唤醒她（比如定时主动聊天）。给这个 QQ 会话的 dsh 会话发一条内容（来源 plugin:napcat-bridge-wake），
     * 她一轮说完的回复照常发到 QQ；回复以「不发」暗号开头时不发。会话还没建过时先建。群里每人单独一个会话的 umo 不支持。
     */
    async wake(umo, content) {
        const parts = umo.split(':');
        if (parts.length !== 3)
            throw new Error('会话标识不对：' + umo);
        const [platform, type, id] = parts;
        if (type !== MessageType.GROUP_MESSAGE && type !== MessageType.FRIEND_MESSAGE)
            throw new Error('只能唤醒私聊或群聊：' + umo);
        if (id.includes('_'))
            throw new Error('不支持群里每人单独会话的唤醒：' + umo);
        const selfId = this.deps.selfId();
        if (selfId === undefined)
            throw new Error('NapCat 还没连上');
        const isGroup = type === MessageType.GROUP_MESSAGE;
        const session = { platform_name: platform, message_type: type, session_id: id };
        const send = (chain) => this.deps.sendBySession(session, chain);
        const chat = await this.ensureChat({ umo, session, isGroup, isUnique: false, ...(isGroup ? { groupId: id } : { userId: id }), senderId: isGroup ? '' : id, selfId, send });
        const admitted = await this.deps.media.admit(typeof content === 'string' ? [{ type: 'text', text: content }] : content);
        chat.handle.agent.followup(createUserMessage({ content: admitted, source: { kind: 'plugin:napcat-bridge-wake' } }));
        return { sessionId: String(chat.handle.agent.session.id) };
    }
    async createChat(target) {
        const umo = target.umo;
        const settings = this.deps.settings();
        const sessionId = this.deps.store.get(umo) ?? dshSessionId(umo);
        const isGroup = target.isGroup;
        const adminPrivate = !isGroup && settings.admins.includes(target.senderId);
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
        // 本插件新增：建会话之前先登记它对应哪个 QQ 会话（预设里的插件在 setup 时就能查到）
        const info = {
            umo,
            sessionId,
            platformId: target.session.platform_name,
            selfId: target.selfId,
            type: isGroup ? 'group' : 'private',
            ...(target.groupId !== undefined ? { groupId: target.groupId } : {}),
            ...(target.userId !== undefined ? { userId: target.userId } : {}),
            adminPrivate,
        };
        this.infos.set(sessionId, info);
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
        const chat = { umo, session: target.session, handle, lastText: '', send: target.send, info, fresh: !exists };
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
            // 本插件新增：她决定这次不说话（主动唤醒时）
            const token = this.deps.settings().silenceToken.trim();
            if (token !== '' && text.trim().startsWith(token)) {
                this.deps.log('info', umo + '：她决定不发');
                return;
            }
            const reply = { chain: [Plain(text)] };
            // 本插件新增：像真人一样按打字速度等一会儿，群里守发言频率
            void this.pacer.run(umo, chat.info.type === 'group', text, () => chat.send(reply)).then(result => {
                if (result === 'dropped')
                    return;
                this.notifySent({ umo, session: chat.session, text, chain: reply, source: 'reply', time: Date.now() });
            }, e => {
                this.deps.log('error', '发送回复失败（' + umo + '）: ' + (e instanceof Error ? e.message : String(e)));
            });
        }
    }
    /** 发 'napcat/sent'；监听器出错不影响发送。 */
    notifySent(payload) {
        try {
            this.deps.sent(payload);
        }
        catch (e) {
            this.deps.log('warn', 'napcat/sent 监听器出错: ' + errText(e));
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
