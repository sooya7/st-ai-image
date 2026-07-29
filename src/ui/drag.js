/**
 * 拖动面板标题栏。移动端（<=600px）面板是全屏的，直接不启用：
 * 一旦拖起来就要脱离 dialog 的原生居中，全屏下没有意义还会挡住内容。
 */
const MOBILE = '(max-width: 600px)';

const isMobile = () => Boolean(globalThis.matchMedia?.(MOBILE)?.matches);

/** 清掉拖拽残留，让 dialog 重新原生居中（每次打开面板时调用）。 */
export function resetDrag(panel) {
    if (!panel) return;
    for (const prop of ['position', 'left', 'top', 'margin']) panel.style.removeProperty(prop);
}

export function bindDrag(panel, handle) {
    if (!panel || !handle) return false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let panelX = 0;
    let panelY = 0;

    const start = (clientX, clientY) => {
        if (isMobile()) return false;
        const rect = panel.getBoundingClientRect();
        dragging = true;
        startX = clientX;
        startY = clientY;
        panelX = rect.left;
        panelY = rect.top;
        // 切成 fixed 才能脱离 dialog 的居中
        Object.assign(panel.style, { position: 'fixed', left: `${panelX}px`, top: `${panelY}px`, margin: '0' });
        return true;
    };

    const move = (clientX, clientY) => {
        if (!dragging) return;
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
        panel.style.left = `${Math.min(Math.max(0, panelX + clientX - startX), maxLeft)}px`;
        panel.style.top = `${Math.min(Math.max(0, panelY + clientY - startY), maxTop)}px`;
    };

    const end = () => { dragging = false; };
    const fromButton = (e) => Boolean(e.target?.closest?.('button'));

    handle.addEventListener('mousedown', (e) => {
        if (fromButton(e)) return;
        if (start(e.clientX, e.clientY)) e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    document.addEventListener('mouseup', end);

    handle.addEventListener('touchstart', (e) => {
        if (fromButton(e)) return;
        const touch = e.touches[0];
        if (touch) start(touch.clientX, touch.clientY);
    }, { passive: true });
    // passive: false 才能 preventDefault 阻止页面跟着滚
    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const touch = e.touches[0];
        if (!touch) return;
        e.preventDefault();
        move(touch.clientX, touch.clientY);
    }, { passive: false });
    document.addEventListener('touchend', end);

    handle.style.cursor = isMobile() ? '' : 'move';
    return true;
}
