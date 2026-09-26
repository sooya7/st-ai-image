/** 极简事件总线：让存储层能通知 UI 刷新，而不需要反向 import（避免循环依赖） */
const listeners = new Map();

export const EVENTS = {
    galleryChanged: 'gallery:changed',
    storageDegraded: 'storage:degraded',
};

export function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
        try { handler(payload); } catch (e) { console.error('[st-ai-image] bus handler error:', e); }
    }
}
