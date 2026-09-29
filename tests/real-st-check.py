"""Drive a REAL SillyTavern (isolated data root) with the extension installed.

Media vendors are replaced by a local mock (no paid APIs). Everything on the ST side is real:
markdown rendering, slash commands, /api/files/upload + CSRF, saveChat to disk, settings.json,
the /proxy/ CORS proxy, and page reload.

Start an ISOLATED SillyTavern with the extension installed and the CORS proxy on, e.g.
  node server.js --configPath <tmp>/config.yaml --dataRoot <tmp>/data --port 8123 --listen false --corsProxy true --browserLaunchEnabled false
(copy the extension into <tmp>/data/default-user/extensions/st-ai-image first). Never point it at your real data root.

Usage: python tests/real-st-check.py --st http://127.0.0.1:8123 --data <tmp>/data --output <dir>
"""
import argparse
import io
import json
import math
from pathlib import Path
import re
import struct
import subprocess
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

LOG = []
STATE = {'polls': {}}


def make_wav():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(b''.join(struct.pack('<h', int(2000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(8000)))
    return buffer.getvalue()


AUDIO = make_wav()
VIDEO = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libvpx',
                        '-b:v', '100k', '-f', 'webm', 'pipe:1'], capture_output=True, check=True).stdout
import zlib
_chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
PNG = b'\x89PNG\r\n\x1a\n' + _chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + _chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + _chunk(b'IEND', b'')


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'authorization, content-type, x-runway-version')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def reply(self, status, payload, content_type='application/json'):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status); self.cors()
        self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def record(self, body=''):
        LOG.append({'method': self.command, 'path': self.path, 'origin': self.headers.get('Origin'), 'ua': self.headers.get('User-Agent', ''),
                    'auth': self.headers.get('Authorization'), 'runway': self.headers.get('X-Runway-Version'), 'body': body})

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        self.record(body)
        if self.path == '/v1/audio/speech':
            return self.reply(200, AUDIO, 'audio/wav')
        if self.path == '/v1/text_to_video':
            return self.reply(200, {'id': 'job-real-1'})
        if self.path == '/v1/images/generations':
            import base64
            return self.reply(200, {'data': [{'b64_json': base64.b64encode(PNG).decode()}]})
        self.reply(404, {'error': 'unknown'})

    def do_GET(self):
        self.record()
        if self.path.startswith('/v1/tasks/'):
            job = self.path.rsplit('/', 1)[1]
            n = STATE['polls'][job] = STATE['polls'].get(job, 0) + 1
            host = self.headers['Host']
            return self.reply(200, {'id': job, 'status': 'RUNNING', 'progress': 0.5} if n == 1 else {'id': job, 'status': 'SUCCEEDED', 'output': [f'http://{host}/files/clip.webm']})
        if self.path == '/files/clip.webm':
            return self.reply(200, VIDEO, 'video/webm')
        self.reply(404, {'error': 'unknown'})


INSTRUMENT = """(() => {
    const NativeAudio = window.Audio; window.__audios = [];
    window.Audio = function (src) { const a = new NativeAudio(src); window.__audios.push(a); return a; };
    window.confirm = () => true;
})();"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--st', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    user = Path(args.data) / 'default-user'
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    mock_base = f'http://127.0.0.1:{mock.server_port}/v1'
    checks, console_errors = [], []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        context.add_init_script(INSTRUMENT)
        page = context.new_page()
        page.on('pageerror', lambda e: console_errors.append(str(e)))
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' and 'st-ai-image' in m.text else None)
        ctx = lambda js: page.evaluate(f'(async () => {{ const c = SillyTavern.getContext(); {js} }})()')

        def dismiss_popups():
            # 首次运行的 onboarding 必须真正完成：它是 doOnboarding 的 await 点，不点确定
            # settingsReady 永远是 false，之后所有设置都不会落盘。填个名字再敲确定。
            for _ in range(5):
                if not page.locator('dialog[open]').count():
                    break
                page.evaluate("""document.querySelectorAll('dialog[open] .onboarding input').forEach((i) => {
                    if (!i.value) { i.value = 'tester'; i.dispatchEvent(new Event('input', { bubbles: true })); }
                });""")
                page.wait_for_timeout(300)
                page.evaluate("document.querySelectorAll('dialog[open] .popup-button-ok').forEach((b) => b.click())")
                page.wait_for_timeout(700)

        def boot():
            page.goto(args.st)
            page.wait_for_function('window.SillyTavern?.getContext && document.querySelector("#st_ai_image_wand_button")', timeout=120000)
            page.wait_for_timeout(1500)
            dismiss_popups()

        def open_tab(tab):
            if not page.locator('#st_ai_dialog').evaluate('(d) => d.open'):
                # ST 的扩展菜单有展开动画、再点会收起；菜单机制不是被测对象，直接触发菜单项
                page.evaluate("document.querySelector('#extensionsMenu #st_ai_image_wand_button').click()")
                page.locator('#st_ai_float_panel').wait_for()
            page.locator(f'.st_ai_tab[data-tab="{tab}"]').click()

        def last_mes():
            return page.locator('#chat .mes.last_mes .mes_text')

        def chat_file_text():
            return '\n'.join(f.read_text(encoding='utf-8') for f in (user / 'chats').rglob('*.jsonl'))

        boot()
        checks.append(f"Real SillyTavern {ctx('return c.SillyTavern?.version ?? document.title')} loaded the extension (menu entry present)")

        # A real character chat; messages go through ST's own /sendas + markdown renderer.
        # 角色列表异步加载：先等，确实没有角色才通过 ST 自己的接口建一个。
        try:
            page.wait_for_function('SillyTavern.getContext().characters.length > 0', timeout=15000)
        except Exception:
            pass
        ctx("""
            if (!c.characters.length) {
                const form = new FormData();
                form.append('ch_name', '测试角色'); form.append('first_mes', '你好，我是测试角色。');
                for (const k of ['description', 'personality', 'scenario', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'creator', 'character_version']) form.append(k, '');
                form.append('talkativeness', '0.5'); form.append('fav', 'false');
                const headers = c.getRequestHeaders(); delete headers['Content-Type'];
                const r = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
                if (!r.ok) throw new Error('create character ' + r.status);
                await c.getCharacters();
            }
            return c.characters.length;""")
        ctx('await c.selectCharacterById(0); return true;')
        page.wait_for_function('SillyTavern.getContext().characterId !== undefined && SillyTavern.getContext().chat.length > 0', timeout=30000)
        char_name = ctx('return c.characters[c.characterId].name')
        ctx("await c.executeSlashCommandsWithOptions('/sendas name=\"' + c.characters[c.characterId].name + '\" 她轻声说：[voice]\"*轻声*晚上好\"[/voice] 然后看向窗外。[video]雨夜的城市，镜头缓慢推进[/video]'); return true;")
        expect(last_mes().locator('.st_ai_media_audio .st_ai_media_gen')).to_be_visible(timeout=15000)
        html = last_mes().inner_html()
        assert '<q>' in html or '<em>' in html, html[:400]
        checks.append(f'ST markdown split the tag across <q>/<em> nodes; scanner still turned [voice]/[video] into inline buttons ({char_name})')

        # Settings through the real panel.
        open_tab('speech')
        page.locator('#st_ai_speech_provider').select_option('openai')
        page.locator('#st_ai_speech_base').fill(mock_base)
        page.locator('#st_ai_speech_key').fill('real-st-voice-key')
        open_tab('video')
        page.locator('#st_ai_video_provider').select_option('runway')
        page.locator('#st_ai_video_base').fill(mock_base)
        page.locator('#st_ai_video_key').fill('real-st-video-key')
        page.locator('#st_ai_video_proxy').check()
        page.wait_for_timeout(2500)  # ST saveSettingsDebounced
        page.locator('#st_ai_float_close').click()
        settings = json.loads((user / 'settings.json').read_text(encoding='utf-8'))
        ext = settings['extension_settings']['st-ai-image']
        assert ext['speech']['profiles']['openai']['key'] == 'real-st-voice-key' and ext['video']['proxy'] is True
        checks.append('Settings written to settings.json on disk via saveSettingsDebounced (speech key, video proxy)')

        # Voice: direct browser request (mock allows CORS), upload to ST, write back.
        last_mes().locator('.st_ai_media_audio .st_ai_media_gen').click()
        expect(last_mes().locator('.st_ai_media_play')).to_be_visible(timeout=20000)
        page.wait_for_timeout(1500)
        text = chat_file_text()
        names = sorted(re.findall(r'\[voice src=\\?"/user/files/(st-ai-audio-[^"\\]+)\\?"\]', text))
        assert names, 'src not saved in chat file'
        stored = user / 'user' / 'files' / names[-1]
        assert stored.read_bytes() == AUDIO
        speech = [e for e in LOG if e['path'] == '/v1/audio/speech']
        assert len(speech) == 1 and speech[0]['origin'] == args.st.rstrip('/') and json.loads(speech[0]['body'])['input'] == '"轻声晚上好"'
        last_mes().locator('.st_ai_media_play').click()
        # ST 自己启动时也会 new Audio()，按地址找本扩展创建的那个
        page.wait_for_function("window.__audios.some(a => a.src.includes('/user/files/st-ai-audio-') && (a.ended || a.currentTime > 0))", timeout=10000)
        checks.append('Voice: browser → TTS, WAV uploaded through real /api/files/upload (CSRF ok), src saved in the .jsonl chat file, played from /user/files')

        # Video via the real ST /proxy/.
        vbtn = last_mes().locator('.st_ai_media_video .st_ai_media_gen')
        vbtn.click()
        expect(vbtn).to_contain_text('50%', timeout=10000)
        expect(last_mes().locator('video.st_ai_inline_video')).to_be_visible(timeout=30000)
        runway = [e for e in LOG if e['path'].startswith(('/v1/text_to_video', '/v1/tasks/', '/files/clip'))]
        # 浏览器跨域直连一定带 Origin；ST 代理会删掉 Origin（User-Agent 原样转发），所以看 Origin。
        assert runway and all(e['origin'] is None for e in runway), runway
        assert speech[0]['origin'], 'direct TTS request should carry Origin (control)'
        assert all(e['auth'] == 'Bearer real-st-video-key' and e['runway'] == '2024-11-06' for e in runway if e['path'].startswith('/v1/'))
        page.wait_for_timeout(1500)
        videos = re.findall(r'\[video src=\\?"/user/files/(st-ai-video-[^"\\]+)\\?"\]', chat_file_text())
        assert videos and (user / 'user' / 'files' / sorted(videos)[-1]).read_bytes() == VIDEO
        last_mes().locator('video').evaluate('(el) => el.play()')
        page.wait_for_function('document.querySelector("#chat .mes:last-child video").readyState >= 2', timeout=10000)
        page.screenshot(path=str(output / 'real-st-chat.png'))
        checks.append('Video: every Runway request went through real ST /proxy/ (Origin stripped, unlike the direct TTS call) with key + version header; proxied WebM had no Content-Type and was recognized by header bytes; stored and plays inline')

        # Reload: ST shows its welcome page after a reload; reopen the character chat from disk.
        boot()
        page.wait_for_function('SillyTavern.getContext().characters.length > 0', timeout=30000)
        ctx('await c.selectCharacterById(0); return true;')
        page.wait_for_function('SillyTavern.getContext().characterId !== undefined && SillyTavern.getContext().chat.length > 1', timeout=30000)
        expect(last_mes().locator('.st_ai_media_play')).to_be_visible(timeout=15000)
        expect(last_mes().locator('video.st_ai_inline_video')).to_be_visible()
        open_tab('speech')
        expect(page.locator('#st_ai_speech_key')).to_have_value('real-st-voice-key')
        page.locator('#st_ai_float_close').click()
        checks.append('Reload: ST reopened the chat and both players re-rendered; settings came back from the server')

        # CSRF header regression: the old code sent X-CSRF-Token twice.
        status = ctx("""
            const token = (await (await fetch('/csrf-token')).json()).token;
            const body = JSON.stringify({ fileName: 'x' });
            const dup = await fetch('/api/files/sanitize-filename', { method: 'POST', headers: { ...c.getRequestHeaders(), 'x-csrf-token': token }, body });
            const one = await fetch('/api/files/sanitize-filename', { method: 'POST', headers: c.getRequestHeaders(), body });
            return [dup.status, one.status];""")
        assert status[1] == 200 and status[0] == 403, status
        checks.append(f'Confirmed old header bug on real ST: duplicate X-CSRF-Token → HTTP {status[0]}, single header → {status[1]}')

        # Image: generate inline and save to gallery (uses the fixed CSRF headers).
        open_tab('generate')
        page.locator('#st_gpt_image_provider').select_option('openai')
        page.locator('#st_gpt_image_api_base').fill(mock_base)
        page.locator('#st_gpt_image_api_key').fill('real-st-image-key')
        page.locator('#st_gpt_image_model').fill('image-model-x')
        page.wait_for_timeout(800)
        page.locator('#st_ai_float_close').click()
        ctx("await c.executeSlashCommandsWithOptions('/sendas name=\"' + c.characters[c.characterId].name + '\" [image]a red square[/image]'); return true;")
        expect(last_mes().locator('.st_gpt_inline_gen')).to_be_visible(timeout=15000)
        page.wait_for_timeout(2500)  # ST 发完消息还会再重渲染一次；原版的临时图片结果会随旧节点丢失
        last_mes().locator('.st_gpt_inline_gen').click()
        page.wait_for_timeout(1500)
        expect(last_mes().locator('img.st_gpt_inline_img')).to_have_count(1, timeout=15000)  # 1×1 懒加载图，Playwright 视为不可见
        # 生成后自动存进当前聊天媒体库（9f9f7ef 起），按钮直接是「查看媒体库」，不用再点「存入」
        expect(last_mes().locator('[data-action="view-gallery"]')).to_have_count(1, timeout=15000)
        page.wait_for_timeout(2500)
        images = list((user / 'user' / 'images').rglob('st-ai-image-*.png'))
        assert images, 'no image uploaded to ST gallery'
        assert any(img.parent.name == char_name for img in images), [str(i) for i in images]  # 按角色名分文件夹
        mine = max((i for i in images if i.parent.name == char_name), key=lambda i: i.stat().st_mtime)
        checks.append(f'Image generated inline is auto-saved (button shows "view gallery") and uploaded to ST user/images under the character folder ({mine.parent.name}/{mine.name})')

        bad = [e for e in console_errors if 'st-ai-image' in e or 'st_ai' in e]
        result = {'status': 'passed', 'checks': checks, 'mock_requests': len(LOG), 'extension_errors': bad}
        (output / 'real-st-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, indent=2))
        browser.close()
    mock.shutdown()


if __name__ == '__main__':
    main()
