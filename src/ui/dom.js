/** DOM 小工具。全部走 createElement/textContent，不拼 HTML 字符串，天然免疫注入。 */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * el('button', { class: 'x', dataset: { id: 1 }, onclick: fn }, ['文字', childNode])
 * props 里 on* 当事件处理，dataset/style 当对象，其余当属性。
 */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key === 'text') node.textContent = String(value);
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) {
        if (child === undefined || child === null || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export const icon = (name) => el('i', { class: `fa-solid ${name}` });

export function iconButton({ iconName, title, className = 'st_gpt_image_btn', dataset = {}, disabled = false }) {
    return el('button', {
        type: 'button',
        class: className,
        title,
        'aria-label': title,
        dataset,
        disabled: disabled || undefined,
    }, [icon(iconName)]);
}

/** 事件委托：绑一次，处理动态插入的元素。 */
export function delegate(event, selector, handler, root = document) {
    root.addEventListener(event, (e) => {
        const target = e.target?.closest?.(selector);
        if (target && root.contains(target)) handler(e, target);
    });
}

/** 按钮进入/退出加载态，恢复时用回原图标。 */
export const setBusy = (button, busy, busyIcon = 'fa-spinner fa-spin') => {
    if (!button) return;
    const iconEl = button.querySelector('i');
    if (busy) {
        button.disabled = true;
        if (iconEl) {
            if (!button.dataset.restoreIcon) button.dataset.restoreIcon = iconEl.className;
            iconEl.className = `fa-solid ${busyIcon}`;
        }
        return;
    }
    button.disabled = false;
    if (iconEl && button.dataset.restoreIcon) {
        iconEl.className = button.dataset.restoreIcon;
        delete button.dataset.restoreIcon;
    }
};

export const clear = (node) => { if (node) node.textContent = ''; };

export const spinner = (text) => el('div', { class: 'st_ai_loading' }, [el('div', { class: 'st_ai_spinner' }), ` ${text}`]);

export const replaceContent = (node, ...children) => {
    if (!node) return node;
    node.textContent = '';
    node.append(...children.filter(Boolean));
    return node;
};

export const debounce = (fn, wait) => {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn(...args); }, wait);
    };
};
