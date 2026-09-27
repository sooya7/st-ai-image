"""Self-hosted backends through a REAL SillyTavern backend (/api/sd/comfy/generate, /api/sd/generate).

Starts a fake ComfyUI and a fake A1111 WebUI on loopback, an isolated SillyTavern instance
(temp dataRoot), installs the working tree as a user extension, and calls our own
src/media/selfhosted.js from the real ST page. Nothing touches the user's data.
"""
import base64, json, shutil, subprocess, sys, tempfile, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ST = Path(r'D:\SillyTavern\SillyTavern')
EXT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
WEBM = b'\x1a\x45\xdf\xa3' + b'fake-webm-body' * 10
SEEN = {'comfy': [], 'sd': []}


class Comfy(BaseHTTPRequestHandler):
    jobs = {}

    def log_message(self, *a): pass

    def send(self, code, body, ctype='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/prompt':
            SEEN['comfy'].append(body)
            wf = body['prompt']
            video = any('Video' in n['class_type'] for n in wf.values())
            pid = f'p{len(SEEN["comfy"])}'
            out = {'gifs': [{'filename': 'clip.webm', 'subfolder': '', 'type': 'output', 'format': 'video/webm'}]} if video else {'images': [{'filename': 'img.png', 'subfolder': 'st', 'type': 'output'}]}
            Comfy.jobs[pid] = {'at': time.time(), 'outputs': {'9': out}}
            return self.send(200, {'prompt_id': pid, 'number': 1, 'node_errors': {}})
        if self.path == '/interrupt':
            return self.send(200, {})
        if self.path == '/sdapi/v1/txt2img':
            SEEN['sd'].append({'body': body, 'auth': self.headers.get('Authorization')})
            return self.send(200, {'images': [base64.b64encode(PNG).decode()], 'parameters': {}, 'info': '{}'})
        self.send(404, {})

    def do_GET(self):
        if self.path.startswith('/history'):
            hist = {pid: {'status': {'status_str': 'success', 'completed': True}, 'outputs': j['outputs']} for pid, j in Comfy.jobs.items() if time.time() - j['at'] > 1.5}
            return self.send(200, hist)
        if self.path.startswith('/view'):
            return self.send(200, WEBM if 'webm' in self.path else PNG, 'video/webm' if 'webm' in self.path else 'image/png')
        if self.path == '/sdapi/v1/options':
            return self.send(200, {'sd_model_checkpoint': 'x'})
        if self.path == '/system_stats':
            return self.send(200, {'system': {}})
        self.send(404, {})


def main():
    comfy = ThreadingHTTPServer(('127.0.0.1', 8199), Comfy)
    threading.Thread(target=comfy.serve_forever, daemon=True).start()
    tmp = Path(tempfile.mkdtemp(prefix='st-selfhosted-'))
    ext_dir = tmp / 'data' / 'default-user' / 'extensions' / 'st-ai-image'
    shutil.copytree(EXT, ext_dir, ignore=shutil.ignore_patterns('.git', 'test-output', 'tests', 'node_modules'))
    log = open(tmp / 'st.log', 'w', encoding='utf-8')
    st = subprocess.Popen(['node', 'server.js', '--dataRoot', str(tmp / 'data'), '--port', '8124', '--listen', 'false', '--browserLaunchEnabled', 'false'], cwd=ST, stdout=log, stderr=subprocess.STDOUT)
    results = []
    try:
        for _ in range(120):
            try:
                if urllib.request.urlopen('http://127.0.0.1:8124/', timeout=2).status == 200: break
            except Exception: time.sleep(1)
        with sync_playwright() as p:
            b = p.chromium.launch(channel='msedge', headless=True)
            page = b.new_page()
            page.goto('http://127.0.0.1:8124/')
            page.wait_for_function('window.SillyTavern?.getContext', timeout=120000)
            out = page.evaluate("""async () => {
                const m = await import('/scripts/extensions/third-party/st-ai-image/src/media/selfhosted.js');
                const headers = SillyTavern.getContext().getRequestHeaders;
                const wf = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %提示词%' } }, '3': { class_type: 'KSampler', inputs: { seed: '%seed%' } }, '9': { class_type: 'SaveImage', inputs: {} } });
                const vwf = JSON.stringify({ '1': { class_type: 'WanTextEncode', inputs: { text: '%prompt%', frames: '%frames%' } }, '9': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: '%fps%' } } });
                const res = {};
                const run = async (name, kind, cfg, prompt, via = true) => {
                    try {
                        const r = await m.runSelfHosted(m.buildSelfHostedPlan(kind, cfg, prompt), { viaTavern: via, tavernHeaders: () => headers() });
                        res[name] = r.url ? { ok: true, url: r.url.slice(0, 30) } : { ok: true, type: r.blob.type, size: r.blob.size };
                    } catch (e) { res[name] = { ok: false, error: String(e.message || e).slice(0, 300) }; }
                };
                await run('comfy_image_via_st', 'image', { provider: 'comfyui', base: 'http://127.0.0.1:8199', workflow: wf, size: '512x512' }, '橘猫');
                await run('comfy_video_via_st', 'video', { provider: 'comfyui', base: 'http://127.0.0.1:8199', workflow: vwf, seconds: '5' }, '海边日落');
                await run('sd_image_via_st', 'image', { provider: 'sdwebui', base: 'http://127.0.0.1:8199', auth: 'user:pass', size: '512x768', negative: 'blurry' }, 'webui dog');
                return res;
            }""")
            b.close()
        results = out
    finally:
        st.terminate()
        try: st.wait(10)
        except Exception: st.kill()
        comfy.shutdown()
        log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    report = {
        'results': results,
        'comfy_prompts_seen': [{'text': [n['inputs'].get('text') for n in c['prompt'].values() if 'text' in n['inputs']], 'frames': [n['inputs'].get('frames') for n in c['prompt'].values() if 'frames' in n['inputs']], 'client_id': c.get('client_id', '')[:12]} for c in SEEN['comfy']],
        'sd_seen': [{'prompt': s['body'].get('prompt'), 'negative': s['body'].get('negative_prompt'), 'size': [s['body'].get('width'), s['body'].get('height')], 'auth': s['auth'], 'leaked_url_field': 'url' in s['body']} for s in SEEN['sd']],
    }
    print(json.dumps(report, ensure_ascii=True, indent=1))
    ok = all(r.get('ok') for r in results.values()) and len(results) == 3
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
