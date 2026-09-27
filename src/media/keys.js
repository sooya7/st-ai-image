/** 页面加载时就会用到的小工具：判断要不要 API Key。协议适配本身（providers.js）按需加载。 */

/** 本机或局域网地址：自建服务通常不设鉴权，Key 可以留空。 */
export function isLocalBase(base) {
    let host;
    try { host = new URL(String(base)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1'
        || (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)));
}

/** 不填 Key 也能用的服务：自建服务、免费的 Pollinations / AI Horde、本地的 GPT-SoVITS。 */
export const KEY_OPTIONAL = ['comfyui', 'sdwebui', 'pollinations', 'horde', 'gptsovits'];

/** 这个服务要不要 API Key：上面这些和本机/局域网地址不强制。 */
export const needsKey = (provider, base) => !KEY_OPTIONAL.includes(provider) && !isLocalBase(base);
