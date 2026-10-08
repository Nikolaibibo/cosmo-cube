// Real-browser smoke test for Cosmo Cube: launches headless Chrome via the DevTools protocol,
// opens index.html from file://, sends real key events, collects every console error/warning and
// uncaught exception, and saves screenshots to tools/out/.
//   node tools/browser-test.js
// Needs Node 22+ (global WebSocket/fetch) and Chrome. Override the binary with CHROME=<path>.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const PORT = 9333 + Math.floor(Math.random() * 500);
const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) { console.log('Chrome not found — set CHROME=<path>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-cube-chrome-'));
// GAME_URL=https://… tests a deployed copy instead of the local file
const pageUrl = process.env.GAME_URL || pathToFileURL(path.join(ROOT, 'index.html')).href;

const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,720', '--hide-scrollbars', pageUrl,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
let ws;
let msgId = 0;
const pending = new Map();

function send(method, params) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
const KEYS = {
  Enter: { key: 'Enter', vk: 13 }, Space: { key: ' ', vk: 32 }, KeyD: { key: 'd', vk: 68 }, KeyA: { key: 'a', vk: 65 },
  KeyW: { key: 'w', vk: 87 }, KeyS: { key: 's', vk: 83 }, KeyP: { key: 'p', vk: 80 }, KeyC: { key: 'c', vk: 67 },
  KeyT: { key: 't', vk: 84 }, KeyR: { key: 'r', vk: 82 }, Escape: { key: 'Escape', vk: 27 },
};
async function key(code, type) {
  const k = KEYS[code];
  await send('Input.dispatchKeyEvent', { type, code, key: k.key, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: type === 'keyDown' && k.key.length === 1 ? k.key : undefined });
}
async function tap(code, holdMs) { await key(code, 'keyDown'); await sleep(holdMs || 60); await key(code, 'keyUp'); }
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('  screenshot ' + name + '.png');
}

async function main() {
  // wait for the DevTools endpoint
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* not ready yet */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('could not connect to Chrome');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result || m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') problems.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails).slice(0, 400));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'assert')) {
      problems.push('CONSOLE ' + m.params.type + ': ' + m.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) {
      problems.push('LOG ' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.reload', { ignoreCache: true });   // reload so load-time errors are captured
  await sleep(1500);

  const checks = [];
  const check = (name, ok, info) => { checks.push([name, ok]); console.log((ok ? '  ok   ' : '  FAIL ') + name + (info ? ' — ' + info : '')); };

  check('game booted (window.__cosmo present)', await evaluate('!!window.__cosmo'));
  await shot('01-title');
  for (const c of ['KeyS', 'KeyT', 'KeyA', 'KeyR']) await tap(c, 30);   // easter egg
  await sleep(300);
  check('easter egg skin active', await evaluate('window.__cosmo.game.player.skin.hat === true'));
  await tap('Enter');
  await sleep(500);
  check('ENTER starts the game', (await evaluate('window.__cosmo.state().state')) === 'intro');
  const audio = await evaluate('(() => { const a = window.__cosmo.game.audio; return { ok: a.ok, state: a.ctx ? a.ctx.state : null, music: a.musicOn }; })()');
  check('audio started after the ENTER key press', audio.ok === true && audio.state === 'running' && audio.music === true, JSON.stringify(audio));
  await shot('02-level1-intro');
  await sleep(2300);
  check('intro → play', (await evaluate('window.__cosmo.state().state')) === 'play');
  const x0 = await evaluate('window.__cosmo.state().x');
  await key('KeyD', 'keyDown');
  await sleep(700);
  await tap('Space', 250);
  await sleep(300);
  await key('KeyD', 'keyUp');
  const x1 = await evaluate('window.__cosmo.state().x');
  check('player runs with real key events', x1 - x0 > 100, `moved ${Math.round(x1 - x0)} px`);
  await shot('03-level1-play');
  await tap('KeyW', 400);
  await sleep(150);
  await shot('04-level1-shoot');
  // a death in the browser (dust)
  await evaluate('(() => { const g = window.__cosmo.game; g.killPlayer("test"); })()');
  await sleep(250);
  await shot('05-death-dust');
  await sleep(1700);
  check('respawn after death', (await evaluate('window.__cosmo.state().dead')) === false);
  // a real fall into the chasm at tiles 40–43: the dust must happen on screen
  await evaluate('window.__cosmo.teleport(41, 17)');
  let fallFrames = 0;
  while (!(await evaluate('window.__cosmo.state().dead')) && fallFrames < 40) { await sleep(25); fallFrames++; }
  await sleep(250);
  const fallView = await evaluate('(() => { const g = window.__cosmo.game; return { dead: g.player.dead, py: Math.round(g.player.y), camBottom: Math.round(g.camera.y + 540) }; })()');
  check('chasm fall dissolves inside the visible area', fallView.dead && fallView.py < fallView.camBottom, JSON.stringify(fallView));
  await shot('05b-fall-dust');
  await sleep(1700);
  // shield + boots look
  await evaluate('(() => { const g = window.__cosmo.game; window.__cosmo.teleport(150, 20); g.player.shieldT = 4; g.player.superT = 10; g.player.superMax = 15; })()');
  await sleep(600);
  await shot('06-powerups');
  // secret room
  await evaluate('(() => { const g = window.__cosmo.game; g.enterRoom(); })()');
  await sleep(700);
  await shot('07-secret-room');
  await evaluate('(() => { const g = window.__cosmo.game; g.leaveRoom(); })()');
  // level 2 + 3
  await evaluate('window.__cosmo.loadLevel(1); window.__cosmo.teleport(116, 20)');
  await sleep(900);
  await shot('08-level2-lowgrav');
  await evaluate('window.__cosmo.loadLevel(2); window.__cosmo.teleport(60, 19)');
  await sleep(900);
  await shot('09-level3');
  // boss
  await evaluate('window.__cosmo.teleport(360, 20)');
  await sleep(3200);
  check('boss fight started', ['intro', 'fight'].includes(await evaluate('window.__cosmo.state().boss.state')));
  await shot('10-boss');
  // goal + level complete
  await evaluate('(() => { const g = window.__cosmo.game; g.boss.hp = 1; g.boss.state = "fight"; g.boss.damage(g); })()');
  await sleep(3000);
  check('boss defeated → portal unlocked', (await evaluate('window.__cosmo.state().goalLocked')) === false);
  await shot('11-portal-open');
  await evaluate('(() => { const g = window.__cosmo.game; const go = g.level.goal; g.player.reset(go.x - 30, 20 * 32); })()');
  await key('KeyD', 'keyDown');
  await sleep(400);
  await key('KeyD', 'keyUp');
  await sleep(1200);
  await shot('12-victory');
  await sleep(2600);
  check('level complete screen', (await evaluate('window.__cosmo.state().state')) === 'complete');
  await sleep(1500);
  await shot('13-level-complete');
  await tap('Enter');
  await sleep(300);
  await tap('Enter');
  await sleep(500);
  await shot('14-warp');
  await sleep(1500);
  check('final celebration', (await evaluate('window.__cosmo.state().state')) === 'final');
  await shot('15-final');
  await tap('Enter');
  await sleep(400);
  await shot('16-level-select');
  // CRT + pause
  await evaluate('window.__cosmo.loadLevel(0)');
  await tap('KeyC');
  await sleep(300);
  await tap('KeyP');
  await sleep(300);
  await shot('17-pause-crt');
  // resize handling
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const css = await evaluate('[document.getElementById("game").style.width, document.getElementById("game").style.height]');
  check('canvas keeps 16:9 on resize', Math.abs(parseInt(css[0], 10) / parseInt(css[1], 10) - 16 / 9) < 0.02, css.join(' × '));
  await shot('18-resized');

  // progress must survive a reload when opened from file://
  const before = await evaluate('localStorage.getItem("cosmoCube.save.v1")');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  const after = await evaluate('localStorage.getItem("cosmoCube.save.v1")');
  check('save data persists across a reload (file://)', !!before && before === after, before ? 'bytes=' + before.length : 'nothing saved');

  const fps = await evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); })(); })`);
  console.log('  rAF frames in 1 s (headless, informational): ' + fps);

  console.log('\nConsole problems: ' + problems.length);
  for (const p of problems) console.log('  ' + p);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0 && problems.length === 0;
}

main()
  .then((ok) => { cleanup(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error(e); cleanup(); process.exit(1); });

function cleanup() {
  try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  try { chrome.kill(); } catch (e) { /* ignore */ }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* locked on Windows */ } }, 300);
}
