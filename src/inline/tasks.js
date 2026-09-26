/**
 * 内联生图任务表。作用只有一个：同一个楼层 + 同一个标签，
 * 无论被多少次点击/重渲染命中，都只真正请求一次。
 *
 * 只记「正在进行」，不缓存结果：请求结束后条目立刻删掉。
 */
import { LIMITS } from '../core/constants.js';
import { log } from '../core/notify.js';

/** key -> { startedAt, prompt, messageId, originalTag } */
const pending = new Map();
let cleaner = null;

/** 楼层 id 可能为 null（找不到 mesid），用 '?' 占位，同一标签仍能去重。 */
export function getTaskKey(messageId, originalTag) {
    const id = Number.isInteger(messageId) ? messageId : '?';
    return `${id}::${String(originalTag ?? '').slice(0, 300)}`;
}

export const isPending = (key) => pending.has(key);

export const pendingCount = () => pending.size;

export function startTask(key, meta = {}) {
    pending.set(key, { ...meta, startedAt: Date.now() });
    return key;
}

export function endTask(key) {
    return pending.delete(key);
}

/** 清掉超时残留：请求自身有超时，但页面被切走/异常时 finally 可能没跑到。 */
export function sweepStaleTasks(now = Date.now()) {
    let removed = 0;
    for (const [key, task] of pending) {
        if (now - task.startedAt > LIMITS.taskMaxAgeMs) {
            pending.delete(key);
            removed++;
            log.warn('内联生图任务超时，已从任务表移除:', key);
        }
    }
    return removed;
}

/** 常驻清理器。重复调用不会叠加定时器。 */
export function startStaleCleaner() {
    if (cleaner) return cleaner;
    cleaner = setInterval(() => sweepStaleTasks(), LIMITS.taskMaxAgeMs);
    return cleaner;
}

export function stopStaleCleaner() {
    if (cleaner) clearInterval(cleaner);
    cleaner = null;
}
