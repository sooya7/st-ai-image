/** 把生成的音频/视频存进酒馆的 user/files，拿到能写进聊天记录的稳定地址。 */
import { fetchWithTimeout } from '../core/net.js';
import { summarizeApiError } from '../core/text.js';
import { mediaFileName, sanitizeMediaSrc } from '../media/tags.js';
import { getRequestHeadersWithCsrf, invalidateCsrfToken } from './context.js';

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
        reader.onerror = () => reject(reader.error || new Error('读取媒体文件失败'));
        reader.readAsDataURL(blob);
    });
}

export async function uploadMediaFile(blob, kind) {
    const body = JSON.stringify({ name: mediaFileName(kind, blob.type), data: await blobToBase64(blob) });
    const post = async () => fetchWithTimeout('/api/files/upload', {
        method: 'POST', headers: await getRequestHeadersWithCsrf(), body, timeout: 300_000,
    });
    let response = await post();
    if (response.status === 403) {
        invalidateCsrfToken(); // token 过期，取一次新的再试
        response = await post();
    }
    if (!response.ok) throw new Error(`保存到酒馆失败：${summarizeApiError(await response.text().catch(() => ''))}`);
    const src = sanitizeMediaSrc((await response.json())?.path);
    if (!src) throw new Error('酒馆返回的文件地址无法识别');
    return src;
}
