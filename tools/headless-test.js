// Headless gameplay test for Cosmo Cube (Node only, no browser needed).
//   node tools/headless-test.js
// Loads game.js with a stubbed DOM/canvas (every draw call is a no-op, but all render code still
// runs), simulates key presses with the fixed-timestep hooks and checks the core behaviour.
// localStorage is deliberately blocked to prove the game survives that.
'use strict';
const path = require('path');

// ---- DOM / canvas stubs ------------------------------------------------------
function makeCtx() {
  const grad = { addColorStop() {} };
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad;
      if (prop === 'createPattern') return () => ({});
      if (prop === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}
const makeCanvasStub = () => ({ width: 0, height: 0, style: {}, getContext: () => makeCtx() });
const listeners = {};
global.window = {
  __COSMO_NO_BOOT__: true,
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 1,
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  get localStorage() { throw new Error('SecurityError: storage blocked (simulated)'); },
};
global.document = { createElement: () => makeCanvasStub(), addEventListener() {}, hidden: false };
global.performance = { now: () => 0 };
global.requestAnimationFrame = () => {};

const consoleErrors = [];
const origError = console.error;
console.error = (...a) => { consoleErrors.push(a.join(' ')); origError(...a); };

const { Game, attachTestHooks, TILE, LEVELS } = require(path.join(__dirname, '..', 'game.js'));

// ---- tiny test runner --------------------------------------------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failures.push(name + ': ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    console.log('  FAIL ' + name + ' — ' + (e && e.message));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const game = new Game(makeCanvasStub());
game.resize();
const h = attachTestHooks(game);
let maxParticles = 0;
/** Steps the simulation and renders every few steps (exercises draw code). */
function run(n, every) {
  for (let i = 0; i < n; i++) {
    h.step(1);
    maxParticles = Math.max(maxParticles, game.particles.list.length);
    if (i % (every || 4) === 0) game.render(STEP_DT);
  }
}
const STEP_DT = 1 / 60;
const releaseAll = () => game.input.releaseAll();

console.log('Cosmo Cube headless test');

test('title screen renders and ENTER starts level 1 (intro → play)', () => {
  assert(game.state === 'title', 'expected title, got ' + game.state);
  run(10);
  h.tap('Enter');
  run(1);
  assert(game.state === 'intro', 'expected intro, got ' + game.state);
  run(150);
  assert(game.state === 'play', 'expected play, got ' + game.state);
  assert(game.levelIndex === 0, 'level 0 expected');
});

test('player runs right with D and left with A', () => {
  const x0 = game.player.x;
  h.press('KeyD');
  run(60);
  h.release('KeyD');
  assert(game.player.x - x0 > 150, 'moved only ' + (game.player.x - x0));
  const x1 = game.player.x;
  run(20);
  h.press('KeyA');
  run(30);
  h.release('KeyA');
  assert(game.player.x < x1, 'did not move left');
  assert(game.player.facing === -1, 'facing should be -1');
  run(30);
});

test('jump: SPACE lifts off and lands again; holding jumps higher than tapping', () => {
  h.teleport(6, 20);
  run(10);
  assert(game.player.onGround, 'should start on ground');
  const y0 = game.player.y;
  // tap
  h.press('Space');
  run(2);
  h.release('Space');
  let minTap = game.player.y;
  for (let i = 0; i < 60; i++) { run(1); minTap = Math.min(minTap, game.player.y); }
  assert(game.player.onGround, 'should land after tap jump');
  // hold
  h.press('Space');
  let minHold = game.player.y;
  for (let i = 0; i < 60; i++) { run(1); minHold = Math.min(minHold, game.player.y); }
  h.release('Space');
  run(40);
  const tapH = y0 - minTap;
  const holdH = y0 - minHold;
  assert(tapH > 20, 'tap jump too low: ' + tapH);
  assert(holdH > tapH + 40, `hold (${holdH.toFixed(0)}) should be clearly higher than tap (${tapH.toFixed(0)})`);
  assert(holdH > 100 && holdH < 135, 'full jump height out of range: ' + holdH.toFixed(1));
});

test('jump buffering: SPACE pressed just before landing still jumps', () => {
  h.teleport(6, 17);   // drop from 3 tiles up
  let jumped = false;
  for (let i = 0; i < 80; i++) {
    const p = game.player;
    if (!p.onGround && p.vy > 0 && p.y + p.h > 20 * TILE - 14 && !jumped) { h.press('Space'); jumped = true; }
    run(1);
    if (jumped && p.vy < -300) break;
  }
  h.release('Space');
  assert(game.player.vy < 0 || !game.player.onGround, 'buffered jump did not trigger');
  run(60);
});

test('duck: S makes the cube flat and it stands up again', () => {
  h.teleport(6, 20);
  run(5);
  h.press('KeyS');
  run(5);
  assert(game.player.ducking && game.player.h < 20, 'not ducking');
  h.release('KeyS');
  run(5);
  assert(!game.player.ducking && game.player.h === 26, 'did not stand up');
});

test('enemies update (walker patrols)', () => {
  h.teleport(14, 20);
  const w = game.enemies.find((e) => e.type === 'walker');
  const x0 = w.x;
  run(60);
  assert(Math.abs(w.x - x0) > 20, 'walker did not move');
});

test('falling into a chasm → dust effect → respawn at start', () => {
  const deaths = game.stats.deaths;
  h.teleport(41, 18);    // above the gap at 40–43
  let sawDust = 0;
  for (let i = 0; i < 90; i++) { run(1); sawDust = Math.max(sawDust, game.particles.list.length); if (game.player.dead) break; }
  assert(game.player.dead, 'player should be dead after falling');
  run(2);
  sawDust = Math.max(sawDust, game.particles.list.length);
  assert(sawDust >= 200, 'expected hundreds of dust particles, got ' + sawDust);
  run(120);
  assert(!game.player.dead, 'player should have respawned');
  assert(game.stats.deaths === deaths + 1, 'death counter');
  assert(Math.abs(game.player.cx - game.level.start.x) < 4, 'respawn not at start');
});

test('touching a walker kills the player', () => {
  h.teleport(14, 20);
  const w = game.enemies.find((e) => e.type === 'walker' && !e.dead);
  game.player.x = w.x;
  game.player.y = w.y + w.h - game.player.h;
  game.player.vy = 0;
  run(2);
  assert(game.player.dead, 'player should die on contact');
  run(120);
  assert(!game.player.dead, 'respawn');
});

test('stomping from above kills a walker', () => {
  h.teleport(14, 20);
  run(2);
  const w = game.enemies.find((e) => e.type === 'walker' && !e.dead);
  const n = game.enemies.length;
  game.player.x = w.x;
  game.player.y = w.y - game.player.h - 30;
  game.player.vy = 300;
  for (let i = 0; i < 20 && game.enemies.length === n; i++) run(1);
  assert(game.enemies.length === n - 1, 'walker not stomped');
  assert(!game.player.dead, 'player died while stomping');
  run(60);
});

test('W shoots a bullet that kills a monster', () => {
  game.respawn();
  h.teleport(52, 20);
  run(2);
  const n = game.enemies.length;
  game.player.facing = 1;
  h.press('KeyW');
  run(3);
  assert(game.bullets.length > 0, 'no bullet');
  for (let i = 0; i < 90 && game.enemies.length === n; i++) run(1);
  h.release('KeyW');
  assert(game.enemies.length < n, 'bullet did not kill the walker ahead');
  run(30);
});

test('shooter fires fireballs, ducking dodges a low fireball', () => {
  game.respawn();
  h.teleport(106, 20);
  run(5);
  h.press('KeyS');
  let saw = false;
  for (let i = 0; i < 400; i++) {
    run(1);
    if (game.fireballs.length) saw = true;
    game.player.x = 106 * TILE;   // stay put while ducking
  }
  h.release('KeyS');
  assert(saw, 'shooter never fired');
  assert(!game.player.dead, 'ducking cube was hit by a fireball');
  run(10);
});

test('standing in front of a shooter gets you hit', () => {
  game.respawn();
  h.teleport(106, 20);
  let died = false;
  for (let i = 0; i < 500 && !died; i++) { run(1); game.player.x = 106 * TILE; died = game.player.dead; }
  assert(died, 'standing cube survived the fireballs');
  run(120);
});

test('items: boots give a higher jump, shield protects against monsters', () => {
  game.respawn();
  h.teleport(70, 20);
  run(30);
  assert(game.player.superT > 0, 'boots not picked up');
  const y0 = game.player.y;
  h.press('Space');
  let minY = y0;
  for (let i = 0; i < 70; i++) { run(1); minY = Math.min(minY, game.player.y); }
  h.release('Space');
  assert(y0 - minY > 200, 'super jump too low: ' + (y0 - minY));
  run(60);
  // shield
  h.teleport(186, 20);
  run(30);
  assert(game.player.shieldT > 0, 'shield not picked up');
  const target = game.enemies.find((e) => e.type === 'walker' && !e.dead && e.x > 186 * TILE) || game.enemies.find((e) => !e.dead && e.type !== 'flyer');
  const n = game.enemies.length;
  game.player.x = target.x;
  game.player.y = target.y + target.h - game.player.h;
  run(2);
  assert(!game.player.dead, 'shielded player died');
  assert(game.enemies.length === n - 1, 'enemy should die when touching the shield');
  run(320);
  assert(game.player.shieldT === 0, 'shield should expire after 5 s');
});

test('checkpoint activates and becomes the respawn point', () => {
  h.loadLevel(0);
  h.teleport(97, 20);
  h.press('KeyD');
  run(30);
  h.release('KeyD');
  assert(game.level.checkpoints[0].active, 'checkpoint not activated');
  game.killPlayer('test');
  run(120);
  assert(Math.abs(game.player.cx - game.level.checkpoints[0].x) < 4, 'respawn not at checkpoint');
});

test('secret room: hidden portal → room → star → exit', () => {
  const s = game.level.secret;
  game.player.reset(s.entry.x, s.entry.y + 13);
  run(2);
  assert(game.inRoom, 'did not enter secret room');
  game.player.reset(s.star.x, s.star.y + 13);
  run(2);
  assert(s.star.taken, 'star not collected');
  game.player.reset(s.exit.x, s.exit.y + 13);
  run(2);
  assert(!game.inRoom, 'did not leave the room');
  run(30);
});

test('riding moving platforms (horizontal L1, vertical L2) never falls through', () => {
  for (const [li, idx] of [[0, 0], [1, 0], [1, 1]]) {
    h.loadLevel(li);
    game.invincible = true;
    const movers = game.level.plats.filter((p) => p.kind === 'mover');
    const m = movers[idx];
    run(1);
    game.player.reset(m.x + m.w / 2, m.y);
    let minDy = Infinity;
    let maxDy = -Infinity;
    for (let i = 0; i < 60 * 8; i++) {
      run(1);
      const dy = game.player.y + game.player.h - m.y;
      minDy = Math.min(minDy, dy);
      maxDy = Math.max(maxDy, dy);
      // keep standing still in the middle of the platform
    }
    game.invincible = false;
    assert(Math.abs(maxDy) < 3 && Math.abs(minDy) < 3, `L${li + 1} mover ${idx}: feet drifted from platform top (${minDy.toFixed(1)}..${maxDy.toFixed(1)})`);
  }
  h.loadLevel(0);
});

test('combo builds a multiplier', () => {
  game.respawn();
  game.combo = 0;
  game.comboT = 0;
  for (let i = 0; i < 3; i++) game.collectCoin({ x: 0, y: 0, taken: false });
  assert(game.combo === 3, 'combo should be 3, is ' + game.combo);
  run(130);
  assert(game.combo === 0, 'combo should reset after the window');
});

test('goal → victory animation → level complete → warp → level 2', () => {
  const g = game.level.goal;
  game.player.reset(g.x - 60, 20 * TILE);
  h.press('KeyD');
  for (let i = 0; i < 60 && game.state === 'play'; i++) run(1);
  h.release('KeyD');
  assert(game.state === 'victory', 'expected victory, got ' + game.state);
  run(200);
  assert(game.state === 'complete', 'expected complete, got ' + game.state);
  h.tap('Enter');
  run(2);
  h.tap('Enter');
  run(2);
  assert(game.state === 'warp', 'expected warp, got ' + game.state);
  run(100);
  assert(game.state === 'intro' && game.levelIndex === 1, 'expected level 2 intro');
  run(150);
});

for (let li = 0; li < LEVELS.length; li++) {
  test(`level ${li + 1} loads and survives a 60 s bot run without exceptions`, () => {
    h.loadLevel(li);
    let jumpT = 0;
    h.press('KeyD');
    for (let i = 0; i < 3600; i++) {
      jumpT++;
      if (jumpT % 45 === 0) h.press('Space');
      if (jumpT % 45 === 20) h.release('Space');
      if (jumpT % 30 === 0) h.tap('KeyW');
      run(1, 3);
    }
    releaseAll();
    assert(game.particles.list.length <= 1500, 'particle cap exceeded');
  });
}

test('boss (level 3) can be beaten with W-bullets from the arena platforms', () => {
  h.loadLevel(2);
  game.invincible = true;
  const plat = game.level.plats.find((p) => p.x === 369 * TILE);
  game.player.reset(plat.x + plat.w / 2, plat.y);
  // walk into the arena trigger first
  run(5);
  assert(game.boss.state !== 'waiting' || game.player.x > game.boss.x0, 'boss trigger');
  let t = 0;
  h.press('KeyW');
  while (!game.boss.dead && t < 60 * 120) {
    // stand on the centre platform, always face the boss
    game.player.facing = game.boss.cx > game.player.cx ? 1 : -1;
    if (game.player.y > plat.y) game.player.reset(plat.x + plat.w / 2, plat.y);
    run(1, 6);
    t++;
  }
  h.release('KeyW');
  game.invincible = false;
  assert(game.boss.dead, `boss not defeated after ${(t / 60).toFixed(0)} s, hp=${game.boss.hp}`);
  assert(!game.level.goal.locked, 'goal should unlock');
  console.log(`       (boss defeated after ${(t / 60).toFixed(1)} s of simulated fire)`);
  const g = game.level.goal;
  game.player.reset(g.x - 40, 20 * TILE);
  h.press('KeyD');
  for (let i = 0; i < 60 && game.state === 'play'; i++) run(1);
  h.release('KeyD');
  run(200);
  assert(game.state === 'complete', 'expected complete');
  h.tap('Enter'); run(2); h.tap('Enter'); run(100);
  assert(game.state === 'final', 'expected final celebration, got ' + game.state);
  run(120);
  h.tap('Enter');
  run(2);
  assert(game.state === 'levelselect', 'expected level select after the final screen');
});

test('menus: pause, settings, CRT + mute toggles, level select render', () => {
  h.loadLevel(0);
  h.tap('KeyP'); run(1);
  assert(game.state === 'pause', 'pause');
  h.tap('KeyS'); run(1);
  h.tap('Enter'); run(1);
  assert(game.state === 'settings', 'settings from pause');
  h.tap('KeyD'); run(1);   // volume up
  h.tap('KeyS'); run(1); h.tap('Enter'); run(1);   // mute toggle
  assert(game.settings.muted === true, 'mute toggle');
  h.tap('KeyM'); run(1);
  assert(game.settings.muted === false, 'M key toggles mute');
  const crt = game.settings.crt;
  h.tap('KeyC'); run(2);
  assert(game.settings.crt !== crt, 'C toggles CRT');
  h.tap('Escape'); run(1);
  assert(game.state === 'pause', 'back to pause');
  h.tap('Escape'); run(1);
  assert(game.state === 'play', 'resume');
  game.setState('levelselect'); run(5);
  game.setState('title'); run(5);
});

test('easter egg: typing STAR on the title gives the cube a new skin + hat', () => {
  game.setState('title');
  const before = game.player.skin;
  for (const ch of 'STAR') { game.input.typed.push(ch); run(1); }
  assert(game.player.skin !== before && game.player.skin.hat, 'skin did not change');
});

test('particle cap respected and no console errors', () => {
  assert(maxParticles <= 1500, 'max particles ' + maxParticles);
  assert(consoleErrors.length === 0, 'console errors: ' + consoleErrors.join(' / '));
});

console.log(`\n${passed} passed, ${failures.length} failed (max particles seen: ${maxParticles})`);
if (failures.length) {
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
