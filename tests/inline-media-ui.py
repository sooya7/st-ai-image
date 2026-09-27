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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOG, UPLOADS, FILES = [], [], {}
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
    const stats = window.mediaStats = { timers: new Set(), audios: [] };
    const schedule = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => {
        const media = /\\/media\\/|\\/inline\\/media/.test(new Error().stack);
        const id = schedule(() => { stats.timers.delete(id); fn(...args); }, delay);
        if (media) stats.timers.add(id);
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
    assert page.locator('#st_ai_speech_panel button').count() == 0
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
    page.locator('#st_ai_video_base').fill(origin + '/mock/v1')
    page.locator('#st_ai_video_key').fill('fixture-video-key')
    page.locator('#st_ai_video_proxy').check()
    page.wait_for_timeout(700)
    assert page.locator('#st_ai_video_panel button').count() == 0
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

    # ---------- toggles ----------
    open_tab('prompts')
    for section in ('image', 'speech', 'video'):
        expect(page.locator(f'#st_ai_prompt_{section}_text')).to_be_visible()
    assert page.locator('#st_ai_speech_auto_inject').count() == 0
    page.locator('#st_ai_prompt_speech_auto_inject').check()
    page.wait_for_function("(fixture.prompts['st-ai-image-voice'] || '').includes('什么时候加')")
    page.locator('#st_ai_prompt_speech_text').fill('[voice] 自定义规则')
    page.wait_for_function("fixture.prompts['st-ai-image-voice'] === '[voice] 自定义规则'")
    # 在语音设置页改别的字段，不能把提示词页刚存的开关和文本冲掉
    open_tab('speech')
    old_voice = page.locator('#st_ai_speech_voice').input_value()
    page.locator('#st_ai_speech_voice').fill('nova-check')
    page.wait_for_timeout(600)
    page.locator('#st_ai_speech_voice').fill(old_voice)
    page.wait_for_timeout(600)
    assert page.evaluate("fixture.prompts['st-ai-image-voice']") == '[voice] 自定义规则'
    open_tab('prompts')
    page.locator('#st_ai_prompt_speech_reset').click()
    page.wait_for_function("(fixture.prompts['st-ai-image-voice'] || '').includes('什么时候加')")
    page.locator('#st_ai_prompt_speech_auto_inject').uncheck()
    page.wait_for_function("fixture.prompts['st-ai-image-voice'] === ''")
    page.locator('#st_ai_prompt_image_auto_inject').uncheck()
    page.wait_for_function("fixture.prompts['st-ai-image'] === ''")
    page.locator('#st_ai_prompt_image_auto_inject').check()
    page.wait_for_function("(fixture.prompts['st-ai-image'] || '').includes('[image]')")
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
    checks.append('Prompts tab edits image/voice/video prompts (inject, custom text, reset) without clobbering by the voice tab; disabling voice leaves new tags as text while generated players still render')

    # ---------- image protocols (unchanged image UI) ----------
    open_tab('settings')
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
    open_tab('settings')
    page.locator('#st_gpt_image_provider').select_option('gemini')
    page.locator('#st_gpt_image_model').fill('gemini-image-x')
    page.wait_for_timeout(700)
    page.locator('.st_ai_tab[data-tab="generate"]').click()
    page.locator('#st_gpt_image_generate_btn').click()
    expect(page.locator('#st_gpt_gen_result img.st_gpt_gen_img')).to_have_count(1, timeout=10000)
    call = posts(':generateContent')[-1]
    assert call['path'] == '/mock/v1beta/models/gemini-image-x:generateContent' and call['goog'] == 'fixture-image-key' and call['auth'] is None
    open_tab('settings')
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

    # ---------- mobile ----------
    for width in [390, 320]:
        page.set_viewport_size({'width': width, 'height': 844})
        mes(1).scroll_into_view_if_needed()
        box = mes(1).locator('video').bounding_box()
        assert box['x'] >= 0 and box['x'] + box['width'] <= width, box
        open_tab('video')
        assert page.locator('#st_ai_video_panel').evaluate('(n) => n.scrollWidth <= n.clientWidth + 1')
        page.screenshot(path=str(output / f'mobile-{width}.png'))
        open_tab('prompts')
        assert page.locator('#st_ai_prompts_panel').evaluate('(n) => n.scrollWidth <= n.clientWidth + 1')
        bar = page.locator('.st_ai_float_tabs').bounding_box()
        for tab in page.locator('.st_ai_tab').all():
            tb = tab.bounding_box()
            assert tb['x'] >= bar['x'] - 1 and tb['x'] + tb['width'] <= bar['x'] + bar['width'] + 1, (tab.text_content(), tb, bar)
        page.screenshot(path=str(output / f'mobile-{width}-prompts.png'))
        close_panel()
    checks.append('390px / 320px: embedded video, settings and prompts tabs (all six tab buttons) fit without horizontal overflow')

    page.wait_for_timeout(500)
    assert page.evaluate('mediaStats.timers.size') == 0
    assert not errors, errors
    result = {'status': 'passed', 'checks': checks, 'mock_requests': len(LOG), 'uploads': len(UPLOADS), 'page_errors': errors,
              'browser': browser.version, 'real_webm_playback': playback, 'real_provider_verified': False,
              'real_sillytavern_verified': False}
    (output / 'inline-media-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
