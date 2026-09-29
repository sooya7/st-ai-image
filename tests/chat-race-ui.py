"""Actual entry point, image preloading boundary and chat/swipe switches; local fake image API."""
import argparse
import functools
import importlib.util
import json
from pathlib import Path
import threading
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('inline_fixture', ROOT / 'tests/inline-media-ui.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(fixture.Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    checks, errors = [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for scenario in ['chat', 'same-name-character', 'swipe']:
                page = browser.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.add_init_script('''(() => {
                    const NativeImage = window.Image;
                    window.Image = class extends NativeImage {
                        set src(value) {
                            if (String(value).includes('/user/images/')) window.__blockedPreload = this;
                            else super.src = value;
                        }
                        get src() { return super.src; }
                    };
                })();''')
                page.goto(origin + '/tests/st-fixture.html')
                page.wait_for_function("document.querySelector('.mes[mesid=\"6\"] .st_gpt_inline_gen') && document.querySelector('#st_ai_image_wand_button')")
                page.evaluate('''async origin => {
                    const { getSettings, saveSettings } = await import('../src/settings.js');
                    await saveSettings({ ...(await getSettings()), apiBase: origin + '/mock', apiKey: 'fixture-key', imageProvider: 'openai' });
                    const { getTaskKey } = await import('../src/inline/tasks.js');
                    window.__taskKey = getTaskKey(6, document.querySelector('.mes[mesid="6"] .st_gpt_inline_gen').dataset.originalTag);
                }''', origin)
                page.locator('.mes[mesid="6"] .st_gpt_inline_gen').click()
                page.wait_for_function('window.__blockedPreload')
                page.evaluate('''scenario => {
                    window.__originalMessage = fixture.state.chat[6];
                    const ctx = SillyTavern.getContext();
                    if (scenario === 'swipe') {
                        ctx.chat[6].swipes = [ctx.chat[6].mes, '[image]another swipe[/image]'];
                        ctx.chat[6].swipe_id = 1;
                        ctx.chat[6].mes = ctx.chat[6].swipes[1];
                    } else {
                        // 真实宿主就地清空、加载同一个 chat 数组。
                        fixture.state.chat.splice(0, fixture.state.chat.length, ...structuredClone(fixture.state.chat));
                        if (scenario === 'chat') fixtureSwitchChat('chat-B');
                        else { ctx.characters.push({ avatar: 'Other.png', name: 'Other' }); ctx.characterId = 1; fixture.state.chatMetadata[fixture.state.chatId] = {}; }
                    }
                    window.__expected = fixture.state.chat[6].mes;
                    renderMessage(6);
                    window.__blockedPreload.onerror();
                }''', scenario)
                page.wait_for_function("async () => !(await import('../src/inline/tasks.js')).isPending(window.__taskKey)")
                result = page.evaluate('''() => ({ current: fixture.state.chat[6].mes, expected: window.__expected, original: window.__originalMessage.mes,
                    oldSwipe: window.__originalMessage.swipes?.[0], toasts: fixture.toasts.map(t => t.message) })''')
                assert result['current'] == result['expected'], result
                assert '[st-ai-image' not in result['current'], result
                assert result['oldSwipe'] in (None, '[image]a red square[/image]'), result
                assert any('切换' in t for t in result['toasts']), result
                checks.append({'scenario': scenario, 'result': result})
                page.close()
            browser.close()
        assert not errors, errors
        report = {'status': 'passed', 'checks': checks, 'page_errors': errors}
        (output / 'chat-race-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        server.shutdown(); server.server_close()

if __name__ == '__main__': main()
