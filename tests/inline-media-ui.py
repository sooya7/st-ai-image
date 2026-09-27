"""Headless browser + simulated SillyTavern host + local mock services. No paid APIs.

Covers voice/video tags embedded in chat (generate → upload to /api/files → write src back
into the message → survive reload), the settings-only media tabs, the SillyTavern /proxy/
path, video task resume after reload, and the image protocol selector.

Usage: python tests/inline-media-ui.py --output PATH
Requires Python Playwright and Chromium. ffmpeg (optional) makes a real WebM so video
playback can be checked; without it only byte-exact storage is verified.
"""
import argparse
import base64
import functools
import io
import json
import math
from pathlib import Path
import re
import struct
import subprocess
import threading
import time
import wave
import zlib
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOG, UPLOADS, FILES = [], [], {}
SD_CALLS = []
STATE = {'polls': {}, 'slow_done': False, 'jobs': 0}


def make_wav():
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b''.join(struct.pack('<h', int(2000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(8000)))
    return buffer.getvalue()


def png_1x1():
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00')) + chunk(b'IEND', b'')


def make_webm():
    try:
        return subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1',
                               '-c:v', 'libvpx', '-b:v', '100k', '-f', 'webm', 'pipe:1'], capture_output=True, check=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return None


AUDIO = make_wav()
PNG_B64 = base64.b64encode(png_1x1()).decode()
REAL_WEBM = make_webm()
VIDEO = REAL_WEBM or b'\x1a\x45\xdf\xa3fake-webm-bytes'
MIME = {'.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webm': 'video/webm', '.mp4': 'video/mp4'}


class Handler(SimpleHTTPRequestHandler):
    proxied = False

    def log_message(self, *args):
        pass

    def reply(self, status, payload, content_type='application/json'):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        # Real SillyTavern /proxy/ pipes the body without Content-Type and turns 401 into 400.
        if self.proxied and status == 401:
            status = 400
        self.send_response(status)
        if not self.proxied:
            self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def record(self, method, body=''):
        LOG.append({'method': method, 'path': self.path, 'body': body, 'proxied': self.proxied,
                    'auth': self.headers.get('Authorization'), 'runway': self.headers.get('X-Runway-Version'),
                    'goog': self.headers.get('x-goog-api-key')})

    def unproxy(self):
        """Mimic SillyTavern /proxy/<absolute url>: forward to our own mock routes."""
        if not self.path.startswith('/proxy/'):
            return True
        target = urlparse(self.path[len('/proxy/'):])
        if target.netloc != self.headers['Host']:
            self.reply(400, {'error': 'fixture proxy only reaches the mock server'})
            return False
        self.path, self.proxied = target.path + (f'?{target.query}' if target.query else ''), True
        return True

    def do_POST(self):
        if not self.unproxy():
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        if self.path == '/api/files/upload':
            data = json.loads(body)
            ok = self.headers.get('x-csrf-token') == 'fixture-csrf' and bool(re.fullmatch(r'[A-Za-z0-9_.-]+', data['name']))
            UPLOADS.append({'name': data['name'], 'csrf': ok})
            if not ok:
                return self.reply(400, {'error': 'bad upload'})
            FILES[data['name']] = base64.b64decode(data['data'])
            return self.reply(200, {'path': f"/user/files/{data['name']}"})
        self.record('POST', body)
        if self.path in ('/api/sd/comfy/generate', '/api/sd/generate'):
            data = json.loads(body)
            call = {'path': self.path, 'csrf': self.headers.get('x-csrf-token') == 'fixture-csrf', 'url': data.get('url')}
            if self.path == '/api/sd/generate':
                call.update(prompt=data.get('prompt'), auth=data.get('auth'), width=data.get('width'))
                SD_CALLS.append(call)
                return self.reply(200, {'images': [PNG_B64]})
            workflow = json.loads(data['prompt'])['prompt']
            call['texts'] = [n['inputs'].get('text') for n in workflow.values() if 'text' in n.get('inputs', {})]
            call['seed'] = next((n['inputs']['seed'] for n in workflow.values() if 'seed' in n.get('inputs', {})), None)
            SD_CALLS.append(call)
            if any('Video' in n['class_type'] for n in workflow.values()):
                return self.reply(200, {'format': 'webm', 'data': base64.b64encode(VIDEO).decode()})
            return self.reply(200, {'format': 'png', 'data': PNG_B64})
        if self.path == '/nai/ai/generate-image':
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
                z.writestr('image_0.png', png_1x1())
            return self.reply(200, buf.getvalue(), 'application/x-zip-compressed')
        if self.path == '/mock/v1/audio/speech':
            text = json.loads(body)['input']
            if 'FAIL' in text:
                return self.reply(401, {'error': 'bad key'})
            if 'WAIT' in text:
                time.sleep(2.5)
            return self.reply(200, AUDIO, 'audio/wav')
        if self.path == '/mock/v1/text_to_video':
            prompt = json.loads(body)['promptText']
            STATE['jobs'] += 1
            return self.reply(200, {'id': 'job-slow' if 'SLOW' in prompt else f"job-ok-{STATE['jobs']}"})
        if 'IMG500' in body:
            return self.reply(500, {'error': 'mock server error'})
        if 'IMG404' in body and self.path.endswith('/images/generations'):
            return self.reply(404, {'error': 'not here'})
        if self.path.endswith('/images/generations'):
            return self.reply(200, {'data': [{'b64_json': PNG_B64}]})
        if self.path.endswith('/chat/completions'):
            return self.reply(200, {'choices': [{'message': {'content': f'![img](data:image/png;base64,{PNG_B64})'}}]})
        if ':generateContent' in self.path:
            return self.reply(200, {'candidates': [{'content': {'parts': [{'inlineData': {'mimeType': 'image/png', 'data': PNG_B64}}]}}]})
        self.reply(404, {'error': 'unknown mock route'})

    def do_GET(self):
        if not self.unproxy():
            return
        if self.path == '/csrf-token':
            return self.reply(200, {'token': 'fixture-csrf'})
        if self.path.startswith('/user/files/'):
            name = self.path.rsplit('/', 1)[1]
            if name not in FILES:
                return self.reply(404, {'error': 'missing'})
            return self.reply(200, FILES[name], MIME.get(Path(name).suffix, 'application/octet-stream'))
        if not self.path.startswith('/mock/'):
            return super().do_GET()
        self.record('GET')
        if self.path.startswith('/mock/v1/tasks/'):
            job = self.path.rsplit('/', 1)[1]
            count = STATE['polls'][job] = STATE['polls'].get(job, 0) + 1
            done = {'id': job, 'status': 'SUCCEEDED', 'output': [f'http://{self.headers["Host"]}/mock/files/clip.webm']}
            if job == 'job-slow':
                return self.reply(200, done if STATE['slow_done'] else {'id': job, 'status': 'RUNNING', 'progress': 0.1})
            return self.reply(200, {'id': job, 'status': 'RUNNING', 'progress': 0.4} if count == 1 else done)
        if self.path == '/mock/files/clip.webm':
            return self.reply(200, VIDEO, 'video/webm')
        self.reply(404, {'error': 'unknown mock route'})


INSTRUMENT = """(() => {
    const stats = window.mediaStats = { timers: new Set(), audios: [], stacks: new Map() };
    const schedule = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
        const media = /\\/media\\/|\\/inline\\/media/.test(new Error().stack);
        const id = schedule(() => { stats.timers.delete(id); fn(...args); }, delay);
        if (media) { stats.timers.add(id); stats.stacks.set(id, `${delay}ms ${new Error().stack.split('\\n').slice(2, 5).join(' | ')}`); }
        return id;
    };
    window.clearTimeout = (id) => { stats.timers.delete(id); clear(id); };
    const NativeAudio = window.Audio;
    window.Audio = function (src) { const audio = new NativeAudio(src); stats.audios.push(audio); return audio; };
    window.confirm = () => true;
})();"""


def posts(part):
    return [e for e in LOG if e['method'] == 'POST' and part in e['path']]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    checks, errors = [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1100, 'height': 900})
            context.add_init_script(INSTRUMENT)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            raw = lambda i: page.evaluate(f'fixture.state.chat[{i}].mes')
            mes = lambda i: page.locator(f'.mes[mesid="{i}"] .mes_text')
            toasts = lambda: page.evaluate('fixture.toasts.map(t => t.message).join(" | ")')

            def load():
                page.goto(origin + '/tests/st-fixture.html')
                page.wait_for_load_state('networkidle')
                expect(mes(1).locator('.st_ai_media').first).to_be_visible()

            def open_tab(tab):
                if not page.locator('#st_ai_dialog').evaluate('(d) => d.open'):
                    page.locator('#st_ai_image_wand_button').click()
                page.locator(f'.st_ai_tab[data-tab="{tab}"]').click()

            def close_panel():
                page.locator('#st_ai_float_close').click()

            try:
                run_checks(page, origin, output, checks, errors, raw, mes, load, open_tab, close_panel, browser)
            except Exception:
                print('--- failure context ---')
                print('toasts:', toasts())
                print('requests:', [(e['method'], e['path']) for e in LOG[-8:]], 'uploads:', UPLOADS[-3:])
                print('page errors:', errors)
                page.screenshot(path=str(output / 'failure.png'))
                raise
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


def run_checks(page, origin, output, checks, errors, raw, mes, load, open_tab, close_panel, browser):
    # ---------- initial load ----------
    load()
    loaded = page.evaluate("performance.getEntriesByType('resource').map(r => r.name).join(' ')")
    for lazy in ['media/client.js', 'media/providers.js', 'media-settings-view.js', 'st/files.js']:
        assert lazy not in loaded, lazy
    assert not LOG
    audio_btn = mes(1).locator('.st_ai_media_audio .st_ai_media_gen')
    video_btn = mes(1).locator('.st_ai_media_video .st_ai_media_gen')
    expect(audio_btn).to_have_text(re.compile('配音'))
    expect(mes(1).locator('.st_ai_voice_text')).to_have_text('"轻声晚上好"')
    expect(video_btn).to_have_text(re.compile('生成视频'))
    expect(mes(6).locator('.st_gpt_inline_gen')).to_be_visible()
    page.wait_for_timeout(800)
    assert page.evaluate('mediaStats.timers.size') == 0
    checks.append('Load: [voice]/[video] tags become inline buttons (voice text stays visible), [image] still works; protocol/client modules not loaded; no API calls or media timers')

    audio_btn.click()
    page.wait_for_function("fixture.toasts.some(t => t.message.includes('API Key'))")
    assert not posts('audio/speech')
    checks.append('No key: clicking asks for the key in settings and sends nothing')

    # ---------- settings-only speech tab ----------
    open_tab('speech')
    expect(page.locator('#st_ai_speech_base')).to_be_visible()
    assert page.locator('#st_ai_speech_panel .st_ai_media_gen, #st_ai_speech_panel button:has-text("生成"), #st_ai_speech_panel button:has-text("配音")').count() == 0  # 只有试听/增删，没有生成
    assert page.locator('#st_ai_speech_panel audio, #st_ai_speech_panel video').count() == 0
    page.locator('#st_ai_speech_base').fill(origin + '/mock/v1')
    page.locator('#st_ai_speech_key').fill('fixture-voice-key')
    page.wait_for_timeout(700)
    saved = page.evaluate("JSON.parse(sessionStorage.getItem('fixture-state')).settings['st-ai-image'].speech")
    assert saved['profiles']['openai']['key'] == 'fixture-voice-key' and saved['profiles']['openai']['base'].endswith('/mock/v1')
    assert page.evaluate('fixture.saves.settings') > 0
    page.screenshot(path=str(output / 'settings-speech.png'))
    close_panel()
    checks.append('Speech tab is settings only (no generate button/player); edits call saveSettingsDebounced and persist')

    # ---------- voice generation embedded in chat ----------
    audio_btn.evaluate('(b) => { b.click(); b.click(); }')
    expect(mes(1).locator('.st_ai_media_play')).to_be_visible(timeout=10000)
    speech = posts('audio/speech')
    assert len(speech) == 1, speech
    sent = json.loads(speech[0]['body'])
    assert sent['input'] == '"轻声晚上好"' and speech[0]['auth'] == 'Bearer fixture-voice-key', sent
    assert sent['voice'] == 'alloy', sent  # 没写 name、发言人也没配：用默认音色
    text1 = raw(1)
    match = re.search(r'\[voice src="(/user/files/st-ai-audio-[^"]+\.wav)"\]"\*轻声\*晚上好"\[/voice\]', text1)
    assert match, text1
    name = match.group(1).rsplit('/', 1)[1]
    assert UPLOADS[-1] == {'name': name, 'csrf': True} and FILES[name] == AUDIO
    assert '[video]雨夜的城市，镜头缓慢推进[/video]' in text1
    expect(mes(1).locator('.st_ai_voice_text')).to_have_text('"轻声晚上好"')
    checks.append('Voice: one click → one request with rendered text; WAV uploaded with CSRF, src written into the original tag (markdown *…* kept), player replaces the button')

    mes(1).locator('.st_ai_media_play').click()
    page.wait_for_function("mediaStats.audios.length === 1 && (mediaStats.audios[0].ended || mediaStats.audios[0].currentTime > 0)")
    assert page.evaluate('mediaStats.audios[0].src').endswith(match.group(1))
    page.wait_for_function("mediaStats.audios[0].ended", timeout=5000)
    expect(mes(1).locator('.st_ai_media_play i')).to_have_class(re.compile('fa-play'))
    checks.append('Play button streams the stored file from /user/files, decodes, and resets after it ends')

    second = mes(3).locator('.st_ai_media_gen').nth(1)
    second.click()
    expect(mes(3).locator('.st_ai_media_play')).to_have_count(1, timeout=10000)
    assert re.fullmatch(r'重复两遍：\[voice\]嗯\[/voice\] 和 \[voice src="/user/files/st-ai-audio-[^"]+"\]嗯\[/voice\]', raw(3)), raw(3)
    checks.append('Two identical tags in one message: only the clicked (second) tag receives the src')

    # ---------- voice presets (editable, any provider) ----------
    def preset_row(type_name):
        return page.locator('#st_ai_speech_panel .st_ai_voice_row').filter(has=page.locator(f'.st_ai_voice_type[value="{type_name}"]'))

    open_tab('speech')
    old_voice = page.locator('#st_ai_speech_voice').input_value()
    rows = page.locator('#st_ai_speech_panel .st_ai_voice_row')
    expect(rows).to_have_count(13)  # 非 Fish 服务：类型名预设好，音色空着
    expect(page.locator('#st_ai_speech_fish_fill')).to_be_hidden()
    assert rows.nth(0).locator('.st_ai_voice_id').input_value() == ''
    expect(page.locator('#st_ai_speech_voice')).to_be_visible()  # 默认音色是自定义 ID（alloy）
    preset_row('御姐').locator('.st_ai_voice_id').fill('voice-yujie')
    renamed = preset_row('少年')
    renamed.locator('.st_ai_voice_type').fill('冷酷剑客')
    renamed.locator('.st_ai_voice_id').fill('voice-jianke')
    page.locator('#st_ai_speech_voice_preset').select_option('__custom__')
    page.locator('#st_ai_speech_voice').fill('voice-default')
    page.wait_for_timeout(700)
    saved = page.evaluate("JSON.parse(sessionStorage.getItem('fixture-state')).settings['st-ai-image'].speech.profiles.openai")
    assert saved['voice'] == 'voice-default', saved
    assert {'type': '御姐', 'voice': 'voice-yujie'} in saved['presets'] and {'type': '冷酷剑客', 'voice': 'voice-jianke'} in saved['presets'], saved['presets']
    labels = page.locator('#st_ai_speech_voice_preset option').all_inner_texts()
    assert labels[1:3] == ['御姐', '冷酷剑客'], labels  # 下拉框只列配了音色的类型
    page.locator('#st_ai_speech_voice_preset').select_option(label='御姐')
    expect(page.locator('#st_ai_speech_voice')).to_be_hidden()
    page.locator('#st_ai_speech_voice_preset').select_option('__custom__')
    page.locator('#st_ai_speech_voice').fill('voice-default')
    before = len(posts('audio/speech'))
    preset_row('御姐').locator('.st_ai_voice_preview').click()
    page.wait_for_function("[...document.querySelectorAll('#st_ai_speech_panel .st_ai_voice_preview')].every((b) => b.textContent === '试听')", timeout=10000)
    assert [json.loads(r['body'])['voice'] for r in posts('audio/speech')[before:]] == ['voice-yujie']
    assert page.locator('#st_ai_speech_panel .st_ai_media_warning').inner_text() == ''
    page.locator('#st_ai_speech_voice_preset').scroll_into_view_if_needed()
    page.screenshot(path=str(output / 'settings-voice-presets.png'))
    page.wait_for_timeout(600)
    close_panel()

    expect(mes(7).locator('.st_ai_media_gen').first).to_have_attribute('title', '林晚 · 御姐：快进来')
    before = len(posts('audio/speech'))
    for i in range(4):
        mes(7).locator('.st_ai_media_gen').first.click()
        expect(mes(7).locator('.st_ai_media_play')).to_have_count(i + 1, timeout=10000)
    voices = [json.loads(r['body'])['voice'] for r in posts('audio/speech')[before:]]
    # 表里有 → 用表里的；没写 type、type 不在表里 → 默认音色；改过名的类型照样生效
    assert voices == ['voice-yujie', 'voice-default', 'voice-default', 'voice-jianke'], voices
    assert re.fullmatch(r'林晚招手：\[voice type="御姐" name="林晚" src="/user/files/st-ai-audio-[^"]+"\]快进来\[/voice\] 店主笑道：\[voice src="/user/files/st-ai-audio-[^"]+"\]欢迎光临\[/voice\] \[voice type="不存在" src="/user/files/st-ai-audio-[^"]+"\]嗯哼\[/voice\] \[voice type="冷酷剑客" src="/user/files/st-ai-audio-[^"]+"\]走\[/voice\]', raw(7)), raw(7)

    # Fish 地址：出现「填入 Fish 推荐音色」，只补同名行、保留自己加的类型
    open_tab('speech')
    old_base = page.locator('#st_ai_speech_base').input_value()
    page.locator('#st_ai_speech_base').fill('https://api.fish.audio/compat/v1')
    expect(page.locator('#st_ai_speech_fish_fill')).to_be_visible()
    assert preset_row('御姐').locator('.st_ai_voice_id').get_attribute('list') == 'st_ai_speech_fish_voices'
    page.locator('#st_ai_speech_fish_fill').click()
    expect(preset_row('御姐').locator('.st_ai_voice_id')).to_have_value('c189c7cff21c400ba67592406202a3a0')
    expect(preset_row('冷酷剑客').locator('.st_ai_voice_id')).to_have_value('voice-jianke')
    expect(rows).to_have_count(14)  # 少年被改名了，推荐里的少年补在最后
    page.locator('#st_ai_speech_base').fill(old_base)
    page.locator('#st_ai_speech_voice_preset').select_option('__custom__')
    page.locator('#st_ai_speech_voice').fill(old_voice)
    page.wait_for_timeout(700)
    close_panel()
    checks.append('Voice presets: preset type names with editable voices for any provider (rename/fill/preview), default-voice dropdown lists filled types, [voice type] uses the table else the default, Fish endpoint offers one-click recommended voices without overwriting custom rows')

    before = len(posts('audio/speech'))
    mes(2).locator('.st_ai_media_gen').click()
    expect(mes(2).locator('.st_ai_media_error')).to_contain_text('401', timeout=10000)
    expect(mes(2).locator('.st_ai_media_gen')).to_have_class(re.compile('st_ai_media_gen_error'))
    page.wait_for_timeout(300)
    assert len(posts('audio/speech')) == before + 1 and raw(2) == '[语音]FAIL 这句会失败[/语音]'
    checks.append('Failure shows inline error on the button, is not retried, and leaves the message untouched')

    uploads_before = len(UPLOADS)
    mes(5).locator('.st_ai_media_gen').click()
    page.wait_for_timeout(300)
    page.evaluate("fixtureSwitchChat('chat-B')")
    page.wait_for_function(f'fixture.toasts.some(t => t.message.includes("聊天已切换"))', timeout=8000)
    assert raw(5) == '[配音]WAIT 慢慢说[/配音]' and len(UPLOADS) == uploads_before + 1
    page.evaluate("fixture.state.chatId = 'chat-A'; fixture.persist()")
    checks.append('Chat switched mid-generation: file is kept but never written into the other chat')

    # ---------- reload: results persist ----------
    load()
    expect(mes(1).locator('.st_ai_media_play')).to_be_visible()
    expect(mes(3).locator('.st_ai_media_play')).to_have_count(1)
    open_tab('speech')
    expect(page.locator('#st_ai_speech_key')).to_have_value('fixture-voice-key')
    close_panel()
    checks.append('Reload: players come back from the saved chat; speech settings and key persist')

    # ---------- video via SillyTavern proxy ----------
    open_tab('video')
    # 默认是 /videos 兼容服务；Runway 在浏览器版酒馆里放在「其他」分组
    expect(page.locator('#st_ai_video_provider')).to_have_value('openai')
    expect(page.locator('#st_ai_video_provider optgroup option[value="runway"]')).to_have_count(1)
    expect(page.locator('#st_ai_video_provider option[value="agnes"]')).to_have_count(0)  # Agnes 并进了 /videos 兼容
    for value in ('ark', 'minimax', 'dashscope', 'veo', 'zhipu', 'siliconflow', 'fal', 'comfyui'):
        expect(page.locator(f'#st_ai_video_provider > option[value="{value}"]')).to_have_count(1)
    for value in ('luma', 'kling', 'vidu', 'runway', 'replicate'):
        expect(page.locator(f'#st_ai_video_provider optgroup option[value="{value}"]')).to_have_count(1)
    page.locator('#st_ai_video_quick_agnes').click()
    expect(page.locator('#st_ai_video_base')).to_have_value('https://apihub.agnes-ai.com/v1')
    expect(page.locator('#st_ai_video_size')).to_have_value('720P')
    page.locator('#st_ai_video_provider').select_option('runway')
    page.locator('#st_ai_video_base').fill(origin + '/mock/v1')
    page.locator('#st_ai_video_key').fill('fixture-video-key')
    page.locator('#st_ai_video_proxy').check()
    page.wait_for_timeout(700)
    assert page.locator('#st_ai_video_panel .st_ai_media_gen, #st_ai_video_panel button:has-text("生成")').count() == 0  # 只有恢复默认，没有生成
    close_panel()
    video_btn = mes(1).locator('.st_ai_media_video .st_ai_media_gen')
    video_btn.click()
    expect(video_btn).to_contain_text('40%', timeout=10000)
    expect(mes(1).locator('video.st_ai_inline_video')).to_be_visible(timeout=20000)
    runway = [e for e in LOG if '/mock/v1/text_to_video' in e['path'] or '/mock/v1/tasks/job-ok' in e['path'] or e['path'] == '/mock/files/clip.webm']
    assert runway and all(e['proxied'] for e in runway), runway
    assert all(e['auth'] == 'Bearer fixture-video-key' and e['runway'] for e in runway if '/v1/' in e['path'])
    vmatch = re.search(r'\[video src="(/user/files/st-ai-video-[^"]+\.webm)"\]雨夜的城市，镜头缓慢推进\[/video\]', raw(1))
    assert vmatch, raw(1)
    assert FILES[vmatch.group(1).rsplit('/', 1)[1]] == VIDEO
    video = mes(1).locator('video.st_ai_inline_video')
    assert video.get_attribute('preload') == 'none' and video.get_attribute('autoplay') is None
    playback = False
    if REAL_WEBM:
        video.evaluate('(v) => v.play()')
        page.wait_for_function("document.querySelector('.mes[mesid=\"1\"] video').readyState >= 2")
        playback = True
    page.screenshot(path=str(output / 'chat-inline-media.png'))
    checks.append('Video (Runway via /proxy/): progress 0.4 → 40% on the button; every request proxied with key + version; WebM saved to /user/files and embedded' + (' and plays' if playback else ''))

    # ---------- video resume after reload ----------
    mes(4).locator('.st_ai_media_gen').click()
    page.wait_for_function("fixture.state.chat[4].extra?.st_ai_media_jobs && Object.keys(fixture.state.chat[4].extra.st_ai_media_jobs).length === 1")
    record = page.evaluate('JSON.stringify(fixture.state.chat[4].extra)')
    assert 'fixture-video-key' not in record
    load()
    resume = mes(4).locator('.st_ai_media_gen')
    expect(resume).to_have_text(re.compile('继续查询视频任务'))
    STATE['slow_done'] = True
    resume.click()
    expect(mes(4).locator('video.st_ai_inline_video')).to_be_visible(timeout=10000)
    assert len([e for e in posts('text_to_video') if 'SLOW' in e['body']]) == 1
    assert page.evaluate('fixture.state.chat[4].extra?.st_ai_media_jobs') is None
    checks.append('Reload during a video job: task handle (no key) saved in message.extra; button offers resume; resume polls without a new POST, then clears the record')

    # ---------- regenerate ----------
    old_src = re.search(r'src="([^"]+)"', raw(3)).group(1)
    mes(3).locator('.st_ai_media_regen').click()
    page.wait_for_function(f"!fixture.state.chat[3].mes.includes('{old_src}')", timeout=10000)
    assert raw(3).count('src=') == 1
    checks.append('Regenerate swaps in a new file for that tag only')

    # ---------- toggles: each feature page holds its own AI-tag prompt ----------
    assert [t.strip() for t in page.locator('.st_ai_tab').all_inner_texts()] == ['图片', '配音', '视频', '图库']
    open_tab('speech')
    expect(page.locator('#st_ai_prompt_speech_auto_inject')).to_be_visible()  # 配音的自动标签就在配音页
    expect(page.locator('#st_ai_prompt_speech_text')).to_be_hidden()  # 提示词默认折叠
    assert page.locator('#st_ai_speech_panel #st_ai_prompt_image_auto_inject, #st_ai_speech_panel #st_ai_prompt_video_auto_inject').count() == 0
    page.locator('#st_ai_prompt_speech_auto_inject').check()
    page.wait_for_function("(fixture.prompts['st-ai-image-voice'] || '').includes('什么时候加')")
    page.locator('#st_ai_prompt_speech_details > summary').click()
    page.locator('#st_ai_prompt_speech_text').fill('[voice] 自定义规则')
    page.wait_for_function("fixture.prompts['st-ai-image-voice'] === '[voice] 自定义规则'")
    # 同一页里改别的字段，不能把刚存的开关和提示词冲掉
    old_voice = page.locator('#st_ai_speech_voice').input_value()
    page.locator('#st_ai_speech_voice').fill('nova-check')
    page.wait_for_timeout(600)
    page.locator('#st_ai_speech_voice').fill(old_voice)
    page.wait_for_timeout(600)
    assert page.evaluate("fixture.prompts['st-ai-image-voice']") == '[voice] 自定义规则'
    page.locator('#st_ai_prompt_speech_reset').click()
    page.wait_for_function("(fixture.prompts['st-ai-image-voice'] || '').includes('什么时候加')")
    page.locator('#st_ai_prompt_speech_auto_inject').uncheck()
    page.wait_for_function("fixture.prompts['st-ai-image-voice'] === ''")
    open_tab('video')
    expect(page.locator('#st_ai_prompt_video_auto_inject')).to_be_visible()
    open_tab('generate')
    page.locator('#st_ai_prompt_image_auto_inject').scroll_into_view_if_needed()
    page.locator('#st_ai_prompt_image_auto_inject').uncheck()
    page.wait_for_function("fixture.prompts['st-ai-image'] === ''")
    page.locator('#st_ai_prompt_image_auto_inject').check()
    page.wait_for_function("(fixture.prompts['st-ai-image'] || '').includes('[image]')")
    expect(page.locator('#st_gpt_image_api_base')).to_be_attached()  # 图片接口设置也在图片页
    open_tab('speech')
    page.locator('#st_ai_speech_enabled').uncheck()
    page.wait_for_timeout(300)
    load()
    expect(mes(2)).to_contain_text('[语音]FAIL 这句会失败[/语音]')
    assert mes(2).locator('.st_ai_media_gen').count() == 0
    expect(mes(1).locator('.st_ai_media_play')).to_be_visible()
    open_tab('speech')
    page.locator('#st_ai_speech_enabled').check()
    close_panel()
    checks.append('One page per feature (图片/配音/视频/图库): each page holds its own AI-tag toggle and folded prompt (inject, custom text, reset) without being clobbered by the same page; disabling voice leaves new tags as text while generated players still render')

    # ---------- image protocols (settings now live on the image page) ----------
    open_tab('generate')
    page.locator('#st_gpt_image_provider').select_option('openai')
    page.locator('#st_gpt_image_api_base').fill(origin + '/mock')
    page.locator('#st_gpt_image_api_key').fill('fixture-image-key')
    page.locator('#st_gpt_image_model').fill('image-model-x')
    page.wait_for_timeout(700)
    page.locator('.st_ai_tab[data-tab="generate"]').click()
    page.locator('#st_gpt_image_prompt').fill('a red square')
    page.locator('#st_gpt_image_generate_btn').click()
    expect(page.locator('#st_gpt_gen_result img.st_gpt_gen_img')).to_have_count(1, timeout=10000)
    call = posts('/images/generations')[-1]
    assert call['path'] == '/mock/v1/images/generations' and call['auth'] == 'Bearer fixture-image-key'
    assert json.loads(call['body'])['prompt'] == 'a red square'  # 默认画师串是空的，描述原样发出
    open_tab('generate')
    page.locator('#st_gpt_image_provider').select_option('gemini')
    page.locator('#st_gpt_image_model').fill('gemini-image-x')
    page.wait_for_timeout(700)
    page.locator('.st_ai_tab[data-tab="generate"]').click()
    page.locator('#st_gpt_image_generate_btn').click()
    expect(page.locator('#st_gpt_gen_result img.st_gpt_gen_img')).to_have_count(1, timeout=10000)
    call = posts(':generateContent')[-1]
    assert call['path'] == '/mock/v1beta/models/gemini-image-x:generateContent' and call['goog'] == 'fixture-image-key' and call['auth'] is None
    open_tab('generate')
    page.locator('#st_gpt_image_provider').select_option('auto')
    page.locator('#st_gpt_image_model').fill('image-model-x')
    page.wait_for_timeout(700)
    page.locator('.st_ai_tab[data-tab="generate"]').click()
    before = len([e for e in LOG if e['method'] == 'POST'])
    page.locator('#st_gpt_image_prompt').fill('IMG500 test')
    page.locator('#st_gpt_image_generate_btn').click()
    expect(page.locator('#st_gpt_gen_result')).to_contain_text('生成失败', timeout=10000)
    page.wait_for_timeout(300)
    assert len([e for e in LOG if e['method'] == 'POST']) == before + 1
    mark = len(LOG)
    page.locator('#st_gpt_image_prompt').fill('IMG404 test')
    page.locator('#st_gpt_image_generate_btn').click()
    expect(page.locator('#st_gpt_gen_result img.st_gpt_gen_img')).to_have_count(1, timeout=10000)
    tried = [e['path'] for e in LOG[mark:] if e['method'] == 'POST']
    assert tried[0].endswith('/images/generations') and tried[1].endswith('/chat/completions'), tried
    close_panel()
    checks.append('Image protocols: OpenAI Images and Gemini native requests; legacy mode does not resubmit on 500 but falls back on 404')

    # ---------- per-interface settings + NovelAI ----------
    open_tab('generate')
    expect(page.locator('#st_gpt_image_quality')).to_be_visible()
    expect(page.locator('#st_gpt_image_params')).to_be_hidden()  # 旧版兼容模式不用额外参数
    page.locator('#st_gpt_image_provider').select_option('novelai')
    expect(page.locator('#st_gpt_image_api_key_label')).to_contain_text('NovelAI 令牌')
    expect(page.locator('#st_gpt_image_provider_hint')).to_contain_text('Persistent API Token')
    expect(page.locator('#st_gpt_image_quality')).to_be_hidden()
    expect(page.locator('#st_gpt_image_size')).to_have_value('832x1216')
    expect(page.locator('#st_gpt_image_api_base')).to_have_value('https://image.novelai.net')
    expect(page.locator('#st_gpt_image_api_key')).to_have_value('')  # 中转站的 Key 不会带过来
    expect(page.locator('#st_gpt_image_model')).to_have_value('nai-diffusion-4-5-full')
    page.locator('#st_gpt_image_api_base').fill(origin + '/nai')
    page.locator('#st_gpt_image_api_key').fill('pst-fixture')
    page.locator('#st_gpt_image_size').select_option('1216x832')
    page.screenshot(path=str(output / 'image-novelai-settings.png'))
    # 不等防抖直接切走：刚填的也要记在 NovelAI 名下
    page.locator('#st_gpt_image_provider').select_option('openai')
    expect(page.locator('#st_gpt_image_api_base')).to_have_value(origin + '/mock')
    expect(page.locator('#st_gpt_image_api_key')).to_have_value('fixture-image-key')
    expect(page.locator('#st_gpt_image_model')).to_have_value('image-model-x')
    expect(page.locator('#st_gpt_image_quality')).to_be_visible()
    page.locator('#st_gpt_image_provider').select_option('novelai')
    expect(page.locator('#st_gpt_image_api_base')).to_have_value(origin + '/nai')
    expect(page.locator('#st_gpt_image_api_key')).to_have_value('pst-fixture')
    expect(page.locator('#st_gpt_image_size')).to_have_value('1216x832')
    page.locator('#st_gpt_image_prompt').fill('nai cat')
    page.locator('#st_gpt_image_generate_btn').click()
    expect(page.locator('#st_gpt_gen_result img.st_gpt_gen_img')).to_have_count(1, timeout=10000)
    call = posts('/nai/ai/generate-image')[-1]
    nai = json.loads(call['body'])
    assert call['auth'] == 'Bearer pst-fixture' and nai['input'] == 'nai cat' and nai['model'] == 'nai-diffusion-4-5-full', call
    assert [nai['parameters']['width'], nai['parameters']['height']] == [1216, 832] and nai['parameters']['v4_prompt']['caption']['base_caption'] == 'nai cat', nai
    saved = page.evaluate("JSON.parse(sessionStorage.getItem('fixture-state')).settings['st-ai-image']")
    assert saved['imageProfiles']['relay']['apiKey'] == 'fixture-image-key' and saved['apiKey'] == 'pst-fixture', saved.get('imageProfiles')
    # 一键填写：中转类接口下才有；先把当前配置存成 API 预设，再填上这家的地址和模型，Key 清空
    expect(page.locator('#st_gpt_image_quick')).to_be_hidden()
    page.locator('#st_gpt_image_provider').select_option('openai')
    expect(page.locator('#st_gpt_image_quick')).to_be_visible()
    page.locator('#st_gpt_image_quick button', has_text='智谱 CogView').click()
    expect(page.locator('#st_gpt_image_api_base')).to_have_value('https://open.bigmodel.cn/api/paas/v4')
    expect(page.locator('#st_gpt_image_model')).to_have_value('cogview-4-250304')
    expect(page.locator('#st_gpt_image_api_key')).to_have_value('')
    presets = page.evaluate("JSON.parse(localStorage.getItem('st-ai-image_presets') || '{}')")
    auto = [v for k, v in presets.items() if k.startswith('自动保存')]
    assert auto and auto[0]['apiKey'] == 'fixture-image-key' and auto[0]['apiBase'] == origin + '/mock', presets
    # 原生接口：选 MiniMax 就换成它的地址、Key 叫法和尺寸
    page.locator('#st_gpt_image_provider').select_option('minimax')
    expect(page.locator('#st_gpt_image_api_base')).to_have_value('https://api.minimax.cn')
    expect(page.locator('#st_gpt_image_api_key_label')).to_have_text('MiniMax API Key')
    expect(page.locator('#st_gpt_image_quick')).to_be_hidden()
    page.locator('#st_gpt_image_provider').select_option('pollinations')
    expect(page.locator('#st_gpt_image_api_key_label')).to_contain_text('可留空')
    page.locator('#st_gpt_image_provider').select_option('novelai')
    close_panel()
    checks.append('Per-interface settings: fields, labels, hints and size options follow the chosen interface; each interface remembers its own address/key/model/size (relay-type ones share); NovelAI request (V4.5 body, Bearer token) and zip response decoded into an image; one-click fill for OpenAI-compatible vendors saves the old config as an API preset first; native vendors (MiniMax, Pollinations) switch labels and defaults')

    # ---------- self-hosted: ComfyUI / SD WebUI through the tavern backend ----------
    comfy_image = json.dumps({
        '3': {'class_type': 'KSampler', 'inputs': {'seed': '%seed%', 'steps': '%steps%'}},
        '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'masterpiece, %prompt%'}},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': '%负面提示词%'}},
        '9': {'class_type': 'SaveImage', 'inputs': {'filename_prefix': 'st'}},
    })
    open_tab('generate')
    page.locator('#st_gpt_image_provider').select_option('comfyui')
    expect(page.locator('#st_gpt_image_api_key')).to_be_hidden()  # 自建服务不要 Key
    expect(page.locator('#st_gpt_image_comfy_workflow')).to_be_visible()
    expect(page.locator('#st_gpt_image_sd_auth')).to_be_hidden()
    expect(page.locator('#st_gpt_image_via_st')).to_be_checked()  # 默认经酒馆后端转发
    page.locator('#st_gpt_image_comfy_workflow').fill('{"nodes": [], "links": []}')
    expect(page.locator('#st_gpt_image_comfy_status')).to_contain_text('导出 (API)')
    page.locator('#st_gpt_image_comfy_workflow').fill(comfy_image)
    expect(page.locator('#st_gpt_image_comfy_status')).to_contain_text('✓ API 格式，4 个节点')
    page.locator('#st_gpt_image_api_base').fill('http://127.0.0.1:8188')
    # 工作流库：新建空白 → 粘贴未标记的工作流 → 自动标记 → 切回「默认」→ 删掉
    unmarked = json.dumps({
        '3': {'class_type': 'KSampler', 'inputs': {'seed': 1, 'steps': 20, 'cfg': 8, 'positive': ['6', 0], 'negative': ['7', 0], 'latent_image': ['5', 0]}},
        '5': {'class_type': 'EmptyLatentImage', 'inputs': {'width': 1024, 'height': 1024, 'batch_size': 1}},
        '6': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'scenery'}},
        '7': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'watermark'}},
        '9': {'class_type': 'SaveImage', 'inputs': {'images': ['8', 0]}},
    })
    page.locator('#st_ai_image_workflow_new').click()
    page.locator('#st_ai_image_workflow_name').fill('SDXL 测试')
    page.locator('#st_ai_image_workflow_name_ok').click()
    expect(page.locator('#st_ai_image_workflow_select')).to_have_value('SDXL 测试')
    expect(page.locator('#st_gpt_image_comfy_workflow')).to_have_value('')
    page.locator('#st_gpt_image_comfy_workflow').fill(unmarked)
    expect(page.locator('#st_gpt_image_comfy_status')).to_contain_text('没有占位符')
    page.locator('#st_ai_image_workflow_automark').click()
    expect(page.locator('#st_gpt_image_comfy_status')).to_contain_text('%prompt%')
    marked = json.loads(page.locator('#st_gpt_image_comfy_workflow').input_value())
    assert marked['6']['inputs']['text'] == '%prompt%' and marked['7']['inputs']['text'] == '%negative_prompt%' and marked['5']['inputs']['width'] == '%width%', marked
    page.locator('#st_ai_image_workflow_select').select_option('默认')
    expect(page.locator('#st_gpt_image_comfy_workflow')).to_have_value(comfy_image)
    page.wait_for_timeout(600)
    saved = page.evaluate("JSON.parse(sessionStorage.getItem('fixture-state')).settings['st-ai-image']")
    assert list(saved['comfyWorkflows']) == ['默认', 'SDXL 测试'] and saved['comfyWorkflowId'] == '默认', saved.get('comfyWorkflows')
    assert json.loads(saved['comfyWorkflows']['SDXL 测试'])['6']['inputs']['text'] == '%prompt%'
    page.locator('#st_ai_image_workflow_select').select_option('SDXL 测试')
    page.locator('#st_ai_image_workflow_delete').click()
    expect(page.locator('#st_ai_image_workflow_delete')).to_have_text('再点确认删除')
    page.locator('#st_ai_image_workflow_delete').click()
    expect(page.locator('#st_ai_image_workflow_select option')).to_have_count(1)
    expect(page.locator('#st_gpt_image_comfy_workflow')).to_have_value(comfy_image)
    # 画师串：新建一个，填前置和负面，生成时拼进去
    page.locator('#st_ai_prompt_preset_new').click()
    page.locator('#st_ai_prompt_preset_name').fill('厚涂')
    page.locator('#st_ai_prompt_preset_name_ok').click()
    expect(page.locator('#st_ai_prompt_preset_select')).to_have_value('厚涂')
    page.locator('#st_ai_prompt_preset_prefix').fill('artist:wlop,\nthick paint')
    page.locator('#st_ai_prompt_preset_negative').fill('blurry')
    page.locator('#st_ai_prompt_preset_select').scroll_into_view_if_needed()
    page.screenshot(path=str(output / 'image-prompt-presets.png'))
    page.locator('#st_ai_image_workflow_select').scroll_into_view_if_needed()
    page.screenshot(path=str(output / 'image-workflow-library.png'))
    page.wait_for_timeout(700)
    page.locator('#st_gpt_image_prompt').fill('comfy cat')
    page.locator('#st_gpt_image_generate_btn').click()
    page.wait_for_function("document.querySelector('#st_gpt_gen_result img.st_gpt_gen_img')", timeout=10000)
    page.wait_for_timeout(300)
    call = SD_CALLS[-1]
    assert call['path'] == '/api/sd/comfy/generate' and call['csrf'] and call['url'] == 'http://127.0.0.1:8188', call
    assert call['texts'] == ['masterpiece, artist:wlop, thick paint, comfy cat', 'blurry'] and isinstance(call['seed'], int), call
    page.locator('#st_gpt_image_provider').select_option('sdwebui')
    expect(page.locator('#st_gpt_image_sd_auth')).to_be_visible()
    expect(page.locator('#st_gpt_image_comfy_workflow')).to_be_hidden()
    page.locator('#st_gpt_image_sd_auth').fill('user:pass')
    page.locator('#st_gpt_image_api_base').fill('http://127.0.0.1:7860')
    page.wait_for_timeout(700)
    before = len(SD_CALLS)
    page.locator('#st_gpt_image_prompt').fill('webui dog')
    page.locator('#st_gpt_image_generate_btn').click()
    for _ in range(100):
        if len(SD_CALLS) > before:
            break
        page.wait_for_timeout(100)
    call = SD_CALLS[-1]
    assert call['path'] == '/api/sd/generate' and call['csrf'] and call['auth'] == 'user:pass' and call['prompt'] == 'artist:wlop, thick paint, webui dog' and call['url'] == 'http://127.0.0.1:7860', call
    expect(page.locator('#st_gpt_gen_result img.st_gpt_gen_img')).to_have_count(1, timeout=10000)
    page.locator('#st_ai_prompt_preset_select').select_option('默认')
    page.wait_for_timeout(600)
    close_panel()

    open_tab('video')
    page.locator('#st_ai_video_provider').select_option('comfyui')
    expect(page.locator('#st_ai_video_key')).to_be_hidden()
    expect(page.locator('#st_ai_video_workflow')).to_be_visible()
    expect(page.locator('#st_ai_video_direct')).to_be_visible()
    expect(page.locator('#st_ai_video_proxy')).to_be_hidden()
    expect(page.locator('#st_ai_video_workflow_status')).to_contain_text('还没有填工作流')
    expect(page.locator('#st_ai_video_workflow_lib_select')).to_have_value('默认')  # 视频也有自己的工作流库
    page.locator('#st_ai_video_workflow').fill(json.dumps({
        '1': {'class_type': 'WanTextEncode', 'inputs': {'text': '%提示词%', 'frames': '%frames%'}},
        '2': {'class_type': 'VHS_VideoCombine', 'inputs': {'frame_rate': '%fps%'}},
    }))
    page.wait_for_timeout(700)
    close_panel()
    mes(8).locator('.st_ai_media_gen').click()
    expect(mes(8).locator('video')).to_have_count(1, timeout=15000)
    call = SD_CALLS[-1]
    assert call['path'] == '/api/sd/comfy/generate' and call['texts'] == ['COMFY 海边日落'], call
    assert re.fullmatch(r'\[video src="/user/files/st-ai-video-[^"]+\.webm"\]COMFY 海边日落\[/video\]', raw(8)), raw(8)
    checks.append('Workflow library (new/auto-mark/switch/delete, persisted) and 画师串 presets (new, prefix/negative applied to ComfyUI and SD WebUI); self-hosted: ComfyUI (image + video) and SD WebUI through the tavern backend (/api/sd/comfy/generate, /api/sd/generate) with CSRF; placeholders filled (incl. 中文别名); no Key needed; fields shown per service; API-format workflow checked live; video saved and embedded')

    # ---------- mobile ----------
    for width in [390, 320]:
        page.set_viewport_size({'width': width, 'height': 844})
        mes(1).scroll_into_view_if_needed()
        box = mes(1).locator('video').bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= width, box
        for tab in ('video', 'speech', 'generate'):
            open_tab(tab)
            panel = page.locator(f'.st_ai_tab_content[data-tab="{tab}"]')
            assert panel.evaluate('(n) => n.scrollWidth <= n.clientWidth + 1'), tab
            page.screenshot(path=str(output / f'mobile-{width}-{tab}.png'))
        bar = page.locator('.st_ai_float_tabs').bounding_box()
        for tab in page.locator('.st_ai_tab').all():
            tb = tab.bounding_box()
            assert tb['x'] >= bar['x'] - 1 and tb['x'] + tb['width'] <= bar['x'] + bar['width'] + 1, (tab.text_content(), tb, bar)
        assert bar['height'] < 50, bar  # 四个标签一行放得下
        close_panel()
    checks.append('390px / 320px: embedded video and the image/voice/video pages fit without horizontal overflow; the four tabs stay on one row')

    page.wait_for_timeout(500)
    # 生成成功后扫描器会在 0.5/2/5 秒各补扫一次；等它们跑完，还剩的才算泄漏
    try:
        page.wait_for_function('mediaStats.timers.size === 0', timeout=8000)
    except Exception:
        raise AssertionError(page.evaluate('[...mediaStats.timers].map((id) => mediaStats.stacks.get(id))'))
    assert not errors, errors
    result = {'status': 'passed', 'checks': checks, 'mock_requests': len(LOG), 'uploads': len(UPLOADS), 'page_errors': errors,
              'browser': browser.version, 'real_webm_playback': playback, 'real_provider_verified': False,
              'real_sillytavern_verified': False}
    (output / 'inline-media-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
