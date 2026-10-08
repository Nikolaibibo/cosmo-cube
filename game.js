/*
 * COSMO CUBE — a Giana-Sisters-style space platformer.
 * Plain HTML5 Canvas + Web Audio, no external assets. Everything is drawn and synthesised in code.
 *
 * Layout of this file (top to bottom):
 *   1. Constants + physics tuning (PHYS)
 *   2. Small helpers
 *   3. LEVELS — the three levels as plain data (tile units, easy to edit)
 *   4. Save        — localStorage wrapper (every access guarded)
 *   5. AudioEngine — procedural SFX + adaptive music
 *   6. Input       — keyboard + gamepad
 *   7. Particles   — pooled, capped particle system
 *   8. Camera
 *   9. SpaceBackground — parallax space scenery
 *  10. Level       — runtime world built from LEVELS data
 *  11. Player
 *  12. Enemies, projectiles
 *  13. Boss
 *  14. UI          — HUD and screens
 *  15. Game        — state machine + fixed-timestep loop
 *  16. Boot / Node export (the test tools load this file in Node)
 */
'use strict';

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------
const VIEW_W = 960;
const VIEW_H = 540;
const TILE = 32;
const STEP = 1 / 60;          // fixed simulation step
const MAX_FRAME = 0.25;       // clamp for huge frame gaps (tab switch)
const PARTICLE_CAP = 1500;

const PHYS = {
  gravity: 2000,
  maxFall: 820,
  runSpeed: 230,
  groundAccel: 1900,
  airAccel: 1300,
  friction: 2300,
  jumpVel: 700,             // ~122 px (3.8 tiles) full jump
  jumpCut: 0.45,            // vy multiplier when SPACE is released early
  superJumpVel: 1000,       // ~250 px (7.8 tiles)
  bounceVel: 1050,          // bounce pad, ~275 px
  stompBounce: 470,
  lowGravScale: 0.45,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  playerW: 26,
  playerH: 26,
  duckH: 14,
  duckSpeedScale: 0.4,
  bulletSpeed: 560,
  bulletLife: 0.9,
  shootCooldown: 0.28,
  fireballSpeed: 210,
  fireballRadius: 5,
  fireballHeight: 21,       // centre of a shooter fireball above the ground it is fired over
  stoneGravity: 1100,
  bootsTime: 15,
  springTime: 10,
  shieldTime: 5,
  comboWindow: 2.0,
  comboMax: 8,
};

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const dist2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
const TAU = Math.PI * 2;

/** Deterministic PRNG so scenery looks the same every time a level loads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Removes items flagged dead without mutating the array during iteration. */
function sweep(arr) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (!arr[i].dead) arr[w++] = arr[i];
  arr.length = w;
}

// ---------------------------------------------------------------------------
// 3. LEVELS (all coordinates in tiles; "row" = tile row of the surface top, y grows downward)
//
//   ground    [x, w, row]            solid from row down to the bottom of the world
//   blocks    [x, row, w, h]         solid block / wall
//   plats     [x, row, w, bonus?]    one-way platform; bonus=true → only reachable with a power-up
//   crumbles  [x, row, w]            one-way platform that breaks shortly after being stood on
//   movers    [x, row, w, dx, dy, period]   one-way platform drifting between (x,row) and (x+dx,row+dy)
//   bounces   [x, row]               bounce pad standing on the surface at row
//   lowGrav   [x, row, w, h]         low-gravity zone
//   coins     [x, row]               single coin (tile centre)
//   coinRows  [x, row, n]            n coins in a row
//   coinArcs  [x, row, w, n, h]      n coins on an arc from x to x+w, peaking h tiles above row
//   enemies   ['walker'|'shooter', x, row] | ['flyer', x, row, rangeTiles]
//   items     ['boots'|'spring'|'shield', x, row]   (exactly one of each per level)
//   checkpoints [x, row]
//   secret    { entry:[x,row], room:[x,row,w,h], spawn:[x,row], star:[x,row], exit:[x,row], returnTo:[x,row] }
//   boss      { arena:[x0,x1], row }  (level 3 only)
// ---------------------------------------------------------------------------
const WORLD_ROWS = 24;

const LEVELS = [
  {
    name: 'Nebula Fields',
    theme: 'nebula',
    width: 400,
    start: [3, 20],
    goal: [388, 20],
    ground: [
      [0, 40, 20], [43, 47, 20], [96, 30, 20], [138, 40, 20], [182, 30, 20],
      [215, 23, 19], [242, 54, 20], [299, 25, 20], [334, 30, 20], [374, 26, 20],
      // secret room floor
      [420, 32, 20],
    ],
    blocks: [
      [16, 18, 2, 2], [30, 17, 2, 3], [62, 18, 2, 2], [168, 18, 2, 2], [199, 18, 2, 2],
      [316, 18, 2, 2], [398, 4, 2, 16],
      // secret room shell
      [420, 8, 1, 12], [451, 8, 1, 12], [420, 7, 32, 1],
    ],
    plats: [
      [48, 17, 3], [53, 14, 3], [74, 14, 4, true], [85, 12, 4], [147, 14, 4, true],
      [226, 15, 3], [246, 17, 3], [251, 15, 3], [310, 17, 3],
      [428, 17, 3], [434, 15, 3], [440, 13, 3],
    ],
    crumbles: [[92, 20, 2], [326, 19, 2], [330, 19, 2]],
    movers: [[127, 18, 3, 7, 0, 5], [365, 18, 3, 5, 0, 4]],
    bounces: [[87, 20]],
    lowGrav: [],
    coins: [],
    coinRows: [
      [7, 19, 5], [16, 16, 2], [30, 15, 2], [34, 19, 4], [53, 13, 3], [74, 13, 4], [85, 11, 4],
      [80, 19, 4], [102, 19, 4], [108, 17, 3], [129, 16, 6], [147, 13, 4], [160, 19, 4],
      [188, 19, 4], [210, 19, 2], [226, 14, 3], [246, 16, 3], [251, 14, 3], [266, 19, 8],
      [310, 16, 3], [326, 18, 2], [330, 18, 2], [338, 19, 4], [366, 16, 6], [382, 19, 4],
      [424, 19, 6], [428, 16, 3], [434, 14, 3], [444, 19, 5],
    ],
    coinArcs: [[39, 19, 5, 4, 3], [177, 19, 6, 5, 3], [211, 18, 5, 4, 2], [237, 18, 6, 5, 2], [295, 18, 5, 4, 2]],
    enemies: [
      ['walker', 24, 20], ['walker', 58, 20], ['walker', 66, 20], ['shooter', 114, 20],
      ['flyer', 158, 13, 5], ['walker', 164, 20], ['walker', 173, 20],
      ['flyer', 194, 12, 4], ['shooter', 207, 20], ['walker', 222, 19], ['shooter', 233, 19],
      ['walker', 256, 20], ['walker', 263, 20], ['walker', 306, 20], ['walker', 320, 20],
      ['flyer', 344, 12, 5], ['shooter', 356, 20], ['walker', 380, 20],
    ],
    items: [['boots', 70, 18], ['spring', 142, 18], ['shield', 186, 18]],
    checkpoints: [[99, 20], [184, 20], [336, 20]],
    secret: { entry: [200, 14], room: [420, 7, 32, 14], spawn: [423, 20], star: [441, 11], exit: [448, 19], returnTo: [203, 20] },
  },
  {
    name: 'Asteroid Belt',
    theme: 'asteroid',
    width: 420,
    start: [3, 20],
    goal: [408, 20],
    ground: [
      [0, 30, 20], [34, 21, 20], [58, 16, 19], [90, 30, 20], [134, 26, 20], [164, 22, 20],
      [200, 24, 20], [228, 6, 20], [238, 30, 20], [272, 40, 20], [316, 14, 20], [333, 12, 19],
      [349, 20, 20], [383, 37, 20],
      [450, 32, 20],
    ],
    blocks: [
      [40, 18, 2, 2], [176, 18, 2, 2], [418, 4, 2, 16],
      [450, 8, 1, 12], [481, 8, 1, 12], [450, 7, 32, 1],
    ],
    plats: [
      [42, 15, 3], [100, 14, 4, true], [117, 12, 3], [123, 18, 2], [130, 17, 2], [141, 14, 4, true],
      [207, 17, 2], [246, 15, 2], [250, 12, 2], [355, 17, 3], [372, 18, 2], [377, 15, 2],
      [456, 16, 3], [463, 13, 3], [470, 10, 3],
    ],
    crumbles: [[76, 19, 2], [80, 18, 2], [84, 19, 2]],
    movers: [[187, 18, 3, 0, -4, 4], [192, 16, 3, 4, 0, 4]],
    bounces: [[119, 20]],
    lowGrav: [[121, 6, 13, 16], [243, 4, 12, 16], [370, 5, 12, 17], [451, 8, 30, 12]],
    coins: [],
    coinRows: [
      [6, 19, 5], [16, 17, 3], [36, 19, 3], [42, 14, 3], [48, 19, 4], [60, 18, 4], [66, 17, 3],
      [76, 17, 2], [80, 16, 2], [84, 17, 2], [93, 19, 3], [100, 13, 4], [104, 19, 4],
      [117, 11, 3], [124, 16, 2], [130, 15, 2], [141, 13, 4], [150, 19, 6], [168, 19, 3],
      [180, 19, 4], [192, 14, 4], [204, 19, 3], [207, 15, 2], [230, 19, 3], [246, 13, 2],
      [250, 10, 2], [258, 19, 4], [276, 19, 6], [288, 19, 6], [355, 16, 3], [372, 17, 2],
      [377, 14, 2], [386, 19, 4], [396, 19, 4],
      [454, 19, 6], [456, 15, 3], [463, 12, 3], [470, 9, 3], [474, 19, 5],
    ],
    coinArcs: [
      [29, 19, 6, 5, 3], [54, 18, 5, 4, 2], [159, 19, 6, 5, 3], [223, 19, 6, 5, 3], [233, 19, 6, 5, 3], [267, 19, 6, 5, 3],
      [311, 19, 6, 5, 3], [329, 18, 5, 4, 2], [344, 18, 6, 5, 2],
    ],
    enemies: [
      ['walker', 14, 20], ['walker', 22, 20], ['shooter', 47, 20], ['flyer', 64, 13, 5], ['walker', 70, 19],
      ['shooter', 108, 20], ['walker', 113, 20], ['flyer', 148, 12, 5], ['walker', 152, 20], ['flyer', 156, 13, 4],
      ['shooter', 172, 20], ['shooter', 182, 20], ['walker', 208, 20], ['walker', 215, 20], ['flyer', 218, 12, 4],
      ['shooter', 258, 20], ['walker', 262, 20], ['walker', 278, 20], ['walker', 286, 20], ['flyer', 292, 12, 5],
      ['walker', 322, 20], ['flyer', 326, 12, 4], ['shooter', 341, 19], ['walker', 358, 20], ['walker', 364, 20],
      ['shooter', 392, 20], ['flyer', 398, 12, 5], ['walker', 402, 20],
    ],
    items: [['boots', 96, 18], ['spring', 137, 18], ['shield', 168, 18]],
    checkpoints: [[92, 20], [202, 20], [351, 20]],
    secret: { entry: [210, 13], room: [450, 7, 32, 14], spawn: [453, 20], star: [471, 8], exit: [478, 19], returnTo: [212, 20] },
  },
  {
    name: 'Crystal Moon',
    theme: 'crystal',
    width: 392,
    start: [3, 20],
    goal: [386, 20],
    ground: [
      [0, 37, 20], [40, 18, 19], [72, 24, 20], [112, 28, 20], [143, 25, 19], [182, 30, 20],
      [216, 24, 20], [243, 22, 20], [280, 24, 19], [318, 32, 20],
      // boss arena
      [350, 42, 20],
      // secret room floor
      [410, 32, 20],
    ],
    blocks: [
      [18, 18, 2, 2], [86, 18, 2, 2], [295, 17, 2, 2], [390, 4, 2, 16],
      [410, 8, 1, 12], [441, 8, 1, 12], [410, 7, 32, 1],
    ],
    plats: [
      [47, 13, 4, true], [60, 18, 2], [64, 15, 2], [119, 14, 4, true], [135, 12, 4], [194, 17, 3],
      [247, 17, 3], [307, 17, 2], [311, 13, 2], [315, 16, 2], [336, 17, 3],
      // boss arena platforms
      [361, 16, 3], [378, 16, 3], [369, 13, 3],
      [416, 17, 3], [422, 14, 3], [428, 12, 3], [435, 15, 3],
    ],
    crumbles: [[68, 16, 2], [170, 19, 2], [174, 18, 2], [178, 19, 2], [272, 16, 2], [276, 17, 2]],
    movers: [[97, 18, 3, 5, 0, 3.5], [107, 17, 3, 0, -3, 3], [266, 18, 3, 0, -3, 3]],
    bounces: [[137, 20]],
    lowGrav: [[59, 5, 13, 17], [305, 4, 12, 18]],
    coins: [],
    coinRows: [
      [6, 19, 5], [18, 16, 2], [28, 19, 4], [42, 18, 3], [47, 12, 4], [52, 18, 3], [64, 14, 2],
      [68, 15, 2], [76, 19, 3], [86, 16, 2], [99, 16, 3], [107, 13, 3], [114, 19, 3], [119, 13, 4],
      [126, 19, 4], [135, 11, 4], [148, 18, 3], [156, 18, 4], [170, 17, 2], [174, 16, 2], [178, 17, 2],
      [188, 19, 3], [194, 16, 3], [202, 19, 4], [220, 19, 3], [229, 19, 4], [247, 16, 3],
      [272, 14, 2], [276, 15, 2], [284, 18, 4], [307, 15, 2], [311, 11, 2], [315, 14, 2],
      [320, 19, 3], [336, 16, 3],
      [414, 19, 4], [416, 16, 3], [422, 13, 3], [428, 11, 3], [435, 14, 3], [436, 19, 4],
    ],
    coinArcs: [[36, 18, 5, 4, 2], [139, 18, 5, 4, 2], [211, 19, 6, 5, 3], [239, 18, 5, 4, 2]],
    enemies: [
      ['walker', 12, 20], ['shooter', 26, 20], ['flyer', 48, 11, 5], ['walker', 54, 19],
      ['shooter', 80, 20], ['flyer', 88, 12, 4], ['shooter', 92, 20],
      ['walker', 124, 20], ['flyer', 128, 11, 5], ['walker', 132, 20],
      ['shooter', 152, 19], ['flyer', 158, 11, 4], ['shooter', 164, 19],
      ['walker', 190, 20], ['walker', 198, 20], ['walker', 206, 20],
      ['shooter', 224, 20], ['flyer', 230, 12, 5], ['shooter', 236, 20],
      ['walker', 250, 20], ['flyer', 254, 11, 5], ['walker', 258, 20], ['shooter', 290, 19],
      ['shooter', 300, 19], ['walker', 324, 20], ['flyer', 328, 11, 5], ['walker', 332, 20], ['shooter', 344, 20],
    ],
    items: [['boots', 44, 17], ['spring', 115, 18], ['shield', 146, 17]],
    checkpoints: [[74, 20], [184, 20], [282, 19], [352, 20]],
    secret: { entry: [196, 12], room: [410, 7, 32, 14], spawn: [413, 20], star: [429, 10], exit: [438, 19], returnTo: [200, 20] },
    boss: { arena: [356, 387], row: 20 },
  },
];

/** Level colour themes. */
const THEMES = {
  nebula: {
    skyTop: '#05031a', skyBottom: '#1a0b3d', neb: ['#7b2ff7', '#2f6bf7', '#c04cf0'], planet: ['#6a5cff', '#d18bff'],
    rockTop: '#2c2457', rockBottom: '#120d2b', edge: '#9d7bff', edge2: '#5ad1ff', accent: '#c9a6ff', music: 0,
  },
  asteroid: {
    skyTop: '#140405', skyBottom: '#3a1206', neb: ['#ff5a1f', '#ff2d55', '#ffb02e'], planet: ['#ff7b3a', '#ffd27a'],
    rockTop: '#4a2416', rockBottom: '#1e0c07', edge: '#ff8a3d', edge2: '#ffd23d', accent: '#ffb27a', music: 1,
  },
  crystal: {
    skyTop: '#011510', skyBottom: '#06302c', neb: ['#19f2a0', '#14c8ff', '#7affd9'], planet: ['#2bd9b0', '#9cf6ff'],
    rockTop: '#123d3b', rockBottom: '#06181a', edge: '#3dffd0', edge2: '#5ae0ff', accent: '#a6fff0', music: 2,
  },
};

// ---------------------------------------------------------------------------
// 4. Save — every storage access is wrapped, the game must run when storage is blocked (file://)
// ---------------------------------------------------------------------------
const Save = {
  KEY: 'cosmoCube.save.v1',
  data: null,

  defaults() {
    return {
      levels: LEVELS.map(() => ({ stars: 0, coins: 0, secret: false, done: false })),
      unlocked: 1,
      finished: false,
      settings: { volume: 0.7, muted: false, shake: true, crt: false, reduceFlash: false },
    };
  },

  load() {
    const d = this.defaults();
    try {
      const raw = window.localStorage.getItem(this.KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && Array.isArray(p.levels)) {
          p.levels.forEach((l, i) => { if (d.levels[i] && l) Object.assign(d.levels[i], l); });
        }
        if (p && typeof p.unlocked === 'number') d.unlocked = clamp(p.unlocked, 1, LEVELS.length);
        if (p && p.finished) d.finished = true;
        if (p && p.settings) Object.assign(d.settings, p.settings);
      }
    } catch (e) {
      // storage blocked or corrupt — keep defaults
    }
    this.data = d;
    return d;
  },

  write() {
    try {
      window.localStorage.setItem(this.KEY, JSON.stringify(this.data));
    } catch (e) {
      // storage unavailable — progress lives only for this session
    }
  },

  recordLevel(index, stars, coins, secret) {
    const l = this.data.levels[index];
    l.done = true;
    l.stars = Math.max(l.stars, stars);
    l.coins = Math.max(l.coins, coins);
    l.secret = l.secret || secret;
    this.data.unlocked = Math.max(this.data.unlocked, Math.min(LEVELS.length, index + 2));
    if (index === LEVELS.length - 1) this.data.finished = true;
    this.write();
  },
};

// ---------------------------------------------------------------------------
// 5. AudioEngine — everything synthesised. Created on the first user gesture; failures are silent.
// ---------------------------------------------------------------------------
const MUSIC_THEMES = [
  // Nebula Fields: dreamy A minor
  { bpm: 92, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]] },
  // Asteroid Belt: driving D minor
  { bpm: 112, chords: [[50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55]] },
  // Crystal Moon: shimmering E minor
  { bpm: 104, chords: [[52, 55, 59], [48, 52, 55], [55, 59, 62], [50, 54, 57]] },
];
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ok = false;
    this.volume = 0.7;
    this.muted = false;
    this.theme = 0;
    this.musicOn = false;
    this.intensity = 1;       // 0 calm (secret room) · 1 normal · 2 boss
    this.nextNoteTime = 0;
    this.stepIndex = 0;
  }

  /** Must be called from a user gesture handler. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = 0.8;
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.music.gain.value = 0.32;
      this.music.connect(this.master);
      // music layers, faded by intensity
      this.layers = {};
      for (const name of ['pad', 'bass', 'arp', 'bells', 'drums']) {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(this.music);
        this.layers[name] = g;
      }
      // shared noise buffer
      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.ok = true;
      this.applyVolume();
      this.applyIntensity(true);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (e) {
      this.ok = false;
      this.ctx = null;
    }
  }

  applyVolume() {
    if (!this.ok) return;
    const v = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setVolume(v) { this.volume = clamp(v, 0, 1); this.applyVolume(); }
  setMuted(m) { this.muted = m; this.applyVolume(); }

  /** Intensity is continuous 0..2; layers cross-fade. */
  setIntensity(v) {
    if (Math.abs(v - this.intensity) < 0.01) return;
    this.intensity = v;
    this.applyIntensity(false);
  }

  applyIntensity(immediate) {
    if (!this.ok) return;
    const i = this.intensity;
    const t = this.ctx.currentTime;
    const tc = immediate ? 0.01 : 0.8;
    const set = (name, v) => this.layers[name].gain.setTargetAtTime(v, t, tc);
    set('pad', 0.55);
    set('bass', clamp(i, 0, 1) * 0.7);
    set('arp', clamp(i, 0, 1) * 0.35 + clamp(i - 1, 0, 1) * 0.2);
    set('bells', clamp(1 - i, 0, 1) * 0.5 + 0.05);
    set('drums', clamp(i - 1, 0, 1) * 0.7 + (this.theme === 1 ? clamp(i, 0, 1) * 0.25 : 0));
  }

  startMusic(theme) {
    if (!this.ok) { this.theme = theme; return; }
    this.theme = theme;
    this.musicOn = true;
    this.stepIndex = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.1;
    this.applyIntensity(false);
  }

  stopMusic() { this.musicOn = false; }

  /** Called once per rendered frame: schedules music notes slightly ahead. */
  update() {
    if (!this.ok || !this.musicOn || this.muted) {
      if (this.ok) this.nextNoteTime = this.ctx.currentTime + 0.05;
      return;
    }
    const th = MUSIC_THEMES[this.theme] || MUSIC_THEMES[0];
    const stepDur = 60 / th.bpm / 4;
    // after a long pause (tab hidden) don't try to catch up
    if (this.nextNoteTime < this.ctx.currentTime - 0.2) this.nextNoteTime = this.ctx.currentTime + 0.05;
    while (this.nextNoteTime < this.ctx.currentTime + 0.15) {
      this.scheduleStep(th, this.stepIndex, this.nextNoteTime, stepDur);
      this.nextNoteTime += stepDur;
      this.stepIndex = (this.stepIndex + 1) % 64;
    }
  }

  scheduleStep(th, step, t, stepDur) {
    const bar = Math.floor(step / 16) % th.chords.length;
    const s = step % 16;
    const chord = th.chords[bar];
    const L = this.layers;
    if (s === 0) {
      for (const n of chord) this.voice(midiHz(n), t, stepDur * 16, 'sawtooth', 0.06, L.pad, { attack: 0.6, release: 0.8, cutoff: 900, detune: 7 });
    }
    if (s === 0 || s === 6 || s === 8 || s === 14) {
      this.voice(midiHz(chord[0] - 12), t, stepDur * 2.5, 'triangle', 0.28, L.bass, { attack: 0.01, release: 0.1 });
    }
    const arpEvery = this.intensity > 1.3 ? 1 : 2;
    if (s % arpEvery === 0) {
      const idx = (step / arpEvery) % 6;
      const note = chord[idx % 3] + (idx >= 3 ? 24 : 12);
      this.voice(midiHz(note), t, stepDur * 0.9, 'triangle', 0.12, L.arp, { attack: 0.005, release: 0.08 });
    }
    if (s % 4 === 2 && Math.random() < 0.6) {
      this.voice(midiHz(pick(chord) + 24), t, stepDur * 6, 'sine', 0.09, L.bells, { attack: 0.005, release: 1.2 });
    }
    // drums
    if (s % 4 === 0) this.kick(t, L.drums);
    if (s === 4 || s === 12) this.noiseHit(t, 0.12, 0.22, 1800, L.drums, 'bandpass');
    if (s % 2 === 1) this.noiseHit(t, 0.03, 0.08, 7000, L.drums, 'highpass');
  }

  voice(freq, t, dur, type, vol, dest, o) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (o.detune) osc.detune.setValueAtTime(rand(-o.detune, o.detune), t);
    let node = osc;
    if (o.cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.cutoff;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(dest);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + o.attack);
    g.gain.setValueAtTime(vol, t + Math.max(o.attack, dur - o.release));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  kick(t, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  noiseHit(t, dur, vol, freq, dest, type, sweepTo) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  tone(freq, dur, type, vol, slideTo, delay) {
    const ctx = this.ctx;
    const t = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** One-shot sound effects. */
  play(name) {
    if (!this.ok || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      switch (name) {
        case 'jump': this.tone(320, 0.16, 'square', 0.12, 640); break;
        case 'superjump': this.tone(300, 0.3, 'square', 0.12, 1200); this.tone(600, 0.3, 'sine', 0.08, 2000); break;
        case 'land': this.noiseHit(t, 0.06, 0.12, 600, this.sfx); break;
        case 'shoot': this.tone(1200, 0.14, 'sawtooth', 0.07, 300); this.tone(1800, 0.08, 'sine', 0.06, 900); break;
        case 'coin': this.tone(988, 0.08, 'square', 0.08); this.tone(1319, 0.22, 'square', 0.08, null, 0.07); break;
        case 'power':
          [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.14, null, i * 0.06));
          break;
        case 'star':
          [784, 988, 1175, 1568, 1976, 2349].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.14, null, i * 0.07));
          break;
        case 'stomp': this.tone(500, 0.12, 'square', 0.12, 120); this.noiseHit(t, 0.1, 0.15, 900, this.sfx); break;
        case 'kill': this.noiseHit(t, 0.3, 0.3, 2000, this.sfx, 'lowpass', 200); this.tone(400, 0.2, 'square', 0.08, 80); break;
        case 'death':
          this.tone(660, 0.9, 'sine', 0.16, 110);
          this.noiseHit(t, 1.2, 0.12, 4000, this.sfx, 'bandpass', 300);
          break;
        case 'fireball': this.noiseHit(t, 0.25, 0.1, 500, this.sfx, 'lowpass', 2000); break;
        case 'stone': this.tone(200, 0.2, 'triangle', 0.08, 90); break;
        case 'bounce': this.tone(200, 0.3, 'sine', 0.2, 900); break;
        case 'checkpoint': [440, 554, 659, 880].forEach((f, i) => this.tone(f, 0.25, 'sine', 0.12, null, i * 0.08)); break;
        case 'crumble': this.noiseHit(t, 0.4, 0.15, 400, this.sfx, 'lowpass', 100); break;
        case 'portal': this.tone(200, 0.8, 'sine', 0.15, 1600); this.noiseHit(t, 0.8, 0.08, 3000, this.sfx, 'bandpass', 600); break;
        case 'bosshit': this.tone(160, 0.25, 'square', 0.16, 60); this.noiseHit(t, 0.2, 0.2, 1500, this.sfx); break;
        case 'explode': this.noiseHit(t, 1.4, 0.5, 3000, this.sfx, 'lowpass', 60); this.tone(120, 1.2, 'sine', 0.3, 30); break;
        case 'victory':
          [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.15, null, i * 0.11));
          break;
        case 'select': this.tone(660, 0.06, 'square', 0.07); break;
        case 'confirm': this.tone(660, 0.07, 'square', 0.08); this.tone(990, 0.12, 'square', 0.08, null, 0.06); break;
        case 'secret': [392, 523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, 'sine', 0.12, null, i * 0.1)); break;
        case 'yawn': this.tone(300, 0.6, 'sine', 0.06, 180); break;
        case 'warn': this.tone(880, 0.1, 'square', 0.05); break;
        case 'egg': [523, 784, 1047, 1568].forEach((f, i) => this.tone(f, 0.15, 'square', 0.08, null, i * 0.05)); break;
        default: break;
      }
    } catch (e) {
      // never let audio break the game
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Input — keyboard via event.code (layout independent), plus optional gamepad
// ---------------------------------------------------------------------------
const PREVENT_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.typed = [];
    this.gpDown = new Set();
    this.onGesture = null;
  }

  attach(win) {
    win.addEventListener('keydown', (e) => {
      const code = e.code || e.key;
      if (PREVENT_KEYS.has(code)) e.preventDefault();
      if (!e.repeat) {
        this.pressed.add(code);
        if (e.key && e.key.length === 1) this.typed.push(e.key.toUpperCase());
      }
      this.down.add(code);
      if (this.onGesture) this.onGesture();
    });
    win.addEventListener('keyup', (e) => {
      const code = e.code || e.key;
      if (PREVENT_KEYS.has(code)) e.preventDefault();
      this.down.delete(code);
    });
    win.addEventListener('blur', () => this.releaseAll());
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    }
  }

  releaseAll() {
    this.down.clear();
    this.gpDown.clear();
  }

  isDown(...codes) {
    for (const c of codes) if (this.down.has(c) || this.gpDown.has(c)) return true;
    return false;
  }

  wasPressed(...codes) {
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  /** Clears edge-triggered state after a simulation step consumed it. */
  endStep() {
    this.pressed.clear();
    this.typed.length = 0;
  }

  /** Maps gamepad 0 onto the same key codes. Called once per frame. */
  pollGamepad() {
    let pads = null;
    try {
      pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    } catch (e) {
      pads = null;
    }
    const gp = pads && Array.from(pads).find((p) => p && p.connected);
    if (!gp) {
      this.gpDown.clear();
      return;
    }
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    const now = new Set();
    if (ax > 0.4 || b(15)) now.add('KeyD');
    if (ax < -0.4 || b(14)) now.add('KeyA');
    if (ay > 0.5 || b(13)) now.add('KeyS');
    if (ay < -0.5 || b(12)) now.add('ArrowUp');
    if (b(0)) now.add('Space');
    if (b(2) || b(1)) now.add('KeyW');
    if (b(9)) now.add('Escape');
    if (b(0) || b(9)) now.add('Enter');
    if (now.has('KeyS')) now.add('ArrowDown');
    for (const c of now) if (!this.gpDown.has(c)) this.pressed.add(c);
    this.gpDown = now;
    // no onGesture here: a gamepad poll is not a user activation, creating audio would warn
  }
}

// ---------------------------------------------------------------------------
// 7. Particles — capped pool, additive glow
// ---------------------------------------------------------------------------
const glowCache = new Map();

/** Cached radial glow sprite (avoids per-frame shadowBlur). */
function glowSprite(color, radius) {
  const r = Math.max(2, Math.round(radius));
  const key = color + '|' + r;
  let c = glowCache.get(key);
  if (c) return c;
  c = makeCanvas(r * 2, r * 2);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(0.35, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalAlpha = 1;
  g.fillStyle = grad;
  g.fillRect(0, 0, r * 2, r * 2);
  glowCache.set(key, c);
  return c;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

class Particles {
  constructor(cap) {
    this.list = [];
    this.cap = cap;
  }

  clear() { this.list.length = 0; }

  add(p) {
    if (this.list.length >= this.cap) return null;
    p.max = p.life;
    if (p.g === undefined) p.g = 0;
    if (p.drag === undefined) p.drag = 0;
    if (p.rot === undefined) p.rot = 0;
    if (p.vr === undefined) p.vr = 0;
    this.list.push(p);
    return p;
  }

  /** Radial burst. */
  burst(x, y, n, o) {
    for (let i = 0; i < n; i++) {
      const a = o.angle !== undefined ? o.angle + rand(-o.spread, o.spread) : rand(0, TAU);
      const sp = rand(o.speed[0], o.speed[1]);
      this.add({
        x: x + rand(-(o.jitter || 0), o.jitter || 0),
        y: y + rand(-(o.jitter || 0), o.jitter || 0),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(o.life[0], o.life[1]),
        size: rand(o.size[0], o.size[1]),
        color: Array.isArray(o.color) ? pick(o.color) : o.color,
        g: o.g || 0, drag: o.drag || 0, glow: o.glow !== false, shape: o.shape || 'square',
        vr: rand(-6, 6),
      });
    }
  }

  update(dt) {
    const L = this.list;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.life -= dt;
      if (p.life <= 0) { p.dead = true; continue; }
      if (p.drag) { const d = Math.max(0, 1 - p.drag * dt); p.vx *= d; p.vy *= d; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    sweep(L);
  }

  draw(ctx, camX, camY) {
    const L = this.list;
    if (!L.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      const x = p.x - camX;
      const y = p.y - camY;
      if (x < -40 || x > VIEW_W + 40 || y < -40 || y > VIEW_H + 40) continue;
      const a = clamp(p.life / p.max, 0, 1);
      ctx.globalAlpha = a;
      const s = p.size * (0.4 + 0.6 * a);
      if (p.glow && s > 2) {
        const spr = glowSprite(p.color, 8);
        ctx.drawImage(spr, x - s * 1.6, y - s * 1.6, s * 3.2, s * 3.2);
      }
      ctx.fillStyle = p.color;
      if (p.shape === 'square' && p.rot) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rot);
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
      } else {
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 8. Camera — smooth follow with look-ahead and screen shake
// ---------------------------------------------------------------------------
class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.look = 0;
    this.shakeT = 0;
    this.shakeMag = 0;
    this.sx = 0;
    this.sy = 0;
    this.enabled = true;   // screen shake setting
  }

  snap(tx, ty, b) {
    this.x = clamp(tx - VIEW_W / 2, b.x0, Math.max(b.x0, b.x1 - VIEW_W));
    this.y = clamp(ty - VIEW_H * 0.55, b.y0, Math.max(b.y0, b.y1 - VIEW_H));
    this.look = 0;
  }

  follow(tx, ty, facing, vx, dt, b) {
    this.look = lerp(this.look, facing * 90 * clamp(Math.abs(vx) / PHYS.runSpeed + 0.3, 0, 1), 1 - Math.exp(-2.5 * dt));
    const wantX = tx - VIEW_W / 2 + this.look;
    const wantY = ty - VIEW_H * 0.55;
    this.x = lerp(this.x, wantX, 1 - Math.exp(-6 * dt));
    this.y = lerp(this.y, wantY, 1 - Math.exp(-4 * dt));
    this.x = clamp(this.x, b.x0, Math.max(b.x0, b.x1 - VIEW_W));
    this.y = clamp(this.y, b.y0, Math.max(b.y0, b.y1 - VIEW_H));
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const m = this.enabled ? this.shakeMag * clamp(this.shakeT / 0.3, 0, 1) : 0;
      this.sx = rand(-m, m);
      this.sy = rand(-m, m);
    } else {
      this.sx = this.sy = 0;
    }
  }

  shake(mag, t) {
    this.shakeMag = Math.max(this.shakeMag * (this.shakeT > 0 ? 1 : 0), mag);
    this.shakeT = Math.max(this.shakeT, t);
  }

  get ox() { return Math.round(this.x + this.sx); }
  get oy() { return Math.round(this.y + this.sy); }
}

// ---------------------------------------------------------------------------
// 9. SpaceBackground — parallax layers, pre-rendered where possible
// ---------------------------------------------------------------------------
class SpaceBackground {
  constructor(theme, seed) {
    this.T = theme;
    const rnd = mulberry32(seed);
    this.rnd = rnd;
    this.wrap = 2400;
    // twinkling star layers
    this.stars = [0.03, 0.07, 0.14].map((par, li) => {
      const n = [220, 120, 60][li];
      const arr = [];
      for (let i = 0; i < n; i++) {
        arr.push({ x: rnd() * this.wrap, y: rnd() * (VIEW_H + 120), s: (li + 1) * (0.6 + rnd() * 0.8), ph: rnd() * TAU, sp: 0.5 + rnd() * 3, c: rnd() < 0.15 ? theme.accent : '#ffffff' });
      }
      return { par, arr };
    });
    this.nebula = this.buildNebula(rnd);
    this.galaxies = [0, 1].map((i) => ({ x: 400 + i * 1300 + rnd() * 300, y: 60 + rnd() * 160, spr: this.buildGalaxy(rnd, i), rot: rnd() * TAU }));
    this.planets = [0, 1, 2].map((i) => {
      const r = [70, 34, 22][i];
      return { par: [0.1, 0.16, 0.22][i], x: 300 + i * 900 + rnd() * 400, y: 70 + rnd() * 200, r, spr: this.buildPlanet(rnd, r, i === 0 || rnd() < 0.5) };
    });
    this.asteroids = [];
    for (let i = 0; i < 16; i++) {
      const pts = [];
      const k = 7 + Math.floor(rnd() * 4);
      for (let j = 0; j < k; j++) pts.push(0.7 + rnd() * 0.4);
      this.asteroids.push({ x: rnd() * this.wrap, y: 60 + rnd() * (VIEW_H - 120), r: 6 + rnd() * 16, pts, rot: rnd() * TAU, vr: (rnd() - 0.5) * 0.6, vx: -4 - rnd() * 10, vy: (rnd() - 0.5) * 4 });
    }
    this.dust = [];
    for (let i = 0; i < 50; i++) this.dust.push({ x: rnd() * VIEW_W * 2, y: rnd() * VIEW_H, s: 1 + rnd() * 2.5, ph: rnd() * TAU });
    this.debris = [];
    for (let i = 0; i < 4; i++) {
      const pts = [];
      for (let j = 0; j < 8; j++) pts.push(0.6 + rnd() * 0.5);
      this.debris.push({ x: rnd() * 3000, y: 80 + rnd() * (VIEW_H - 160), r: 18 + rnd() * 26, pts, rot: rnd() * TAU, vr: (rnd() - 0.5) * 0.4 });
    }
    this.shooting = [];
    this.nextShoot = 1.5;
    this.comet = null;
    this.nextComet = 8;
    this.nova = null;
    this.nextNova = 20 + rnd() * 15;
    this.flash = 0;
  }

  buildNebula(rnd) {
    const W = 1600;
    const H = VIEW_H + 160;
    const c = makeCanvas(W, H);
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const r = 120 + rnd() * 260;
      const col = this.T.neb[i % this.T.neb.length];
      for (const ox of [-W, 0, W]) {
        const grad = g.createRadialGradient(x + ox, y, 0, x + ox, y, r);
        grad.addColorStop(0, hexA(col, 0.18 + rnd() * 0.1));
        grad.addColorStop(0.5, hexA(col, 0.06));
        grad.addColorStop(1, hexA(col, 0));
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y - r, r * 2, r * 2);
      }
    }
    // dark dust lanes for depth
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 6; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const r = 80 + rnd() * 160;
      for (const ox of [-W, 0, W]) {
        const grad = g.createRadialGradient(x + ox, y, 0, x + ox, y, r);
        grad.addColorStop(0, 'rgba(0,0,0,0.25)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y - r, r * 2, r * 2);
      }
    }
    return { canvas: c, W, par: 0.05 };
  }

  buildGalaxy(rnd, i) {
    const R = 70;
    const c = makeCanvas(R * 2, R * 2);
    const g = c.getContext('2d');
    g.globalCompositeOperation = 'lighter';
    const col = this.T.neb[(i + 1) % this.T.neb.length];
    const core = g.createRadialGradient(R, R, 0, R, R, R * 0.4);
    core.addColorStop(0, 'rgba(255,255,255,0.7)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, R * 2, R * 2);
    for (let arm = 0; arm < 2; arm++) {
      for (let k = 0; k < 220; k++) {
        const t = k / 220;
        const a = arm * Math.PI + t * 4.2;
        const rr = t * R * 0.95;
        const x = R + Math.cos(a) * rr + (rnd() - 0.5) * 8 * t;
        const y = R + Math.sin(a) * rr * 0.45 + (rnd() - 0.5) * 5 * t;
        g.fillStyle = hexA(col, 0.5 * (1 - t) + 0.1);
        g.fillRect(x, y, 1.5, 1.5);
      }
    }
    return c;
  }

  buildPlanet(rnd, r, ring) {
    const S = r * 3.2;
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    const cx = S / 2;
    const cy = S / 2;
    const [c1, c2] = this.T.planet;
    const drawRing = (front) => {
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.35);
      g.scale(1, 0.28);
      g.beginPath();
      if (front) g.arc(0, 0, r * 1.45, 0, Math.PI);
      else g.arc(0, 0, r * 1.45, Math.PI, TAU);
      g.lineWidth = r * 0.35;
      g.strokeStyle = hexA(c2, 0.35);
      g.stroke();
      g.lineWidth = r * 0.08;
      g.strokeStyle = hexA('#ffffff', 0.35);
      g.stroke();
      g.restore();
    };
    if (ring) drawRing(false);
    const grad = g.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.1, cx, cy, r);
    grad.addColorStop(0, c2);
    grad.addColorStop(0.6, c1);
    grad.addColorStop(1, '#05030a');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();
    // bands
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.clip();
    for (let i = 0; i < 5; i++) {
      g.fillStyle = hexA(i % 2 ? c2 : '#000000', 0.12);
      g.fillRect(cx - r, cy - r + (i * 2 + rnd()) * r * 0.2, r * 2, r * 0.12);
    }
    g.restore();
    // atmosphere rim
    g.strokeStyle = hexA(c2, 0.5);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, r, -2.4, -0.6);
    g.stroke();
    if (ring) drawRing(true);
    return c;
  }

  update(dt) {
    for (const a of this.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rot += a.vr * dt;
      if (a.x < -40) a.x += this.wrap;
      if (a.y < 30 || a.y > VIEW_H - 30) a.vy = -a.vy;
    }
    for (const d of this.debris) d.rot += d.vr * dt;
    // shooting stars
    this.nextShoot -= dt;
    if (this.nextShoot <= 0) {
      this.nextShoot = rand(1.5, 4.5);
      this.shooting.push({ x: rand(100, VIEW_W + 200), y: rand(-20, VIEW_H * 0.5), vx: -rand(500, 800), vy: rand(200, 350), life: 0.9, max: 0.9 });
    }
    for (const s of this.shooting) { s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt; if (s.life <= 0) s.dead = true; }
    sweep(this.shooting);
    // comet
    this.nextComet -= dt;
    if (!this.comet && this.nextComet <= 0) {
      this.comet = { x: VIEW_W + 100, y: rand(40, 200), vx: -rand(60, 110), vy: rand(5, 20) };
      this.nextComet = rand(18, 30);
    }
    if (this.comet) {
      this.comet.x += this.comet.vx * dt;
      this.comet.y += this.comet.vy * dt;
      if (this.comet.x < -300) this.comet = null;
    }
    // supernova
    this.nextNova -= dt;
    if (!this.nova && this.nextNova <= 0) {
      this.nova = { x: rand(80, VIEW_W - 80), y: rand(40, VIEW_H * 0.45), t: 0 };
      this.nextNova = rand(25, 45);
    }
    if (this.nova) {
      this.nova.t += dt;
      if (this.nova.t > 3) this.nova = null;
    }
  }

  draw(ctx, camX, camY, time, reduceFlash) {
    const T = this.T;
    const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, T.skyTop);
    sky.addColorStop(1, T.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    // nebula
    const nb = this.nebula;
    const nx = -((camX * nb.par) % nb.W);
    const ny = -40 - camY * 0.03;
    ctx.drawImage(nb.canvas, nx, ny);
    ctx.drawImage(nb.canvas, nx + nb.W, ny);
    if (nx + nb.W * 2 < VIEW_W) ctx.drawImage(nb.canvas, nx + nb.W * 2, ny);

    // galaxies
    for (const gx of this.galaxies) {
      const x = wrapX(gx.x - camX * 0.025, this.wrap);
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.translate(x, gx.y - camY * 0.02);
      ctx.rotate(gx.rot + time * 0.01);
      ctx.drawImage(gx.spr, -gx.spr.width / 2, -gx.spr.height / 2);
      ctx.restore();
    }

    // stars
    for (const layer of this.stars) {
      for (const s of layer.arr) {
        const x = wrapX(s.x - camX * layer.par, this.wrap);
        if (x > VIEW_W + 4) continue;
        const y = s.y - 60 - camY * layer.par;
        const tw = 0.55 + 0.45 * Math.sin(time * s.sp + s.ph);
        ctx.globalAlpha = tw;
        ctx.fillStyle = s.c;
        ctx.fillRect(x, y, s.s, s.s);
      }
    }
    ctx.globalAlpha = 1;

    // supernova (distant flash)
    if (this.nova) {
      const k = this.nova.t;
      const a = k < 0.4 ? k / 0.4 : Math.max(0, 1 - (k - 0.4) / 2.6);
      const r = 10 + k * 40;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * (reduceFlash ? 0.35 : 0.9);
      ctx.drawImage(glowSprite('#ffffff', 64), this.nova.x - r, this.nova.y - r, r * 2, r * 2);
      ctx.drawImage(glowSprite(T.accent, 64), this.nova.x - r * 2.2, this.nova.y - r * 2.2, r * 4.4, r * 4.4);
      ctx.restore();
      if (!reduceFlash && k < 0.25) {
        ctx.fillStyle = 'rgba(255,255,255,' + (0.08 * (1 - k / 0.25)) + ')';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      }
    }

    // planets
    for (const p of this.planets) {
      const x = wrapX(p.x - camX * p.par, this.wrap);
      ctx.drawImage(p.spr, x - p.spr.width / 2, p.y - camY * p.par - p.spr.height / 2);
    }

    // comet
    if (this.comet) {
      const c = this.comet;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const tail = ctx.createLinearGradient(c.x, c.y, c.x + 220, c.y - 40);
      tail.addColorStop(0, 'rgba(255,255,255,0.6)');
      tail.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = tail;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + 220, c.y - 40);
      ctx.stroke();
      ctx.drawImage(glowSprite(T.accent, 20), c.x - 14, c.y - 14, 28, 28);
      ctx.restore();
    }

    // shooting stars
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2;
    for (const s of this.shooting) {
      const a = s.life / s.max;
      const g = ctx.createLinearGradient(s.x, s.y, s.x - s.vx * 0.12, s.y - s.vy * 0.12);
      g.addColorStop(0, 'rgba(255,255,255,' + a + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = g;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.12, s.y - s.vy * 0.12);
      ctx.stroke();
    }
    ctx.restore();

    // drifting asteroids
    for (const a of this.asteroids) {
      const x = wrapX(a.x - camX * 0.35, this.wrap);
      if (x > VIEW_W + 40) continue;
      drawRock(ctx, x, a.y - camY * 0.3, a.r, a.pts, a.rot, 'rgba(40,34,60,0.9)', hexA(T.edge, 0.35));
    }
  }

  drawForeground(ctx, camX, camY, time) {
    // floating dust
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const d of this.dust) {
      const x = wrapX(d.x - camX * 1.25, VIEW_W * 2) - 100;
      const y = (d.y - camY * 1.1 + Math.sin(time * 0.7 + d.ph) * 12) % VIEW_H;
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(time + d.ph);
      ctx.fillStyle = this.T.accent;
      ctx.fillRect(x, (y + VIEW_H) % VIEW_H, d.s, d.s);
    }
    ctx.restore();
    // big blurred debris passing in front
    for (const d of this.debris) {
      const x = wrapX(d.x - camX * 1.6, 3000) - 200;
      if (x < -80 || x > VIEW_W + 80) continue;
      ctx.globalAlpha = 0.55;
      drawRock(ctx, x, d.y - camY * 1.4, d.r, d.pts, d.rot, 'rgba(8,6,16,0.95)', hexA(this.T.edge, 0.25));
      ctx.globalAlpha = 1;
    }
  }
}

function wrapX(x, w) {
  let r = x % w;
  if (r < -200) r += w;
  return r;
}

/** '#rrggbb' + alpha → rgba() string. */
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a.toFixed(3) + ')';
}

function drawRock(ctx, x, y, r, pts, rot, fill, stroke) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const a = (i / pts.length) * TAU;
    const rr = r * pts[i];
    if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 10. Level — runtime world built from the LEVELS data
// ---------------------------------------------------------------------------
const BUCKET = 256;
const CHUNK_W = 512;

class Level {
  constructor(index) {
    const d = LEVELS[index];
    this.index = index;
    this.data = d;
    this.T = THEMES[d.theme];
    this.widthPx = d.width * TILE;
    this.heightPx = WORLD_ROWS * TILE;
    this.solids = [];
    for (const [x, w, row] of d.ground) this.solids.push({ x: x * TILE, y: row * TILE, w: w * TILE, h: (WORLD_ROWS - row) * TILE, ground: true });
    for (const [x, row, w, h] of d.blocks) this.solids.push({ x: x * TILE, y: row * TILE, w: w * TILE, h: h * TILE });
    this.buckets = new Map();
    this.solids.forEach((s) => {
      for (let b = Math.floor(s.x / BUCKET); b <= Math.floor((s.x + s.w) / BUCKET); b++) {
        if (!this.buckets.has(b)) this.buckets.set(b, []);
        this.buckets.get(b).push(s);
      }
    });

    this.plats = [];
    for (const [x, row, w, bonus] of d.plats) this.plats.push(this.makePlat('static', x, row, w, { bonus: !!bonus }));
    for (const [x, row, w] of d.crumbles) this.plats.push(this.makePlat('crumble', x, row, w, {}));
    for (const [x, row, w, dx, dy, period] of d.movers) {
      this.plats.push(this.makePlat('mover', x, row, w, { ox: x * TILE, oy: row * TILE, mdx: dx * TILE, mdy: dy * TILE, period, phase: 0 }));
    }
    this.bounces = d.bounces.map(([x, row]) => ({ x: x * TILE + 2, y: row * TILE - 10, w: TILE - 4, h: 10, anim: 0 }));
    this.lowGrav = d.lowGrav.map(([x, row, w, h]) => ({ x: x * TILE, y: row * TILE, w: w * TILE, h: h * TILE }));
    this.bubbles = [];
    const rnd = mulberry32(index * 977 + 5);
    for (const z of this.lowGrav) {
      const n = Math.floor((z.w * z.h) / 9000);
      for (let i = 0; i < n; i++) this.bubbles.push({ z, x: z.x + rnd() * z.w, y: z.y + rnd() * z.h, r: 3 + rnd() * 9, sp: 15 + rnd() * 30, ph: rnd() * TAU });
    }

    this.coins = [];
    const addCoin = (tx, ty) => this.coins.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2, r: 9, taken: false, ph: (tx * 0.7) % TAU });
    for (const [x, row] of d.coins) addCoin(x, row);
    for (const [x, row, n] of d.coinRows) for (let i = 0; i < n; i++) addCoin(x + i, row);
    for (const [x, row, w, n, h] of d.coinArcs) {
      for (let i = 0; i < n; i++) {
        const f = n === 1 ? 0.5 : i / (n - 1);
        addCoin(x + f * w, row - h * 4 * f * (1 - f));
      }
    }
    this.coinTotal = this.coins.length;

    this.items = d.items.map(([type, x, row]) => ({ type, x: x * TILE + TILE / 2, y: row * TILE + TILE / 2, taken: false, ph: x }));
    this.checkpoints = d.checkpoints.map(([x, row]) => ({ x: x * TILE + TILE / 2, y: row * TILE, active: false, glow: 0 }));
    const s = d.secret;
    this.secret = {
      entry: { x: (s.entry[0] + 0.5) * TILE, y: (s.entry[1] + 0.5) * TILE },
      room: { x: s.room[0] * TILE, y: s.room[1] * TILE, w: s.room[2] * TILE, h: s.room[3] * TILE },
      spawn: { x: (s.spawn[0] + 0.5) * TILE, y: s.spawn[1] * TILE },
      star: { x: (s.star[0] + 0.5) * TILE, y: (s.star[1] + 0.5) * TILE, taken: false },
      exit: { x: (s.exit[0] + 0.5) * TILE, y: (s.exit[1] + 0.5) * TILE },
      returnTo: { x: (s.returnTo[0] + 0.5) * TILE, y: s.returnTo[1] * TILE },
      found: false,
    };
    this.start = { x: (d.start[0] + 0.5) * TILE, y: d.start[1] * TILE };
    this.goal = { x: (d.goal[0] + 0.5) * TILE, y: d.goal[1] * TILE - 78, locked: !!d.boss };
    this.boss = d.boss ? { x0: d.boss.arena[0] * TILE, x1: d.boss.arena[1] * TILE, groundY: d.boss.row * TILE } : null;

    this.mainBounds = { x0: 0, x1: this.widthPx, y0: 0, y1: this.heightPx };
    const r = this.secret.room;
    this.roomBounds = { x0: r.x - 64, x1: r.x + r.w + 64, y0: 0, y1: this.heightPx };
    this.chunks = new Map();
  }

  makePlat(kind, x, row, w, extra) {
    return Object.assign({ kind, x: x * TILE, y: row * TILE, w: w * TILE, h: kind === 'static' ? 14 : 16, prevX: x * TILE, prevY: row * TILE, dx: 0, dy: 0, active: true, timer: 0, respawn: 0, shake: 0 }, extra);
  }

  /** Solids whose bucket overlaps the x range. */
  solidsNear(x0, x1) {
    const out = [];
    const b0 = Math.floor(x0 / BUCKET);
    const b1 = Math.floor(x1 / BUCKET);
    for (let b = b0; b <= b1; b++) {
      const arr = this.buckets.get(b);
      if (!arr) continue;
      for (const s of arr) if (out.indexOf(s) < 0) out.push(s);
    }
    return out;
  }

  pointSolid(px, py) {
    for (const s of this.solidsNear(px, px)) if (px >= s.x && px < s.x + s.w && py >= s.y && py < s.y + s.h) return true;
    return false;
  }

  /** True if there is something to stand on right below (px, py). */
  surfaceBelow(px, py) {
    if (this.pointSolid(px, py + 2)) return true;
    for (const p of this.plats) if (p.active && px >= p.x && px <= p.x + p.w && py + 2 >= p.y && py + 2 <= p.y + p.h) return true;
    return false;
  }

  rectHitsSolid(r) {
    for (const s of this.solidsNear(r.x, r.x + r.w)) if (overlap(r, s)) return true;
    return false;
  }

  inLowGrav(x, y) {
    for (const z of this.lowGrav) if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return true;
    return false;
  }

  inRoom(x) {
    const r = this.secret.room;
    return x >= r.x - 64 && x <= r.x + r.w + 64;
  }

  /** Movers and crumbles. Records per-step delta so riders can be carried. */
  update(dt, time, game) {
    for (const p of this.plats) {
      p.prevX = p.x;
      p.prevY = p.y;
      if (p.kind === 'mover') {
        const k = 0.5 - 0.5 * Math.cos((time / p.period) * TAU);
        p.x = p.ox + p.mdx * k;
        p.y = p.oy + p.mdy * k;
      } else if (p.kind === 'crumble') {
        if (p.active && p.timer > 0) {
          p.timer -= dt;
          p.shake = 2;
          if (p.timer <= 0) {
            p.active = false;
            p.respawn = 3.5;
            game.particles.burst(p.x + p.w / 2, p.y + 6, 60, { speed: [30, 160], life: [0.5, 1.2], size: [2, 5], color: [this.T.rockTop, this.T.edge, '#aaaaaa'], g: 500, jitter: p.w / 2 });
            game.audio.play('crumble');
          }
        } else if (!p.active) {
          p.respawn -= dt;
          if (p.respawn <= 0) { p.active = true; p.timer = 0; p.shake = 0; }
        } else {
          p.shake = 0;
        }
      }
      p.dx = p.x - p.prevX;
      p.dy = p.y - p.prevY;
    }
    for (const b of this.bounces) b.anim = Math.max(0, b.anim - dt * 2.5);
    for (const c of this.checkpoints) if (c.active) c.glow = Math.min(1, c.glow + dt * 2);
  }

  resetDynamic() {
    for (const p of this.plats) if (p.kind === 'crumble') { p.active = true; p.timer = 0; p.shake = 0; }
  }

  // --- rendering -----------------------------------------------------------

  chunk(ci) {
    let c = this.chunks.get(ci);
    if (c) return c;
    c = makeCanvas(CHUNK_W, this.heightPx);
    const g = c.getContext('2d');
    const x0 = ci * CHUNK_W;
    const list = this.solidsNear(x0 - 8, x0 + CHUNK_W + 8);
    for (const s of list) this.paintSolid(g, s, -x0);
    this.chunks.set(ci, c);
    return c;
  }

  paintSolid(g, s, ox) {
    const T = this.T;
    const x = s.x + ox;
    const rnd = mulberry32(Math.floor(s.x * 7 + s.y * 13));
    const grad = g.createLinearGradient(0, s.y, 0, s.y + Math.min(s.h, 200));
    grad.addColorStop(0, T.rockTop);
    grad.addColorStop(1, T.rockBottom);
    g.fillStyle = grad;
    g.fillRect(x, s.y, s.w, s.h);
    // metal panel seams + rivets
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    for (let px = 64; px < s.w; px += 64) {
      g.beginPath();
      g.moveTo(x + px + 0.5, s.y + 10);
      g.lineTo(x + px + 0.5, s.y + s.h);
      g.stroke();
    }
    for (let py = 40; py < Math.min(s.h, 200); py += 48) {
      g.beginPath();
      g.moveTo(x, s.y + py + 0.5);
      g.lineTo(x + s.w, s.y + py + 0.5);
      g.stroke();
    }
    // craters/specks
    const n = Math.floor((s.w * Math.min(s.h, 200)) / 700);
    for (let i = 0; i < n; i++) {
      const cx = x + rnd() * s.w;
      const cy = s.y + 12 + rnd() * Math.min(s.h - 14, 190);
      const r = 1 + rnd() * 4;
      g.fillStyle = rnd() < 0.7 ? 'rgba(0,0,0,0.3)' : hexA(T.edge, 0.25);
      g.beginPath();
      g.arc(cx, cy, r, 0, TAU);
      g.fill();
    }
    // neon edges
    g.save();
    g.shadowColor = T.edge;
    g.shadowBlur = 14;
    g.fillStyle = T.edge;
    g.fillRect(x, s.y, s.w, 3);
    g.shadowBlur = 8;
    g.fillStyle = hexA(T.edge2, 0.7);
    g.fillRect(x, s.y + 3, 2, Math.min(s.h, 160));
    g.fillRect(x + s.w - 2, s.y + 3, 2, Math.min(s.h, 160));
    g.restore();
    // top highlight band
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(x, s.y + 3, s.w, 6);
    // theme decoration on top
    const deco = Math.floor(s.w / 40);
    for (let i = 0; i < deco; i++) {
      const dx = x + 8 + rnd() * (s.w - 16);
      if (this.data.theme === 'crystal') {
        const h = 6 + rnd() * 12;
        g.fillStyle = hexA(rnd() < 0.5 ? T.edge : T.edge2, 0.75);
        g.beginPath();
        g.moveTo(dx - 3, s.y);
        g.lineTo(dx, s.y - h);
        g.lineTo(dx + 3, s.y);
        g.fill();
      } else if (this.data.theme === 'asteroid') {
        g.fillStyle = hexA('#ff3d00', 0.6);
        g.fillRect(dx, s.y + 8 + rnd() * 20, 6 + rnd() * 12, 2);
      } else {
        g.fillStyle = hexA(T.edge2, 0.8);
        g.beginPath();
        g.arc(dx, s.y - 2, 1.5 + rnd() * 1.5, 0, TAU);
        g.fill();
      }
    }
  }

  drawStatic(ctx, camX, camY) {
    const c0 = Math.floor(camX / CHUNK_W);
    const c1 = Math.floor((camX + VIEW_W) / CHUNK_W);
    for (let ci = c0; ci <= c1; ci++) {
      if (ci < 0) continue;
      ctx.drawImage(this.chunk(ci), ci * CHUNK_W - camX, -camY);
    }
  }

  drawDynamic(ctx, camX, camY, time, game) {
    const T = this.T;
    const vis = (x, w) => x + w > camX - 60 && x < camX + VIEW_W + 60;

    // low-gravity zones
    for (const z of this.lowGrav) {
      if (!vis(z.x, z.w)) continue;
      ctx.fillStyle = hexA(T.edge2, 0.05 + 0.02 * Math.sin(time * 2));
      ctx.fillRect(z.x - camX, z.y - camY, z.w, z.h);
      ctx.strokeStyle = hexA(T.edge2, 0.25);
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = -time * 20;
      ctx.strokeRect(z.x - camX + 0.5, z.y - camY + 0.5, z.w, z.h);
      ctx.setLineDash([]);
    }
    for (const b of this.bubbles) {
      const z = b.z;
      if (!vis(z.x, z.w)) continue;
      let y = b.y - ((time * b.sp) % z.h);
      if (y < z.y) y += z.h;
      const x = b.x + Math.sin(time * 1.3 + b.ph) * 8;
      ctx.strokeStyle = hexA(T.edge2, 0.45);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x - camX, y - camY, b.r, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(x - camX - b.r * 0.4, y - camY - b.r * 0.5, 2, 2);
    }

    // platforms
    for (const p of this.plats) {
      if (!vis(p.x, p.w)) continue;
      if (!p.active) continue;
      const x = p.x - camX + (p.shake ? rand(-p.shake, p.shake) : 0);
      const y = p.y - camY;
      if (p.kind === 'crumble') {
        ctx.fillStyle = '#3a3346';
        ctx.fillRect(x, y, p.w, p.h);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        for (let k = 12; k < p.w; k += 17) { ctx.moveTo(x + k, y); ctx.lineTo(x + k - 5, y + p.h); }
        ctx.stroke();
        ctx.fillStyle = hexA('#ffaa66', 0.8);
        ctx.fillRect(x, y, p.w, 2);
      } else {
        const grad = ctx.createLinearGradient(0, y, 0, y + p.h);
        grad.addColorStop(0, p.kind === 'mover' ? '#4c5d80' : '#3b3f5c');
        grad.addColorStop(1, '#141625');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, p.w, p.h);
        ctx.fillStyle = p.bonus ? '#ffd23d' : T.edge;
        ctx.fillRect(x, y, p.w, 3);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5 + 0.2 * Math.sin(time * 4 + p.x);
        const spr = glowSprite(p.kind === 'mover' ? T.edge2 : T.edge, 16);
        for (let k = 10; k < p.w; k += 28) ctx.drawImage(spr, x + k - 8, y + p.h - 6, 16, 16);
        ctx.restore();
      }
    }

    // bounce pads
    for (const b of this.bounces) {
      if (!vis(b.x, b.w)) continue;
      const x = b.x - camX;
      const y = b.y - camY;
      ctx.fillStyle = '#2a2f4a';
      ctx.fillRect(x, y + 4, b.w, 6);
      const squash = 1 - b.anim * 0.5;
      ctx.fillStyle = '#ff4fd8';
      ctx.fillRect(x + 3, y + 4 - 4 * squash, b.w - 6, 4);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 3; k++) {
        const ph = (time * 1.2 + k / 3) % 1;
        ctx.strokeStyle = hexA('#ff4fd8', (1 - ph) * 0.8);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x + b.w / 2, y + 2 - ph * 26, b.w * 0.45 * (1 + ph * 0.3), 4, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.restore();
    }

    // checkpoints (beacon pylons)
    for (const c of this.checkpoints) {
      if (!vis(c.x - 20, 40)) continue;
      const x = c.x - camX;
      const y = c.y - camY;
      ctx.fillStyle = '#2b2d44';
      ctx.fillRect(x - 5, y - 54, 10, 54);
      ctx.fillStyle = '#4a4e70';
      ctx.fillRect(x - 10, y - 6, 20, 6);
      const col = c.active ? '#3dffb0' : '#666a88';
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const pulse = c.active ? 0.8 + 0.2 * Math.sin(time * 5) : 0.3;
      ctx.globalAlpha = pulse;
      ctx.drawImage(glowSprite(col, 32), x - 24, y - 82, 48, 48);
      if (c.active) {
        const beam = ctx.createLinearGradient(0, y - 400, 0, y - 60);
        beam.addColorStop(0, 'rgba(61,255,176,0)');
        beam.addColorStop(1, 'rgba(61,255,176,' + (0.25 * c.glow) + ')');
        ctx.fillStyle = beam;
        ctx.fillRect(x - 4, y - 400, 8, 340);
      }
      ctx.restore();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, y - 70);
      ctx.lineTo(x + 8, y - 58);
      ctx.lineTo(x, y - 46);
      ctx.lineTo(x - 8, y - 58);
      ctx.closePath();
      ctx.fill();
    }

    // coins
    for (const c of this.coins) {
      if (c.taken || !vis(c.x - 12, 24)) continue;
      drawCoin(ctx, c.x - camX, c.y - camY + Math.sin(time * 3 + c.ph) * 2, time + c.ph, 1);
    }

    // items
    for (const it of this.items) {
      if (it.taken || !vis(it.x - 20, 40)) continue;
      drawItem(ctx, it.type, it.x - camX, it.y - camY + Math.sin(time * 2.5 + it.ph) * 5, time);
    }

    // secret entry portal (faint, a little hidden) + room exit + star
    const s = this.secret;
    if (vis(s.entry.x - 30, 60)) drawMiniPortal(ctx, s.entry.x - camX, s.entry.y - camY, time, 0.35, T.accent);
    if (vis(s.exit.x - 30, 60)) drawMiniPortal(ctx, s.exit.x - camX, s.exit.y - camY, time, 0.9, '#3dffb0');
    if (!s.star.taken && vis(s.star.x - 20, 40)) drawStar(ctx, s.star.x - camX, s.star.y - camY + Math.sin(time * 2) * 4, 16, time, true);

    // goal portal
    if (vis(this.goal.x - 120, 240)) drawGoalPortal(ctx, this.goal.x - camX, this.goal.y - camY, time, this.goal.locked, T, game ? game.portalPulse : 0);
  }
}

// --- shared drawing helpers --------------------------------------------------

function drawCoin(ctx, x, y, t, scale) {
  const w = Math.abs(Math.cos(t * 2.2)) * 9 * scale + 1.5;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.6;
  ctx.drawImage(glowSprite('#ffcc33', 20), x - 18 * scale, y - 18 * scale, 36 * scale, 36 * scale);
  ctx.restore();
  ctx.fillStyle = '#ffd84a';
  ctx.beginPath();
  ctx.ellipse(x, y, w, 9 * scale, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff3b0';
  ctx.beginPath();
  ctx.ellipse(x - w * 0.25, y - 2 * scale, w * 0.3, 4 * scale, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#c98a00';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(x, y, w, 9 * scale, 0, 0, TAU);
  ctx.stroke();
}

function drawStar(ctx, x, y, r, t, glow) {
  if (glow) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 4);
    ctx.drawImage(glowSprite('#fff27a', 32), x - r * 3, y - r * 3, r * 6, r * 6);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(t * 1.5) * 0.2);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffe14d';
  ctx.fill();
  ctx.strokeStyle = '#fff8c8';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

const ITEM_COLORS = { boots: '#ffc21a', spring: '#ff8a3d', shield: '#4fc3ff' };

function drawItem(ctx, type, x, y, t) {
  const col = ITEM_COLORS[type];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 5);
  ctx.drawImage(glowSprite(col, 32), x - 30, y - 30, 60, 60);
  ctx.restore();
  // capsule
  ctx.fillStyle = 'rgba(10,12,30,0.85)';
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 15, 0, TAU);
  ctx.fill();
  ctx.stroke();
  drawItemIcon(ctx, type, x, y, 1);
  // sparkles
  for (let i = 0; i < 3; i++) {
    const a = t * 2 + (i * TAU) / 3;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + Math.cos(a) * 21 - 1, y + Math.sin(a) * 21 - 1, 2, 2);
  }
}

function drawItemIcon(ctx, type, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (type === 'boots') {
    ctx.fillStyle = '#ffc21a';
    ctx.beginPath();
    ctx.moveTo(-7, -8); ctx.lineTo(0, -8); ctx.lineTo(0, 1); ctx.lineTo(8, 3); ctx.lineTo(8, 7); ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-7, 5, 15, 2);
    ctx.fillStyle = '#ff7a00';
    ctx.beginPath(); ctx.moveTo(-9, -4); ctx.lineTo(-13, -1); ctx.lineTo(-9, 1); ctx.fill();
  } else if (type === 'spring') {
    // little guardian with a spring
    ctx.strokeStyle = '#ff8a3d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) ctx.lineTo(i % 2 ? 5 : -5, 8 - i * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd0a0';
    ctx.beginPath();
    ctx.arc(0, -6, 5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.fillRect(-2.5, -7, 1.5, 1.5);
    ctx.fillRect(1, -7, 1.5, 1.5);
  } else {
    ctx.strokeStyle = '#4fc3ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(79,195,255,0.35)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-5, -5, 3, 3);
  }
  ctx.restore();
}

function drawMiniPortal(ctx, x, y, t, alpha, col) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(glowSprite(col, 32), x - 30, y - 30, 60, 60);
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(x, y, 16 - i * 4, 22 - i * 5, 0, t * (2 + i) + i, t * (2 + i) + i + 4.2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawGoalPortal(ctx, x, y, t, locked, T, pulse) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const a = locked ? 0.25 : 1;
  // light beams
  if (!locked) {
    for (let i = 0; i < 8; i++) {
      const ang = t * 0.3 + (i * TAU) / 8;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      const g = ctx.createLinearGradient(0, 0, 0, -260);
      g.addColorStop(0, hexA(T.accent, 0.25));
      g.addColorStop(1, hexA(T.accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-6, 0);
      ctx.lineTo(-22, -260);
      ctx.lineTo(22, -260);
      ctx.lineTo(6, 0);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.globalAlpha = a;
  ctx.drawImage(glowSprite(T.edge2, 64), x - 110, y - 110, 220, 220);
  ctx.drawImage(glowSprite('#ffffff', 32), x - 30 - pulse * 30, y - 30 - pulse * 30, 60 + pulse * 60, 60 + pulse * 60);
  // rotating rings
  const rings = [[64, 1.0, T.edge], [52, -1.6, T.edge2], [40, 2.4, '#ffffff'], [72, -0.6, T.accent]];
  for (const [r, sp, col] of rings) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 0.7, r, 0, t * sp, t * sp + 4.5);
    ctx.stroke();
    // orbiting sparks
    const sa = t * sp * 1.5;
    ctx.fillStyle = col;
    ctx.fillRect(x + Math.cos(sa) * r * 0.7 - 2, y + Math.sin(sa) * r - 2, 4, 4);
  }
  // swirling core
  const core = ctx.createRadialGradient(x, y, 0, x, y, 46);
  core.addColorStop(0, 'rgba(255,255,255,0.9)');
  core.addColorStop(0.4, hexA(T.edge2, 0.6));
  core.addColorStop(1, hexA(T.edge, 0));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.ellipse(x, y, 34, 48, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  // base pedestal
  ctx.fillStyle = '#20223a';
  ctx.fillRect(x - 46, y + 70, 92, 8);
  ctx.fillStyle = T.edge;
  ctx.fillRect(x - 46, y + 70, 92, 2);
  if (locked) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,60,90,0.8)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = t * 30;
    ctx.beginPath();
    ctx.ellipse(x, y, 54, 76, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,90,110,0.9)';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SEALED', x, y + 4);
  }
}

// ---------------------------------------------------------------------------
// 11. Player — the glowing cube
// ---------------------------------------------------------------------------
const CUBE_SKINS = [
  { body: '#38e1ff', dark: '#0b7ea8', glow: '#38e1ff', hat: false },
  { body: '#ff5fd2', dark: '#a0187f', glow: '#ff7ae0', hat: true },   // easter egg "STAR"
];

class Player {
  constructor() {
    this.skin = CUBE_SKINS[0];
    this.reset(0, 0);
  }

  reset(cx, feetY) {
    this.w = PHYS.playerW;
    this.h = PHYS.playerH;
    this.x = cx - this.w / 2;
    this.y = feetY - this.h;
    this.vx = 0;
    this.vy = 0;
    this.onGround = false;
    this.groundPlat = null;
    this.coyote = 0;
    this.jumpBuf = 0;
    this.jumpHeld = false;
    this.facing = 1;
    this.shootCd = 0;
    this.superT = 0;
    this.superMax = 1;
    this.shieldT = 0;
    this.ducking = false;
    this.dead = false;
    this.deadT = 0;
    this.idleT = 0;
    this.yawnT = 0;
    this.blinkT = rand(1, 4);
    this.blink = 0;
    this.sqx = 1;
    this.sqy = 1;
    this.lookX = 0;
    this.lookY = 0;
    this.scared = false;
    this.visible = true;
    this.spin = 0;
    this.scale = 1;
    this.wasAir = false;
    this.fallStart = 0;
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }

  update(dt, input, level, game) {
    if (this.dead) { this.deadT += dt; return; }
    this.shootCd -= dt;
    if (this.superT > 0) this.superT = Math.max(0, this.superT - dt);
    if (this.shieldT > 0) this.shieldT = Math.max(0, this.shieldT - dt);
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blink = 0.13; this.blinkT = rand(2, 5); }
    this.blink = Math.max(0, this.blink - dt);

    const left = input.isDown('KeyA', 'ArrowLeft');
    const right = input.isDown('KeyD', 'ArrowRight');
    const duckKey = input.isDown('KeyS', 'ArrowDown');
    const jumpKey = input.isDown('Space');

    // --- duck: cube gets flatter, bottom stays put
    const wantDuck = duckKey && this.onGround;
    if (wantDuck && !this.ducking) {
      this.ducking = true;
      this.y += PHYS.playerH - PHYS.duckH;
      this.h = PHYS.duckH;
    } else if (!wantDuck && this.ducking) {
      const test = { x: this.x, y: this.y - (PHYS.playerH - PHYS.duckH), w: this.w, h: PHYS.playerH };
      if (!level.rectHitsSolid(test)) {
        this.ducking = false;
        this.y = test.y;
        this.h = PHYS.playerH;
      }
    }

    // --- horizontal movement with acceleration + friction
    const move = (right ? 1 : 0) - (left ? 1 : 0);
    const maxSp = PHYS.runSpeed * (this.ducking ? PHYS.duckSpeedScale : 1);
    if (move !== 0) {
      this.facing = move;
      const accel = this.onGround ? PHYS.groundAccel : PHYS.airAccel;
      const turning = Math.sign(this.vx) !== move && this.vx !== 0;
      this.vx += move * accel * (turning ? 1.8 : 1) * dt;
      this.vx = clamp(this.vx, -maxSp, maxSp);
    } else {
      const fr = (this.onGround ? PHYS.friction : PHYS.friction * 0.45) * dt;
      this.vx = Math.abs(this.vx) <= fr ? 0 : this.vx - Math.sign(this.vx) * fr;
    }
    if (Math.abs(this.vx) > maxSp) this.vx = Math.sign(this.vx) * Math.max(maxSp, Math.abs(this.vx) - PHYS.friction * dt);

    // --- jump: buffer + coyote time + variable height
    const gScale = level.inLowGrav(this.cx, this.cy) ? PHYS.lowGravScale : 1;
    if (input.wasPressed('Space')) this.jumpBuf = PHYS.jumpBuffer;
    else this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.coyote = this.onGround ? PHYS.coyoteTime : Math.max(0, this.coyote - dt);
    if (this.jumpBuf > 0 && this.coyote > 0 && !this.ducking) {
      const sup = this.superT > 0;
      this.vy = -(sup ? PHYS.superJumpVel : PHYS.jumpVel);
      this.onGround = false;
      this.groundPlat = null;
      this.coyote = 0;
      this.jumpBuf = 0;
      this.jumpHeld = true;
      this.sqx = 0.72;
      this.sqy = 1.32;
      game.audio.play(sup ? 'superjump' : 'jump');
      game.particles.burst(this.cx, this.y + this.h, 10, { speed: [30, 110], angle: -Math.PI / 2, spread: 1.4, life: [0.25, 0.5], size: [2, 4], color: sup ? ['#ffd23d', '#fff2a0'] : [level.T.accent, '#ffffff'], g: 200 });
    }
    if (this.jumpHeld && !jumpKey && this.vy < 0) {
      this.vy *= PHYS.jumpCut;
      this.jumpHeld = false;
    }
    if (this.vy >= 0) this.jumpHeld = false;

    this.vy += PHYS.gravity * gScale * dt;
    this.vy = Math.min(this.vy, PHYS.maxFall * (gScale < 1 ? 0.55 : 1));

    // --- ride moving platform (applied before own movement)
    if (this.groundPlat) {
      if (this.groundPlat.active) {
        this.x += this.groundPlat.dx;
        this.y += this.groundPlat.dy;
      }
      this.groundPlat = null;
    }

    const wasGround = this.onGround;
    this.moveX(this.vx * dt, level);
    this.moveY(this.vy * dt, level, game);

    // keep inside the world horizontally
    const b = game.bounds();
    if (this.x < b.x0) { this.x = b.x0; this.vx = Math.max(0, this.vx); }
    if (this.x + this.w > b.x1) { this.x = b.x1 - this.w; this.vx = Math.min(0, this.vx); }

    // --- landing feedback
    if (this.onGround && !wasGround) {
      const impact = clamp((this.y - this.fallStart) / 200, 0.2, 1);
      this.sqx = 1 + 0.35 * impact;
      this.sqy = 1 - 0.3 * impact;
      game.particles.burst(this.cx, this.y + this.h, Math.floor(6 + 10 * impact), { speed: [40, 140], angle: -Math.PI / 2, spread: 1.5, life: [0.3, 0.6], size: [2, 4], color: [level.T.accent, '#cccccc'], g: 300 });
      if (impact > 0.4) game.audio.play('land');
    }
    if (!this.onGround && wasGround) this.fallStart = this.y;
    if (!this.onGround && this.vy < 0) this.fallStart = this.y;

    // --- bounce pads
    if (this.vy >= 0) {
      for (const pad of level.bounces) {
        if (this.x + this.w > pad.x && this.x < pad.x + pad.w && this.y + this.h >= pad.y && this.y + this.h <= pad.y + pad.h + 4) {
          this.vy = -PHYS.bounceVel;
          this.onGround = false;
          this.jumpHeld = false;
          pad.anim = 1;
          this.sqx = 0.65;
          this.sqy = 1.45;
          game.audio.play('bounce');
          game.particles.burst(pad.x + pad.w / 2, pad.y, 24, { speed: [80, 260], angle: -Math.PI / 2, spread: 0.9, life: [0.3, 0.7], size: [2, 4], color: ['#ff4fd8', '#ffffff'], g: 300 });
          break;
        }
      }
    }

    // --- shooting
    if (input.isDown('KeyW') && this.shootCd <= 0 && game.bullets.length < 4) {
      this.shootCd = PHYS.shootCooldown;
      game.spawnBullet(this.facing > 0 ? this.x + this.w : this.x - 10, this.y + this.h * 0.45, this.facing);
    }

    // --- running trail (longer when faster)
    const spd = Math.abs(this.vx);
    if (this.onGround && spd > 120 && Math.random() < spd / 300) {
      game.particles.add({ x: this.cx - this.facing * 12, y: this.y + this.h - 3, vx: -this.facing * rand(10, 40), vy: rand(-30, -5), life: 0.2 + 0.5 * (spd / PHYS.runSpeed), size: rand(2, 4), color: this.glowColor(), glow: true, drag: 2 });
    }

    // --- idle / yawn
    const anyInput = left || right || duckKey || jumpKey || input.isDown('KeyW');
    if (!anyInput && this.onGround && spd < 5) {
      this.idleT += dt;
      if (this.idleT > 5 && this.yawnT <= 0) {
        this.yawnT = 1.8;
        this.idleT = 0;
        game.audio.play('yawn');
      }
    } else {
      this.idleT = 0;
      this.yawnT = 0;
    }
    this.yawnT = Math.max(0, this.yawnT - dt);

    // squash recovery + running bob
    this.sqx = lerp(this.sqx, 1, 1 - Math.exp(-12 * dt));
    this.sqy = lerp(this.sqy, 1, 1 - Math.exp(-12 * dt));
  }

  moveX(dx, level) {
    const steps = Math.max(1, Math.ceil(Math.abs(dx) / 6));
    const sx = dx / steps;
    for (let i = 0; i < steps; i++) {
      this.x += sx;
      for (const s of level.solidsNear(this.x - 8, this.x + this.w + 8)) {
        if (overlap(this, s)) {
          if (sx > 0) this.x = s.x - this.w;
          else this.x = s.x + s.w;
          this.vx = 0;
          return;
        }
      }
    }
  }

  moveY(dy, level, game) {
    const bottom0 = this.y + this.h;
    this.onGround = false;
    const steps = Math.max(1, Math.ceil(Math.abs(dy) / 6));
    const sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      this.y += sy;
      for (const s of level.solidsNear(this.x - 8, this.x + this.w + 8)) {
        if (overlap(this, s)) {
          if (sy > 0) {
            this.y = s.y - this.h;
            this.onGround = true;
          } else {
            this.y = s.y + s.h;
            game.audio.play('land');
          }
          this.vy = 0;
          return;
        }
      }
      if (sy > 0) {
        for (const p of level.plats) {
          if (!p.active) continue;
          if (this.x + this.w <= p.x + 2 || this.x >= p.x + p.w - 2) continue;
          const top = p.y;
          if (bottom0 <= Math.max(top, p.prevY) + 2 && this.y + this.h >= top) {
            this.y = top - this.h;
            this.vy = 0;
            this.onGround = true;
            this.groundPlat = p.kind === 'mover' ? p : null;
            if (p.kind === 'crumble' && p.timer <= 0) p.timer = 0.6;
            return;
          }
        }
      }
    }
  }

  glowColor() {
    if (this.superT > 0) return '#ffd23d';
    if (this.shieldT > 0) return '#4fc3ff';
    return this.skin.glow;
  }

  expression() {
    if (this.yawnT > 0) return 'yawn';
    if (this.scared) return 'scared';
    if (this.ducking) return 'squint';
    if (!this.onGround) return 'surprised';
    if (Math.abs(this.vx) > 40) return 'happy';
    return 'neutral';
  }

  draw(ctx, camX, camY, t, reduceFlash) {
    if (!this.visible) return;
    const glow = this.glowColor();
    const bw = this.w * this.sqx * this.scale;
    const bh = this.h * this.sqy * this.scale;
    const bx = this.cx - camX;
    const by = this.y + this.h - camY;   // feet
    // aura
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 + 0.2 * Math.sin(t * 4);
    const ar = 34 + 4 * Math.sin(t * 3);
    ctx.drawImage(glowSprite(glow, 32), bx - ar, by - bh / 2 - ar, ar * 2, ar * 2);
    ctx.restore();

    ctx.save();
    ctx.translate(bx, by - bh / 2);
    if (this.spin) ctx.rotate(this.spin);
    // body
    const grad = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.18, this.skin.body);
    grad.addColorStop(1, this.skin.dark);
    ctx.fillStyle = grad;
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 6);
    ctx.fill();
    ctx.strokeStyle = glow;
    ctx.lineWidth = 2;
    ctx.stroke();

    // face
    const ex = this.expression();
    const lx = this.lookX * 2.5;
    const ly = this.lookY * 2;
    const eyeY = -bh * 0.12;
    const eyeH = this.blink > 0 || ex === 'squint' ? 1.2 : ex === 'surprised' || ex === 'scared' ? 5.5 : 4.5;
    for (const sgn of [-1, 1]) {
      const exx = sgn * bw * 0.2 + lx * 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(exx, eyeY + ly * 0.4, 3.6, ex === 'yawn' ? 1.2 : eyeH, 0, 0, TAU);
      ctx.fill();
      if (eyeH > 2 && ex !== 'yawn') {
        ctx.fillStyle = '#10142a';
        ctx.beginPath();
        ctx.arc(exx + lx * 0.6, eyeY + ly * 0.7, ex === 'scared' ? 1.3 : 2, 0, TAU);
        ctx.fill();
      }
    }
    // mouth
    ctx.strokeStyle = '#10142a';
    ctx.fillStyle = '#10142a';
    ctx.lineWidth = 1.6;
    const my = bh * 0.2;
    ctx.beginPath();
    if (ex === 'happy') { ctx.arc(lx * 0.3, my - 2, 4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke(); }
    else if (ex === 'surprised') { ctx.ellipse(lx * 0.3, my, 2.2, 3, 0, 0, TAU); ctx.fill(); }
    else if (ex === 'scared') { ctx.moveTo(-5, my + 1); ctx.lineTo(-2.5, my - 1); ctx.lineTo(0, my + 1); ctx.lineTo(2.5, my - 1); ctx.lineTo(5, my + 1); ctx.stroke(); }
    else if (ex === 'squint') { ctx.moveTo(-3, my); ctx.lineTo(3, my); ctx.stroke(); }
    else if (ex === 'yawn') { const o = 2 + 3 * Math.sin(Math.min(1, (1.8 - this.yawnT) / 0.9) * Math.PI); ctx.ellipse(0, my, 3, o, 0, 0, TAU); ctx.fill(); }
    else { ctx.arc(lx * 0.3, my - 3, 3, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke(); }

    // party hat (easter egg)
    if (this.skin.hat) {
      ctx.fillStyle = '#ffd23d';
      ctx.beginPath();
      ctx.moveTo(-7, -bh / 2 + 1);
      ctx.lineTo(0, -bh / 2 - 15);
      ctx.lineTo(7, -bh / 2 + 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ff3d7f';
      ctx.fillRect(-5, -bh / 2 - 5, 10, 2);
      ctx.beginPath();
      ctx.arc(0, -bh / 2 - 16, 3, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // shield bubble: flashes faster in the last second
    if (this.shieldT > 0) {
      const last = this.shieldT < 1;
      const freq = last ? 18 : 4;
      const on = !last || reduceFlash || Math.sin(t * freq) > -0.2;
      if (on) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const r = 28 + Math.sin(t * 6) * 1.5;
        const cyb = by - bh / 2;
        const g = ctx.createRadialGradient(bx, cyb, r * 0.6, bx, cyb, r);
        g.addColorStop(0, 'rgba(79,195,255,0.02)');
        g.addColorStop(0.8, 'rgba(79,195,255,0.25)');
        g.addColorStop(1, 'rgba(160,230,255,0.6)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(bx, cyb, r, 0, TAU);
        ctx.fill();
        // shimmer highlight
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, cyb, r - 4, t * 3, t * 3 + 0.9);
        ctx.stroke();
        // countdown ring
        ctx.strokeStyle = '#4fc3ff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(bx, cyb, r + 5, -Math.PI / 2, -Math.PI / 2 + TAU * (this.shieldT / PHYS.shieldTime));
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /** Breaks the cube into hundreds of glowing particles. */
  dissolve(game) {
    const cols = [this.skin.body, this.skin.glow, '#ffffff', this.skin.dark];
    const n = 15;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const px = this.x + (i + 0.5) * (this.w / n);
        const py = this.y + (j + 0.5) * (this.h / n);
        const a = Math.atan2(py - this.cy, px - this.cx) + rand(-0.4, 0.4);
        const sp = rand(15, 90);
        game.particles.add({ x: px, y: py, vx: Math.cos(a) * sp + rand(-10, 10), vy: Math.sin(a) * sp - rand(10, 50), life: rand(1.0, 2.2), size: rand(1.5, 3), color: pick(cols), g: -25, drag: 0.8, glow: Math.random() < 0.4 });
      }
    }
    game.particles.burst(this.cx, this.cy, 80, { speed: [5, 60], life: [1.2, 2.4], size: [1, 2.5], color: [this.skin.glow, '#ffffff'], g: -30, drag: 0.6 });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 12. Enemies + projectiles
// ---------------------------------------------------------------------------
const ENEMY_COLORS = {
  walker: ['#9dff5a', '#3c8f1a', '#e8ffd0'],
  shooter: ['#ff5a7a', '#8f1a33', '#ffd0dc'],
  flyer: ['#c08bff', '#5a2a9f', '#efe0ff'],
};

class Enemy {
  constructor(spec) {
    const [type, tx, row, range] = spec;
    this.type = type;
    this.t = Math.random() * 10;
    this.dead = false;
    this.cool = 1.5 + Math.random();
    this.charge = 0;
    this.blink = 0;
    if (type === 'walker') {
      this.w = 28; this.h = 24; this.speed = 55;
    } else if (type === 'shooter') {
      this.w = 30; this.h = 32; this.speed = 32;
    } else {
      this.w = 36; this.h = 24; this.speed = 0;
      this.range = (range || 4) * TILE;
      this.x0 = tx * TILE + TILE / 2;
      this.y0 = row * TILE + TILE / 2;
    }
    this.x = tx * TILE + (TILE - this.w) / 2;
    this.y = type === 'flyer' ? this.y0 - this.h / 2 : row * TILE - this.h;
    this.vx = -this.speed;
    this.vy = 0;
    this.dir = -1;
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }

  update(dt, game) {
    this.t += dt;
    const level = game.level;
    const pl = game.player;
    if (this.type === 'flyer') {
      this.x = this.x0 + Math.sin(this.t * 0.8) * this.range - this.w / 2;
      this.y = this.y0 + Math.sin(this.t * 2.1) * 10 - this.h / 2;
      this.dir = Math.cos(this.t * 0.8) >= 0 ? 1 : -1;
      this.cool -= dt;
      if (this.charge > 0) {
        this.charge -= dt;
        if (this.charge <= 0) {
          game.spawnStone(this.cx, this.y + this.h);
          this.cool = 2.2;
        }
      } else if (this.cool <= 0 && !pl.dead && Math.abs(pl.cx - this.cx) < 70 && pl.cy > this.cy && game.onScreen(this.cx, this.cy, 0)) {
        this.charge = 0.4;
        game.audio.play('warn');
      }
      return;
    }
    // ground walkers / shooters
    let moving = true;
    if (this.type === 'shooter') {
      const dx = pl.cx - this.cx;
      const near = !pl.dead && Math.abs(dx) < 460 && Math.abs(pl.cy - this.cy) < 150 && game.onScreen(this.cx, this.cy, -20);
      if (near) {
        this.dir = dx >= 0 ? 1 : -1;
        this.cool -= dt;
        if (this.charge > 0) {
          moving = false;
          this.charge -= dt;
          if (this.charge <= 0) {
            game.spawnFireball(this.dir > 0 ? this.x + this.w : this.x, this.y + this.h - PHYS.fireballHeight, this.dir);
            this.cool = 2.4;
          }
        } else if (this.cool <= 0) {
          this.charge = 0.55;
          moving = false;
        }
      }
    }
    if (moving) {
      const vx = this.dir * this.speed;
      const nx = this.x + vx * dt;
      const footX = this.dir > 0 ? nx + this.w + 1 : nx - 1;
      const wall = level.rectHitsSolid({ x: nx, y: this.y, w: this.w, h: this.h - 1 });
      const floor = level.surfaceBelow(footX, this.y + this.h - 1);
      if (wall || !floor) this.dir = -this.dir;
      else this.x = nx;
    }
  }

  draw(ctx, camX, camY, t) {
    const x = this.x - camX;
    const y = this.y - camY;
    const [c1, c2, c3] = ENEMY_COLORS[this.type];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45;
    ctx.drawImage(glowSprite(c1, 24), x + this.w / 2 - 28, y + this.h / 2 - 28, 56, 56);
    ctx.restore();
    if (this.type === 'walker') {
      // little one-eyed space blob with antennae
      const bob = Math.abs(Math.sin(this.t * 9)) * 2;
      ctx.fillStyle = c2;
      ctx.fillRect(x + 4, y + this.h - 5, 6, 5);
      ctx.fillRect(x + this.w - 10, y + this.h - 5, 6, 5);
      const g = ctx.createLinearGradient(0, y, 0, y + this.h);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x + this.w / 2, y + this.h / 2 + 2 - bob, this.w / 2, this.h / 2 - 1, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = c1;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 9, y + 4 - bob); ctx.lineTo(x + 5, y - 6 - bob);
      ctx.moveTo(x + this.w - 9, y + 4 - bob); ctx.lineTo(x + this.w - 5, y - 6 - bob);
      ctx.stroke();
      ctx.fillStyle = c3;
      ctx.fillRect(x + 3, y - 9 - bob, 4, 4);
      ctx.fillRect(x + this.w - 7, y - 9 - bob, 4, 4);
      // eye
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + this.w / 2 + this.dir * 3, y + this.h / 2 - bob, 6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#200';
      ctx.beginPath();
      ctx.arc(x + this.w / 2 + this.dir * 5, y + this.h / 2 - bob, 2.5, 0, TAU);
      ctx.fill();
      // fangs
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + this.w / 2 - 4, y + this.h - 6 - bob, 2, 3);
      ctx.fillRect(x + this.w / 2 + 2, y + this.h - 6 - bob, 2, 3);
    } else if (this.type === 'shooter') {
      // squid-like turret creature with a glowing mouth
      const sway = Math.sin(this.t * 3) * 2;
      ctx.fillStyle = c2;
      for (let i = 0; i < 4; i++) {
        const lx = x + 4 + i * 7;
        ctx.fillRect(lx, y + this.h - 8 + Math.sin(this.t * 8 + i) * 2, 4, 8);
      }
      const g = ctx.createLinearGradient(0, y, 0, y + this.h);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x + this.w / 2 + sway, y);
      ctx.quadraticCurveTo(x + this.w + 4, y + 6, x + this.w, y + this.h - 6);
      ctx.lineTo(x, y + this.h - 6);
      ctx.quadraticCurveTo(x - 4, y + 6, x + this.w / 2 + sway, y);
      ctx.fill();
      // eyes
      ctx.fillStyle = '#fff';
      ctx.fillRect(x + this.w / 2 - 8 + this.dir * 2, y + 9, 5, 5);
      ctx.fillRect(x + this.w / 2 + 3 + this.dir * 2, y + 9, 5, 5);
      ctx.fillStyle = '#300';
      ctx.fillRect(x + this.w / 2 - 6 + this.dir * 3, y + 11, 2, 2);
      ctx.fillRect(x + this.w / 2 + 5 + this.dir * 3, y + 11, 2, 2);
      // mouth glows while charging
      const mx = this.dir > 0 ? x + this.w - 4 : x + 4;
      const my = y + this.h - PHYS.fireballHeight;
      const ch = this.charge > 0 ? 1 - this.charge / 0.55 : 0;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.4 + ch * 0.6;
      ctx.drawImage(glowSprite('#ff8a3d', 16), mx - 8 - ch * 6, my - 8 - ch * 6, 16 + ch * 12, 16 + ch * 12);
      ctx.restore();
      ctx.fillStyle = '#2a0008';
      ctx.beginPath();
      ctx.arc(mx, my, 3.5, 0, TAU);
      ctx.fill();
    } else {
      // flying saucer-jelly with a dangling rock
      ctx.save();
      ctx.translate(x + this.w / 2, y + this.h / 2);
      ctx.rotate(Math.sin(this.t * 2) * 0.1);
      ctx.fillStyle = c2;
      ctx.beginPath();
      ctx.ellipse(0, 4, this.w / 2, 7, 0, 0, TAU);
      ctx.fill();
      const g = ctx.createLinearGradient(0, -12, 0, 4);
      g.addColorStop(0, c3);
      g.addColorStop(1, c1);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, -1, this.w / 3, 11, 0, Math.PI, TAU);
      ctx.fill();
      // eyes
      ctx.fillStyle = '#1a0533';
      ctx.fillRect(-6, -6, 3, 4);
      ctx.fillRect(3, -6, 3, 4);
      // blinking rim lights
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = Math.floor(this.t * 6 + i) % 2 ? '#ffffff' : c1;
        ctx.fillRect(-14 + i * 7, 5, 3, 3);
      }
      // charging rock
      if (this.charge > 0) {
        ctx.fillStyle = '#ffcc66';
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 40);
        ctx.fillRect(-5, 10, 10, 8);
      }
      ctx.restore();
    }
  }
}

class Bullet {
  constructor(x, y, dir) {
    this.x = x; this.y = y; this.dir = dir; this.r = 6; this.life = PHYS.bulletLife; this.dead = false;
  }
  update(dt, game) {
    this.life -= dt;
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      this.x += (this.dir * PHYS.bulletSpeed * dt) / steps;
      if (game.level.pointSolid(this.x, this.y)) {
        this.dead = true;
        game.particles.burst(this.x, this.y, 8, { speed: [40, 140], life: [0.2, 0.4], size: [2, 3], color: ['#9ffcff', '#ffffff'] });
        return;
      }
    }
    if (this.life <= 0) this.dead = true;
    if (Math.random() < 0.9) game.particles.add({ x: this.x - this.dir * 6, y: this.y + rand(-2, 2), vx: -this.dir * 30, vy: rand(-10, 10), life: 0.25, size: rand(2, 4), color: '#7ff6ff', glow: false });
  }
  draw(ctx, camX, camY) {
    const x = this.x - camX;
    const y = this.y - camY;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(glowSprite('#38e1ff', 16), x - 14, y - 14, 28, 28);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

class Fireball {
  constructor(x, y, vx, vy, r) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy || 0; this.r = r || PHYS.fireballRadius; this.dead = false; this.life = 6; this.t = 0;
  }
  update(dt, game) {
    this.t += dt;
    this.life -= dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.life <= 0 || game.level.pointSolid(this.x, this.y)) {
      this.dead = true;
      game.particles.burst(this.x, this.y, 6, { speed: [30, 100], life: [0.2, 0.4], size: [2, 3], color: ['#ff8a3d', '#ffd23d'] });
    }
    if (Math.random() < 0.7) game.particles.add({ x: this.x, y: this.y, vx: rand(-20, 20), vy: rand(-30, 0), life: 0.3, size: rand(2, 4), color: pick(['#ff5a1f', '#ffb02e', '#ff2d55']), glow: false });
  }
  draw(ctx, camX, camY, t) {
    const x = this.x - camX;
    const y = this.y - camY;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const s = this.r * 4 + Math.sin(t * 30) * 2;
    ctx.drawImage(glowSprite('#ff6a1f', 16), x - s, y - s, s * 2, s * 2);
    ctx.fillStyle = '#fff2b0';
    ctx.beginPath();
    ctx.arc(x, y, this.r * 0.8, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

class Stone {
  constructor(x, y) {
    this.x = x - 7; this.y = y; this.w = 14; this.h = 14; this.vy = 60; this.dead = false; this.rot = 0;
  }
  get cx() { return this.x + this.w / 2; }
  update(dt, game) {
    this.vy = Math.min(this.vy + PHYS.stoneGravity * dt, 700);
    this.rot += dt * 5;
    const steps = Math.max(1, Math.ceil((this.vy * dt) / 6));
    for (let i = 0; i < steps; i++) {
      this.y += (this.vy * dt) / steps;
      const hitPlat = game.level.plats.some((p) => p.active && this.cx > p.x && this.cx < p.x + p.w && this.y + this.h >= p.y && this.y + this.h <= p.y + p.h + 8);
      if (hitPlat || game.level.rectHitsSolid(this) || this.y > game.level.heightPx + 40) {
        this.dead = true;
        game.particles.burst(this.cx, this.y + this.h, 14, { speed: [40, 160], angle: -Math.PI / 2, spread: 1.3, life: [0.3, 0.6], size: [2, 4], color: ['#a08a70', '#ffcc66', '#555'], g: 600, glow: false });
        if (game.onScreen(this.cx, this.y, 0)) game.audio.play('stone');
        return;
      }
    }
  }
  draw(ctx, camX, camY) {
    drawRock(ctx, this.cx - camX, this.y + this.h / 2 - camY, 8, [1, 0.8, 1, 0.9, 1, 0.85, 0.95], this.rot, '#8a7560', '#ffcc66');
  }
}

// ---------------------------------------------------------------------------
// 13. Boss — the Nebula Jelly (giant space jellyfish with one big eye)
// ---------------------------------------------------------------------------
const BOSS_HP = 10;

class Boss {
  constructor(level) {
    this.x0 = level.boss.x0;
    this.x1 = level.boss.x1;
    this.groundY = level.boss.groundY;
    this.reset();
  }

  reset() {
    this.mid = (this.x0 + this.x1) / 2;
    this.cx = this.mid;
    this.cy = this.groundY - 520;
    this.r = 54;
    this.hp = BOSS_HP;
    this.state = 'waiting';      // waiting → intro → fight → dying → dead
    this.t = 0;
    this.st = 0;                 // time in current state
    this.flash = 0;
    this.attackT = 2.0;
    this.attackIdx = 0;
    this.current = null;
    this.warnings = [];
    this.eyeX = 0;
    this.eyeY = 0;
    this.deathT = 0;
  }

  get active() { return this.state === 'intro' || this.state === 'fight'; }
  get vulnerable() { return this.state === 'fight'; }
  get dead() { return this.state === 'dead'; }

  update(dt, game) {
    this.t += dt;
    this.st += dt;
    this.flash = Math.max(0, this.flash - dt);
    this.iframes = Math.max(0, (this.iframes || 0) - dt);
    const pl = game.player;
    if (this.state === 'waiting') {
      if (!pl.dead && pl.x > this.x0 + 3 * TILE && pl.x < this.x1) {
        this.state = 'intro';
        this.st = 0;
        game.bossIntro();
      }
      return;
    }
    if (this.state === 'intro') {
      this.cy = lerp(this.groundY - 520, this.groundY - 260, clamp(this.st / 2, 0, 1));
      if (this.st >= 2.2) { this.state = 'fight'; this.st = 0; }
      return;
    }
    if (this.state === 'dying') {
      this.deathT += dt;
      this.cy += Math.sin(this.t * 30) * 0.8;
      if (Math.random() < 0.35) {
        const ex = this.cx + rand(-60, 60);
        const ey = this.cy + rand(-50, 50);
        game.particles.burst(ex, ey, 30, { speed: [60, 260], life: [0.4, 0.9], size: [2, 5], color: ['#ff8a3d', '#ffd23d', '#ffffff', '#3dffd0'] });
        game.audio.play('kill');
        game.camera.shake(5, 0.2);
      }
      if (this.deathT > 2.2) {
        this.state = 'dead';
        game.bossDefeated(this.cx, this.cy);
      }
      return;
    }
    if (this.state !== 'fight') return;

    // movement: lazy figure-eight that dips low enough to be hit from the platforms or a jump
    const enraged = this.hp <= BOSS_HP / 2;
    const half = (this.x1 - this.x0) / 2 - 120;
    const sp = enraged ? 0.62 : 0.48;
    const tx = this.mid + Math.sin(this.t * sp) * half;
    const ty = this.groundY - 215 + Math.sin(this.t * sp * 2) * 75;
    this.cx = lerp(this.cx, tx, 1 - Math.exp(-3 * dt));
    this.cy = lerp(this.cy, ty, 1 - Math.exp(-3 * dt));
    const dx = pl.cx - this.cx;
    const dy = pl.cy - this.cy;
    const len = Math.hypot(dx, dy) || 1;
    this.eyeX = lerp(this.eyeX, dx / len, 0.1);
    this.eyeY = lerp(this.eyeY, dy / len, 0.1);

    // attacks
    if (this.current) {
      this.current.t += dt;
      this.runAttack(this.current, dt, game, enraged);
    } else {
      this.attackT -= dt;
      if (this.attackT <= 0) {
        const seq = ['fan', 'sweep', 'rain', 'fan', 'rain', 'sweep'];
        this.current = { type: seq[this.attackIdx % seq.length], t: 0, n: 0 };
        this.attackIdx++;
      }
    }
    for (const w of this.warnings) {
      w.t -= dt;
      if (w.t <= 0 && !w.done) {
        w.done = true;
        game.spawnStone(w.x, this.groundY - 440);
      }
    }
    this.warnings = this.warnings.filter((w) => w.t > -0.6);
  }

  runAttack(a, dt, game, enraged) {
    const done = () => { this.current = null; this.attackT = enraged ? 1.0 : 1.5; };
    if (a.type === 'fan') {
      // telegraph 0.7 s, then a downward fan of slow fireballs (gaps are wide enough to stand in)
      if (a.t > 0.7 && a.n === 0) {
        a.n = 1;
        const count = enraged ? 7 : 5;
        for (let i = 0; i < count; i++) {
          const ang = Math.PI * (0.18 + (0.64 * i) / (count - 1));
          game.fireballs.push(new Fireball(this.cx, this.cy + 30, Math.cos(ang) * 150, Math.sin(ang) * 150, 7));
        }
        game.audio.play('fireball');
      }
      if (a.t > 1.2) done();
    } else if (a.type === 'sweep') {
      // fireballs skimming the floor at head height: duck or jump
      const gap = enraged ? 0.75 : 0.95;
      const shots = 3;
      if (a.n < shots && a.t > 0.5 + a.n * gap) {
        const fromLeft = game.player.cx > this.mid;
        const x = fromLeft ? this.x0 + 8 : this.x1 - 8;
        game.fireballs.push(new Fireball(x, this.groundY - PHYS.fireballHeight, fromLeft ? PHYS.fireballSpeed * 1.1 : -PHYS.fireballSpeed * 1.1, 0, PHYS.fireballRadius));
        game.audio.play('fireball');
        a.n++;
      }
      if (a.t > 0.6 + shots * gap) done();
    } else if (a.type === 'rain') {
      // stones with a visible warning marker on the floor
      if (a.n === 0) {
        a.n = 1;
        const count = enraged ? 6 : 4;
        const used = [];
        for (let i = 0; i < count; i++) {
          let x;
          let tries = 0;
          do { x = rand(this.x0 + 40, this.x1 - 40); tries++; } while (tries < 20 && used.some((u) => Math.abs(u - x) < 70));
          used.push(x);
          this.warnings.push({ x, t: 0.9 + i * 0.12, done: false });
        }
        game.audio.play('warn');
      }
      if (a.t > 1.8) done();
    }
  }

  /** Circle body hitbox (tentacles are decoration). */
  hits(rect) {
    const nx = clamp(this.cx, rect.x, rect.x + rect.w);
    const ny = clamp(this.cy, rect.y, rect.y + rect.h);
    return dist2(nx, ny, this.cx, this.cy) < (this.r * 0.82) * (this.r * 0.82);
  }

  hitByBullet(b) {
    return dist2(b.x, b.y, this.cx, this.cy) < (this.r + 4) * (this.r + 4);
  }

  damage(game) {
    if (!this.vulnerable || this.iframes > 0) return;
    this.hp--;
    this.flash = 0.15;
    this.iframes = 0.3;
    game.audio.play('bosshit');
    game.camera.shake(4, 0.15);
    game.particles.burst(this.cx, this.cy, 20, { speed: [80, 220], life: [0.3, 0.6], size: [2, 4], color: ['#ffffff', '#3dffd0', '#5ae0ff'] });
    if (this.hp <= 0) {
      this.state = 'dying';
      this.deathT = 0;
      this.current = null;
      this.warnings = [];
      game.slowMo(0.6);
    }
  }

  draw(ctx, camX, camY, t, reduceFlash) {
    if (this.state === 'waiting' || this.state === 'dead') return;
    const x = this.cx - camX;
    const y = this.cy - camY;
    const r = this.r;
    const flash = this.flash > 0 && !reduceFlash;
    // warnings on the floor
    for (const w of this.warnings) {
      if (w.done) continue;
      const a = 0.4 + 0.4 * Math.sin(t * 20);
      ctx.fillStyle = 'rgba(255,60,90,' + a + ')';
      ctx.fillRect(w.x - camX - 14, this.groundY - camY - 4, 28, 4);
      ctx.fillStyle = 'rgba(255,60,90,' + a * 0.25 + ')';
      ctx.fillRect(w.x - camX - 10, this.groundY - camY - 440, 20, 436);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6;
    ctx.drawImage(glowSprite('#3dffd0', 64), x - r * 2.4, y - r * 2.4, r * 4.8, r * 4.8);
    ctx.restore();
    // tentacles
    ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const bx = x - r * 0.8 + (i * r * 1.6) / 7;
      ctx.strokeStyle = flash ? '#ffffff' : hexA(i % 2 ? '#3dffd0' : '#c08bff', 0.75);
      ctx.lineWidth = 5 - (i % 3);
      ctx.beginPath();
      ctx.moveTo(bx, y + r * 0.45);
      for (let k = 1; k <= 6; k++) {
        ctx.lineTo(bx + Math.sin(t * 3 + i + k * 0.8) * (4 + k * 2), y + r * 0.45 + k * 14);
      }
      ctx.stroke();
    }
    // bell
    const g = ctx.createRadialGradient(x, y - r * 0.3, r * 0.1, x, y, r * 1.1);
    g.addColorStop(0, flash ? '#ffffff' : 'rgba(200,255,245,0.95)');
    g.addColorStop(0.5, flash ? '#ffffff' : 'rgba(61,255,208,0.7)');
    g.addColorStop(1, flash ? '#ffffff' : 'rgba(90,60,200,0.55)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.1, r, 0, Math.PI, TAU);
    for (let k = 0; k <= 8; k++) {
      const px = x + r * 1.1 - (k * r * 2.2) / 8;
      ctx.lineTo(px, y + r * 0.45 + (k % 2 ? 8 : 0) + Math.sin(t * 4 + k) * 3);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // spots
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (let k = 0; k < 6; k++) {
      ctx.beginPath();
      ctx.arc(x + Math.cos(k * 1.7) * r * 0.7, y - r * 0.5 + Math.sin(k * 2.3) * r * 0.25, 3 + (k % 3), 0, TAU);
      ctx.fill();
    }
    // the big eye
    const ex = x;
    const ey = y - r * 0.1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, ey, 22, 18, 0, 0, TAU);
    ctx.fill();
    const charging = this.current && this.current.t < 0.7;
    ctx.fillStyle = charging ? '#ff2d55' : '#7b2ff7';
    ctx.beginPath();
    ctx.arc(ex + this.eyeX * 9, ey + this.eyeY * 7, 10, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#05030a';
    ctx.beginPath();
    ctx.arc(ex + this.eyeX * 11, ey + this.eyeY * 9, 4.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ex + this.eyeX * 9 - 5, ey + this.eyeY * 7 - 6, 3, 3);
    // angry brow when enraged
    if (this.hp <= BOSS_HP / 2) {
      ctx.strokeStyle = '#2a0b4a';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ex - 24, ey - 24);
      ctx.lineTo(ex + 24, ey - 16);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// 14. UI — HUD and all screens
// ---------------------------------------------------------------------------
const FONT = '"Trebuchet MS", "Segoe UI", Verdana, sans-serif';

function text(ctx, str, x, y, size, color, align, glow, weight) {
  ctx.font = (weight || 'bold') + ' ' + size + 'px ' + FONT;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  if (glow) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = glow;
    for (const [ox, oy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) ctx.fillText(str, x + ox, y + oy);
    ctx.restore();
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

const UI = {
  hud(ctx, g) {
    const p = g.player;
    const lv = g.level;
    // panel
    ctx.fillStyle = 'rgba(5,6,20,0.55)';
    roundRect(ctx, 12, 10, 230, 62, 10);
    ctx.fill();
    // coins with pop
    const pop = 1 + g.coinPop * 0.35;
    ctx.save();
    ctx.translate(36, 30);
    ctx.scale(pop, pop);
    drawCoin(ctx, 0, 0, g.time, 1);
    ctx.restore();
    text(ctx, g.stats.coins + ' / ' + lv.coinTotal, 56, 31, 20 * (1 + g.coinPop * 0.15), '#ffe68a', 'left', '#ffb000');
    text(ctx, 'SCORE ' + String(Math.floor(g.score)).padStart(6, '0'), 24, 56, 14, '#cfd6ff');
    text(ctx, '✖ ' + g.stats.deaths, 232, 56, 13, 'rgba(255,255,255,0.6)', 'right');
    // stars collected in this run
    if (lv.secret.star.taken) drawStar(ctx, 222, 30, 9, g.time, false);

    // combo
    if (g.combo >= 2 && g.comboT > 0) {
      const s = 1 + g.comboPop * 0.5;
      ctx.save();
      ctx.translate(300, 34);
      ctx.scale(s, s);
      text(ctx, 'x' + Math.min(g.combo, PHYS.comboMax), 0, 0, 30, '#ff7ae0', 'center', '#ff2dbf');
      ctx.restore();
      text(ctx, 'COMBO', 300, 58, 11, '#ffb8ef', 'center');
      ctx.fillStyle = 'rgba(255,122,224,0.8)';
      ctx.fillRect(274, 66, 52 * (g.comboT / PHYS.comboWindow), 3);
    }

    // level name + progress bar
    const cx = VIEW_W / 2;
    text(ctx, 'LEVEL ' + (lv.index + 1) + ' · ' + lv.data.name.toUpperCase(), cx, 20, 14, '#ffffff', 'center', lv.T.edge);
    const bw = 260;
    const bx = cx - bw / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    roundRect(ctx, bx, 34, bw, 8, 4);
    ctx.fill();
    const prog = g.inRoom ? g.roomProgress : clamp((p.cx - lv.start.x) / (lv.goal.x - lv.start.x), 0, 1);
    ctx.fillStyle = lv.T.edge;
    roundRect(ctx, bx, 34, Math.max(8, bw * prog), 8, 4);
    ctx.fill();
    for (const c of lv.checkpoints) {
      const f = clamp((c.x - lv.start.x) / (lv.goal.x - lv.start.x), 0, 1);
      ctx.fillStyle = c.active ? '#3dffb0' : 'rgba(255,255,255,0.5)';
      ctx.fillRect(bx + bw * f - 1, 31, 2, 14);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + bw * prog - 4, 33, 8, 10);
    drawStar(ctx, bx + bw + 12, 38, 7, g.time, false);
    if (g.inRoom) text(ctx, '✦ SECRET ROOM ✦', cx, 62, 14, '#fff27a', 'center', '#ffb000');

    // power-ups (top right)
    let x = VIEW_W - 40;
    const ring = (type, frac, label) => {
      ctx.fillStyle = 'rgba(5,6,20,0.6)';
      ctx.beginPath();
      ctx.arc(x, 34, 20, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = ITEM_COLORS[type];
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, 34, 20, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.stroke();
      drawItemIcon(ctx, type, x, 34, 1);
      text(ctx, label, x, 64, 11, '#ffffff', 'center');
      x -= 54;
    };
    if (p.shieldT > 0) ring('shield', p.shieldT / PHYS.shieldTime, p.shieldT.toFixed(1) + 's');
    if (p.superT > 0) ring(g.superType, p.superT / p.superMax, Math.ceil(p.superT) + 's');

    // boss bar
    if (g.boss && (g.boss.active || g.boss.state === 'dying')) {
      const w = 420;
      const x0 = VIEW_W / 2 - w / 2;
      const y0 = VIEW_H - 44;
      text(ctx, 'NEBULA JELLY', VIEW_W / 2, y0 - 14, 15, '#a6fff0', 'center', '#3dffd0');
      ctx.fillStyle = 'rgba(5,6,20,0.7)';
      roundRect(ctx, x0 - 4, y0 - 4, w + 8, 20, 6);
      ctx.fill();
      const f = g.boss.hp / BOSS_HP;
      const grad = ctx.createLinearGradient(x0, 0, x0 + w, 0);
      grad.addColorStop(0, '#ff2d55');
      grad.addColorStop(1, '#3dffd0');
      ctx.fillStyle = grad;
      roundRect(ctx, x0, y0, Math.max(0, w * f), 12, 4);
      ctx.fill();
      for (let i = 1; i < BOSS_HP; i++) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x0 + (w * i) / BOSS_HP - 1, y0, 2, 12);
      }
    }
  },

  menu(ctx, items, index, y0, t, opts) {
    const o = opts || {};
    items.forEach((it, i) => {
      const sel = i === index;
      const y = y0 + i * (o.gap || 44);
      const label = typeof it === 'string' ? it : it.label;
      if (sel) {
        const w = 300;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        roundRect(ctx, VIEW_W / 2 - w / 2, y - 18, w, 36, 10);
        ctx.fill();
        ctx.strokeStyle = 'rgba(160,220,255,' + (0.5 + 0.3 * Math.sin(t * 6)) + ')';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      text(ctx, (sel ? '▸ ' : '') + label + (sel ? ' ◂' : ''), VIEW_W / 2, y, sel ? 22 : 19, sel ? '#ffffff' : 'rgba(210,220,255,0.65)', 'center', sel ? '#38e1ff' : null);
    });
  },

  dim(ctx, a) {
    ctx.fillStyle = 'rgba(3,3,12,' + a + ')';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  },

  title(ctx, g) {
    const t = g.realTime;
    UI.dim(ctx, 0.25);
    // logo
    const wob = Math.sin(t * 1.5) * 4;
    text(ctx, 'COSMO CUBE', VIEW_W / 2, 130 + wob, 76, '#ffffff', 'center', '#38e1ff', '900');
    text(ctx, 'A GIANA-STYLE SPACE ADVENTURE', VIEW_W / 2, 186, 16, '#c9a6ff', 'center');
    // a big version of the hero bouncing
    const p = g.titleCube;
    p.x = VIEW_W / 2 - 13 + Math.sin(t * 0.8) * 160;
    const hop = Math.abs(Math.sin(t * 3));
    p.y = 268 - hop * 40;
    p.onGround = hop < 0.15;
    p.sqx = p.onGround ? 1.15 : 0.92;
    p.sqy = p.onGround ? 0.88 : 1.08;
    p.lookX = Math.cos(t * 0.8);
    p.vx = 100;
    ctx.save();
    p.draw(ctx, 0, 0, t, g.settings.reduceFlash);
    ctx.restore();
    UI.menu(ctx, g.titleItems(), g.menuIndex, 350, t);
    if (Math.sin(t * 4) > -0.3) text(ctx, 'Press ENTER to start', VIEW_W / 2, 486, 18, '#ffe68a', 'center', '#ffb000');
    text(ctx, 'D/A run · SPACE jump · S duck · W shoot · P pause · M mute · C CRT', VIEW_W / 2, 516, 12, 'rgba(200,210,255,0.6)', 'center', null, 'normal');
    if (g.eggFlash > 0) text(ctx, '★ SECRET SKIN UNLOCKED ★', VIEW_W / 2, 220, 18, '#ff9be8', 'center', '#ff2dbf');
  },

  settings(ctx, g) {
    UI.dim(ctx, 0.75);
    text(ctx, 'SETTINGS', VIEW_W / 2, 90, 40, '#ffffff', 'center', '#38e1ff');
    const s = g.settings;
    const onOff = (b) => (b ? 'ON' : 'OFF');
    const bar = '■'.repeat(Math.round(s.volume * 10)) + '□'.repeat(10 - Math.round(s.volume * 10));
    const items = [
      'Volume  ' + bar,
      'Mute  ' + onOff(s.muted),
      'Screen Shake  ' + onOff(s.shake),
      'CRT Filter  ' + onOff(s.crt),
      'Reduce Flashing  ' + onOff(s.reduceFlash),
      'Back',
    ];
    UI.menu(ctx, items, g.menuIndex, 170, g.realTime);
    text(ctx, 'W/S select · A/D change · ENTER toggle · ESC back', VIEW_W / 2, 470, 13, 'rgba(200,210,255,0.6)', 'center', null, 'normal');
  },

  pause(ctx, g) {
    UI.dim(ctx, 0.6);
    text(ctx, 'PAUSED', VIEW_W / 2, 150, 48, '#ffffff', 'center', '#38e1ff');
    UI.menu(ctx, ['Resume', 'Settings', 'Quit to Title'], g.menuIndex, 250, g.realTime);
  },

  levelSelect(ctx, g) {
    UI.dim(ctx, 0.6);
    text(ctx, 'LEVEL SELECT', VIEW_W / 2, 80, 40, '#ffffff', 'center', '#38e1ff');
    const W = 250;
    const gap = 30;
    const x0 = VIEW_W / 2 - (W * 3 + gap * 2) / 2;
    LEVELS.forEach((L, i) => {
      const x = x0 + i * (W + gap);
      const y = 150;
      const sel = g.menuIndex === i;
      const unlocked = i < Save.data.unlocked;
      const rec = Save.data.levels[i];
      const T = THEMES[L.theme];
      const grad = ctx.createLinearGradient(0, y, 0, y + 250);
      grad.addColorStop(0, T.skyBottom);
      grad.addColorStop(1, T.skyTop);
      ctx.fillStyle = grad;
      roundRect(ctx, x, y + (sel ? -8 : 0), W, 250, 14);
      ctx.fill();
      ctx.strokeStyle = sel ? T.edge : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = sel ? 3 : 1;
      ctx.stroke();
      const yy = y + (sel ? -8 : 0);
      text(ctx, 'LEVEL ' + (i + 1), x + W / 2, yy + 34, 16, T.accent, 'center');
      text(ctx, L.name, x + W / 2, yy + 66, 22, '#ffffff', 'center', T.edge);
      if (unlocked) {
        for (let s = 0; s < 3; s++) {
          ctx.globalAlpha = s < rec.stars ? 1 : 0.2;
          drawStar(ctx, x + W / 2 - 44 + s * 44, yy + 130, 15, g.realTime, false);
          ctx.globalAlpha = 1;
        }
        text(ctx, 'Best coins: ' + rec.coins, x + W / 2, yy + 182, 16, '#ffe68a', 'center');
        text(ctx, rec.secret ? 'Secret: found ✓' : 'Secret: ?', x + W / 2, yy + 210, 14, rec.secret ? '#fff27a' : 'rgba(255,255,255,0.5)', 'center');
      } else {
        text(ctx, '🔒 LOCKED', x + W / 2, yy + 150, 20, 'rgba(255,255,255,0.5)', 'center');
      }
    });
    const back = g.menuIndex === 3;
    text(ctx, (back ? '▸ ' : '') + 'Back' + (back ? ' ◂' : ''), VIEW_W / 2, 450, back ? 22 : 19, back ? '#ffffff' : 'rgba(210,220,255,0.65)', 'center');
    text(ctx, 'A/D choose · ENTER play · ESC back', VIEW_W / 2, 500, 13, 'rgba(200,210,255,0.6)', 'center', null, 'normal');
  },

  intro(ctx, g) {
    const k = g.stateT;
    const a = k < 0.4 ? k / 0.4 : k > 1.9 ? Math.max(0, 1 - (k - 1.9) / 0.4) : 1;
    ctx.save();
    ctx.globalAlpha = a;
    UI.dim(ctx, 0.35);
    const lv = g.level;
    text(ctx, 'LEVEL ' + (lv.index + 1), VIEW_W / 2, 200, 24, lv.T.accent, 'center');
    text(ctx, lv.data.name.toUpperCase(), VIEW_W / 2 + (1 - a) * 40, 250, 58, '#ffffff', 'center', lv.T.edge, '900');
    const hint = ['Run, jump, collect. Reach the warp gate!', 'Watch out for chasms — and try the anti-gravity bubbles.', 'The Nebula Jelly waits at the end. Good luck!'][lv.index];
    text(ctx, hint, VIEW_W / 2, 310, 16, '#dfe6ff', 'center', null, 'normal');
    ctx.restore();
  },

  complete(ctx, g) {
    UI.dim(ctx, 0.55);
    const c = g.completeInfo;
    const lv = g.level;
    const k = g.stateT;
    text(ctx, 'LEVEL COMPLETE!', VIEW_W / 2, 80, 50, '#ffffff', 'center', lv.T.edge, '900');
    text(ctx, lv.data.name, VIEW_W / 2, 124, 18, lv.T.accent, 'center');
    // stars pop in one by one
    for (let s = 0; s < 3; s++) {
      const appear = clamp((k - 0.6 - s * 0.35) / 0.25, 0, 1);
      const got = s < c.stars;
      const sc = got ? (appear < 1 ? 1.6 - 0.6 * appear : 1) : 1;
      ctx.globalAlpha = got ? appear : 0.18;
      drawStar(ctx, VIEW_W / 2 - 70 + s * 70, 190, 26 * sc, g.realTime, got && appear >= 1);
      ctx.globalAlpha = 1;
    }
    const rows = [
      ['Coins', c.coins + ' / ' + c.total],
      ['Secrets found', (c.secret ? 1 : 0) + '/1'],
      ['Deaths', String(c.deaths)],
      ['Time', fmtTime(c.time)],
      ['Coin bonus', '+' + Math.floor(g.bonusShown)],
      ['Score', String(Math.floor(g.score))],
    ];
    rows.forEach(([a, b], i) => {
      const y = 262 + i * 32;
      text(ctx, a, VIEW_W / 2 - 150, y, 18, '#cfd6ff', 'left', null, 'normal');
      text(ctx, b, VIEW_W / 2 + 150, y, 20, i === 1 && c.secret ? '#fff27a' : '#ffffff', 'right');
    });
    if (k > 2 && Math.sin(g.realTime * 4) > -0.3) text(ctx, 'Press ENTER to continue', VIEW_W / 2, 494, 18, '#ffe68a', 'center', '#ffb000');
  },

  final(ctx, g) {
    UI.dim(ctx, 0.3);
    const t = g.realTime;
    const p = g.titleCube;
    p.x = VIEW_W / 2 - 13 + Math.cos(t * 0.9) * 220;
    p.y = 250 + Math.sin(t * 1.8) * 60;
    p.onGround = false;
    p.spin = Math.sin(t * 2) * 0.4;
    p.scale = 1.6;
    p.draw(ctx, 0, 0, t, g.settings.reduceFlash);
    p.spin = 0;
    p.scale = 1;
    text(ctx, 'YOU WIN!', VIEW_W / 2, 110, 84, '#ffffff', 'center', '#ffd23d', '900');
    text(ctx, 'The cosmos is safe — the Nebula Jelly has been defeated.', VIEW_W / 2, 170, 18, '#ffe9b0', 'center', null, 'normal');
    const sum = Save.data.levels.reduce((a, l) => a + l.stars, 0);
    const coins = g.runCoins;
    text(ctx, 'Coins this run: ' + coins + ' / ' + g.runCoinTotal, VIEW_W / 2, 380, 22, '#ffe68a', 'center', '#ffb000');
    text(ctx, 'Stars: ' + sum + ' / 9', VIEW_W / 2, 414, 22, '#fff27a', 'center', '#ffb000');
    text(ctx, 'Final score: ' + Math.floor(g.score), VIEW_W / 2, 448, 18, '#ffffff', 'center');
    if (Math.sin(t * 4) > -0.3) text(ctx, 'Press ENTER for level select', VIEW_W / 2, 500, 16, '#cfd6ff', 'center');
  },
};

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return m + ':' + String(r).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 15. Game — state machine and fixed-timestep loop
// ---------------------------------------------------------------------------
const EGG_WORD = 'STAR';

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.input = new Input();
    this.audio = new AudioEngine();
    this.particles = new Particles(PARTICLE_CAP);
    this.camera = new Camera();
    this.player = new Player();
    this.titleCube = new Player();
    Save.load();
    this.settings = Save.data.settings;
    this.audio.volume = this.settings.volume;
    this.audio.muted = this.settings.muted;
    this.camera.enabled = this.settings.shake;

    this.state = 'title';
    this.stateT = 0;
    this.menuIndex = 0;
    this.time = 0;          // simulation time
    this.realTime = 0;
    this.acc = 0;
    this.last = 0;
    this.slowT = 0;
    this.flashA = 0;
    this.eggBuf = '';
    this.eggFlash = 0;
    this.settingsReturn = 'title';
    this.portalPulse = 0;
    this.shockwaves = [];
    this.fireworks = [];
    this.popups = [];
    this.warp = null;
    this.runCoins = 0;
    this.runCoinTotal = 0;
    this.score = 0;
    this.invincible = false;   // test hook only
    this.levelIndex = 0;
    this.loadLevel(0);
    this.state = 'title';
    this.input.onGesture = () => this.audio.init();
  }

  // --- level lifecycle -------------------------------------------------------

  loadLevel(i) {
    this.levelIndex = i;
    this.level = new Level(i);
    this.bg = new SpaceBackground(this.level.T, 101 + i * 31);
    this.enemies = this.level.data.enemies.map((e) => new Enemy(e));
    this.bullets = [];
    this.fireballs = [];
    this.stones = [];
    this.popups = [];
    this.shockwaves = [];
    this.fireworks = [];
    this.particles.clear();
    this.boss = this.level.boss ? new Boss(this.level) : null;
    this.checkpoint = { x: this.level.start.x, y: this.level.start.y };
    this.player.reset(this.checkpoint.x, this.checkpoint.y);
    this.inRoom = false;
    this.roomProgress = 0;
    this.stats = { coins: 0, deaths: 0, time: 0 };
    this.combo = 0;
    this.comboT = 0;
    this.comboPop = 0;
    this.coinPop = 0;
    this.superType = 'boots';
    this.levelStartScore = this.score;
    this.camera.snap(this.player.cx, this.player.cy, this.bounds());
    this.audio.setIntensity(1);
    this.audio.startMusic(this.level.T.music);
  }

  startLevel(i) {
    if (i === 0) { this.score = 0; this.runCoins = 0; this.runCoinTotal = 0; }
    this.loadLevel(i);
    this.setState('intro');
  }

  setState(s) {
    this.state = s;
    this.stateT = 0;
    this.menuIndex = 0;
  }

  bounds() {
    return this.inRoom ? this.level.roomBounds : (this.boss && this.boss.active ? { x0: this.boss.x0 - 64, x1: this.boss.x1 + 64 + TILE * 2, y0: 0, y1: this.level.heightPx } : this.level.mainBounds);
  }

  onScreen(x, y, margin) {
    const c = this.camera;
    return x > c.x - margin && x < c.x + VIEW_W + margin && y > c.y - margin && y < c.y + VIEW_H + margin;
  }

  respawn() {
    const pl = this.player;
    pl.reset(this.checkpoint.x, this.checkpoint.y);
    this.enemies = this.level.data.enemies.map((e) => new Enemy(e));
    this.bullets = [];
    this.fireballs = [];
    this.stones = [];
    this.level.resetDynamic();
    if (this.boss && !this.boss.dead && this.boss.state !== 'dying') this.boss.reset();
    this.inRoom = false;
    this.combo = 0;
    this.comboT = 0;
    this.camera.snap(pl.cx, pl.cy, this.bounds());
    this.particles.burst(pl.cx, pl.cy, 30, { speed: [40, 160], life: [0.3, 0.7], size: [2, 4], color: [pl.skin.glow, '#ffffff'] });
  }

  killPlayer(cause) {
    const pl = this.player;
    if (pl.dead || this.invincible) return;
    pl.dead = true;
    pl.deadT = 0;
    pl.visible = false;
    pl.dissolve(this);
    this.stats.deaths++;
    this.audio.play('death');
    this.camera.shake(8, 0.4);
    this.deathCause = cause;
  }

  // --- spawners used by entities ---------------------------------------------

  spawnBullet(x, y, dir) {
    this.bullets.push(new Bullet(x, y, dir));
    this.audio.play('shoot');
  }

  spawnFireball(x, y, dir) {
    this.fireballs.push(new Fireball(x, y, dir * PHYS.fireballSpeed, 0));
    this.audio.play('fireball');
  }

  spawnStone(x, y) {
    this.stones.push(new Stone(x, y));
  }

  slowMo(t) { this.slowT = Math.max(this.slowT, t); }

  popup(x, y, str, color) {
    this.popups.push({ x, y, str, color: color || '#ffffff', life: 1, max: 1 });
  }

  addCombo(base, x, y) {
    if (this.comboT > 0) this.combo++;
    else this.combo = 1;
    this.comboT = PHYS.comboWindow;
    const mult = Math.min(this.combo, PHYS.comboMax);
    this.score += base * mult;
    if (mult >= 2) {
      this.comboPop = 1;
      this.popup(x, y - 20, 'x' + mult, '#ff7ae0');
    }
  }

  killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    const cols = ENEMY_COLORS[e.type];
    this.particles.burst(e.cx, e.cy, 50, { speed: [60, 260], life: [0.4, 0.9], size: [2, 5], color: cols.concat(['#ffffff']), drag: 1.5 });
    this.shockwaves.push({ x: e.cx, y: e.cy, r: 4, life: 0.35, max: 0.35, color: cols[0] });
    this.audio.play('kill');
    this.camera.shake(3, 0.12);
    this.addCombo(100, e.cx, e.cy);
    // short slow motion when the last enemy of a group falls
    const othersNear = this.enemies.some((o) => !o.dead && Math.abs(o.cx - e.cx) < 480 && Math.abs(o.cy - e.cy) < 300);
    if (!othersNear) this.slowMo(0.3);
  }

  bossIntro() {
    this.popup(this.player.cx, this.player.y - 40, 'BOSS!', '#ff2d55');
    this.camera.shake(6, 0.5);
    this.audio.play('warn');
  }

  bossDefeated(x, y) {
    this.particles.burst(x, y, 400, { speed: [100, 600], life: [0.8, 2.0], size: [2, 6], color: ['#ffffff', '#3dffd0', '#5ae0ff', '#ffd23d', '#c08bff'], drag: 1.2 });
    for (let i = 0; i < 4; i++) this.shockwaves.push({ x, y, r: 10, life: 0.8 + i * 0.2, max: 0.8 + i * 0.2, color: i % 2 ? '#3dffd0' : '#ffffff', big: true });
    this.audio.play('explode');
    this.camera.shake(16, 1.0);
    this.flashA = this.settings.reduceFlash ? 0.25 : 0.9;
    this.slowMo(0.5);
    this.score += 5000;
    this.popup(x, y, '+5000', '#ffd23d');
    this.level.goal.locked = false;
    this.portalPulse = 1;
    this.audio.play('portal');
  }

  collectCoin(c) {
    c.taken = true;
    this.stats.coins++;
    this.coinPop = 1;
    this.addCombo(10, c.x, c.y);
    this.audio.play('coin');
    this.particles.burst(c.x, c.y, 12, { speed: [40, 140], life: [0.3, 0.6], size: [2, 3], color: ['#ffd84a', '#fff3b0', '#ffffff'] });
  }

  collectItem(it) {
    it.taken = true;
    const pl = this.player;
    if (it.type === 'shield') {
      pl.shieldT = PHYS.shieldTime;
      this.popup(it.x, it.y - 20, 'SHIELD!', '#4fc3ff');
    } else {
      const dur = it.type === 'boots' ? PHYS.bootsTime : PHYS.springTime;
      pl.superT = Math.max(pl.superT, dur);
      pl.superMax = Math.max(pl.superT, 1);
      this.superType = it.type;
      this.popup(it.x, it.y - 20, it.type === 'boots' ? 'SUPER-JUMP BOOTS!' : 'SPRING GUARDIAN!', '#ffd23d');
    }
    this.score += 250;
    this.audio.play('power');
    this.particles.burst(it.x, it.y, 60, { speed: [60, 260], life: [0.4, 0.9], size: [2, 4], color: [ITEM_COLORS[it.type], '#ffffff'], drag: 1.5 });
    this.shockwaves.push({ x: it.x, y: it.y, r: 6, life: 0.5, max: 0.5, color: ITEM_COLORS[it.type] });
  }

  enterRoom() {
    const pl = this.player;
    const keep = { s: pl.superT, m: pl.superMax, sh: pl.shieldT };
    const s = this.level.secret;
    pl.reset(s.spawn.x, s.spawn.y);
    pl.superT = keep.s; pl.superMax = keep.m; pl.shieldT = keep.sh;
    this.inRoom = true;
    this.roomProgress = clamp((s.entry.x - this.level.start.x) / (this.level.goal.x - this.level.start.x), 0, 1);
    this.bullets = [];
    this.flashA = this.settings.reduceFlash ? 0.2 : 0.7;
    this.camera.snap(pl.cx, pl.cy, this.bounds());
    this.audio.play('secret');
    this.popup(pl.cx, pl.y - 30, 'SECRET ROOM!', '#fff27a');
  }

  leaveRoom() {
    const pl = this.player;
    const keep = { s: pl.superT, m: pl.superMax, sh: pl.shieldT };
    const s = this.level.secret;
    pl.reset(s.returnTo.x, s.returnTo.y);
    pl.superT = keep.s; pl.superMax = keep.m; pl.shieldT = keep.sh;
    this.inRoom = false;
    this.bullets = [];
    this.flashA = this.settings.reduceFlash ? 0.2 : 0.6;
    this.camera.snap(pl.cx, pl.cy, this.bounds());
    this.audio.play('portal');
  }

  startVictory() {
    this.setState('victory');
    this.slowMo(0.3);
    this.audio.play('portal');
    const pl = this.player;
    this.victory = { sx: pl.cx, sy: pl.cy, done: false };
    pl.vx = 0;
    pl.vy = 0;
  }

  finishLevel() {
    const lv = this.level;
    const total = lv.coinTotal;
    const coins = this.stats.coins;
    const pct = coins / total;
    const secret = lv.secret.star.taken;
    let stars = 1;
    if (pct >= 0.7) stars++;
    if (pct >= 0.9 && secret && this.stats.deaths <= 3) stars++;
    this.completeInfo = { coins, total, secret, deaths: this.stats.deaths, time: this.stats.time, stars, bonus: coins * 50 };
    this.bonusShown = 0;
    this.runCoins += coins;
    this.runCoinTotal += total;
    Save.recordLevel(lv.index, stars, coins, secret);
    this.setState('complete');
  }

  // --- main loop ------------------------------------------------------------

  start() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.input.attach(window);
    this.last = performance.now();
    const loop = (ts) => {
      this.frame(ts);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  resize() {
    const w = window.innerWidth || VIEW_W;
    const h = window.innerHeight || VIEW_H;
    const s = Math.min(w / VIEW_W, h / VIEW_H);
    const cssW = Math.floor(VIEW_W * s);
    const cssH = Math.floor(VIEW_H * s);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = Math.max(0.5, Math.min(s * dpr, 2));
    this.canvas.width = Math.round(VIEW_W * k);
    this.canvas.height = Math.round(VIEW_H * k);
    this.scale = this.canvas.width / VIEW_W;
    this.crtCache = null;
  }

  frame(ts) {
    let dt = (ts - this.last) / 1000;
    this.last = ts;
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, MAX_FRAME);
    this.realTime += dt;
    this.input.pollGamepad();
    const scale = this.slowT > 0 ? 0.3 : 1;
    this.slowT = Math.max(0, this.slowT - dt);
    this.acc += dt * scale;
    let steps = 0;
    while (this.acc >= STEP && steps < 8) {
      this.step(STEP);
      this.input.endStep();
      this.acc -= STEP;
      steps++;
    }
    if (steps >= 8) this.acc = 0;
    this.audio.update();
    try {
      this.render(dt);
    } catch (e) {
      // a rendering hiccup must never kill the loop
      if (!this.renderErrorLogged) { this.renderErrorLogged = true; console.error(e); }
    }
  }

  /** One fixed simulation step: menus + world. */
  step(dt) {
    this.stateT += dt;
    this.time += dt;
    const inp = this.input;
    // global toggles
    if (inp.wasPressed('KeyM')) {
      this.settings.muted = !this.settings.muted;
      this.audio.setMuted(this.settings.muted);
      Save.write();
    }
    if (inp.wasPressed('KeyC') && this.state !== 'title') {
      this.settings.crt = !this.settings.crt;
      Save.write();
    }
    this.eggFlash = Math.max(0, this.eggFlash - dt);
    this.flashA = Math.max(0, this.flashA - dt * 2.5);
    this.portalPulse = Math.max(0, this.portalPulse - dt * 0.8);
    this.coinPop = Math.max(0, this.coinPop - dt * 5);
    this.comboPop = Math.max(0, this.comboPop - dt * 4);

    switch (this.state) {
      case 'title': this.stepTitle(dt); break;
      case 'levelselect': this.stepLevelSelect(); break;
      case 'settings': this.stepSettings(); break;
      case 'intro':
        this.bg.update(dt);
        this.updateWorld(dt, true);
        if (this.stateT > 2.3 || (this.stateT > 0.5 && inp.wasPressed('Enter'))) this.setState('play');
        break;
      case 'play': this.stepPlay(dt); break;
      case 'pause': this.stepPause(); break;
      case 'victory': this.stepVictory(dt); break;
      case 'complete': this.stepComplete(dt); break;
      case 'warp': this.stepWarp(dt); break;
      case 'final': this.stepFinal(dt); break;
      default: break;
    }
  }

  titleItems() { return ['Start Game', 'Level Select', 'Settings']; }

  menuNav(count) {
    const inp = this.input;
    if (inp.wasPressed('KeyS', 'ArrowDown')) { this.menuIndex = (this.menuIndex + 1) % count; this.audio.play('select'); }
    if (inp.wasPressed('KeyW', 'ArrowUp')) { this.menuIndex = (this.menuIndex + count - 1) % count; this.audio.play('select'); }
  }

  stepTitle(dt) {
    this.bg.update(dt);
    const inp = this.input;
    // easter egg: type the secret word
    for (const ch of inp.typed) {
      this.eggBuf = (this.eggBuf + ch).slice(-EGG_WORD.length);
      if (this.eggBuf === EGG_WORD) {
        const idx = this.player.skin === CUBE_SKINS[0] ? 1 : 0;
        this.player.skin = CUBE_SKINS[idx];
        this.titleCube.skin = CUBE_SKINS[idx];
        this.eggFlash = 2.5;
        this.audio.play('egg');
        this.eggBuf = '';
      }
    }
    if (inp.wasPressed('ArrowDown')) { this.menuIndex = (this.menuIndex + 1) % 3; this.audio.play('select'); }
    if (inp.wasPressed('ArrowUp')) { this.menuIndex = (this.menuIndex + 2) % 3; this.audio.play('select'); }
    if (!this.audio.musicOn && this.audio.ok) { this.audio.startMusic(0); this.audio.setIntensity(0.6); }
    if (inp.wasPressed('Enter')) {
      this.audio.init();
      this.audio.play('confirm');
      if (this.menuIndex === 0) this.startLevel(0);
      else if (this.menuIndex === 1) this.setState('levelselect');
      else { this.settingsReturn = 'title'; this.setState('settings'); }
    }
  }

  stepLevelSelect() {
    this.bg.update(STEP);
    const inp = this.input;
    if (inp.wasPressed('KeyD', 'ArrowRight')) { this.menuIndex = Math.min(3, this.menuIndex + 1); this.audio.play('select'); }
    if (inp.wasPressed('KeyA', 'ArrowLeft')) { this.menuIndex = Math.max(0, this.menuIndex - 1); this.audio.play('select'); }
    if (inp.wasPressed('KeyS', 'ArrowDown')) this.menuIndex = 3;
    if (inp.wasPressed('KeyW', 'ArrowUp') && this.menuIndex === 3) this.menuIndex = 0;
    if (inp.wasPressed('Escape') || (inp.wasPressed('Enter') && this.menuIndex === 3)) {
      this.setState('title');
      return;
    }
    if (inp.wasPressed('Enter')) {
      if (this.menuIndex < Save.data.unlocked) {
        this.audio.play('confirm');
        if (this.menuIndex === 0) { this.score = 0; this.runCoins = 0; this.runCoinTotal = 0; }
        this.loadLevel(this.menuIndex);
        this.setState('intro');
      } else {
        this.audio.play('warn');
      }
    }
  }

  stepSettings() {
    this.bg.update(STEP);
    const inp = this.input;
    const s = this.settings;
    this.menuNav(6);
    const left = inp.wasPressed('KeyA', 'ArrowLeft');
    const right = inp.wasPressed('KeyD', 'ArrowRight');
    const enter = inp.wasPressed('Enter');
    let changed = false;
    switch (this.menuIndex) {
      case 0:
        if (left || right) { s.volume = clamp(Math.round((s.volume + (right ? 0.1 : -0.1)) * 10) / 10, 0, 1); this.audio.setVolume(s.volume); changed = true; }
        break;
      case 1: if (enter || left || right) { s.muted = !s.muted; this.audio.setMuted(s.muted); changed = true; } break;
      case 2: if (enter || left || right) { s.shake = !s.shake; this.camera.enabled = s.shake; changed = true; } break;
      case 3: if (enter || left || right) { s.crt = !s.crt; changed = true; } break;
      case 4: if (enter || left || right) { s.reduceFlash = !s.reduceFlash; changed = true; } break;
      case 5: if (enter) { this.setState(this.settingsReturn); if (this.settingsReturn === 'pause') this.menuIndex = 1; return; } break;
      default: break;
    }
    if (changed) { this.audio.play('select'); Save.write(); }
    if (inp.wasPressed('Escape')) {
      this.setState(this.settingsReturn);
      if (this.settingsReturn === 'pause') this.menuIndex = 1;
    }
  }

  stepPause() {
    const inp = this.input;
    this.menuNav(3);
    if (inp.wasPressed('KeyP', 'Escape')) { this.setState('play'); return; }
    if (inp.wasPressed('Enter')) {
      this.audio.play('confirm');
      if (this.menuIndex === 0) this.setState('play');
      else if (this.menuIndex === 1) { this.settingsReturn = 'pause'; this.setState('settings'); }
      else { this.setState('title'); this.loadLevel(0); this.audio.startMusic(0); this.audio.setIntensity(0.6); }
    }
  }

  stepPlay(dt) {
    const inp = this.input;
    if (inp.wasPressed('KeyP', 'Escape')) {
      this.setState('pause');
      this.input.releaseAll();
      return;
    }
    this.stats.time += dt;
    this.bg.update(dt);
    this.updateWorld(dt, false);
  }

  /** Simulates the world. frozen=true keeps the player still (intro). */
  updateWorld(dt, frozen) {
    const lv = this.level;
    const pl = this.player;
    lv.update(dt, this.time, this);
    const prevBottom = pl.y + pl.h;
    if (!frozen) pl.update(dt, this.input, lv, this);

    // death → dust → respawn
    if (pl.dead) {
      if (pl.deadT > 1.6) this.respawn();
    } else if (pl.y > lv.heightPx - 46) {
      // nothing to stand on below the ground line: dissolve while still visible at the bottom edge
      this.killPlayer('fall');
    }

    for (const e of this.enemies) {
      if (!e.dead && Math.abs(e.cx - pl.cx) < VIEW_W * 1.2) e.update(dt, this);
    }
    if (this.boss) this.boss.update(dt, this);
    for (const b of this.bullets) b.update(dt, this);
    for (const f of this.fireballs) f.update(dt, this);
    for (const s of this.stones) s.update(dt, this);

    if (!pl.dead && !frozen) this.collisions(prevBottom);

    sweep(this.bullets);
    sweep(this.fireballs);
    sweep(this.stones);
    sweep(this.enemies);

    // combo window
    if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; }

    // eyes follow the nearest coin or enemy; scared when a projectile is close
    let best = 260 * 260;
    let tx = null;
    let ty = null;
    for (const c of lv.coins) {
      if (c.taken || Math.abs(c.x - pl.cx) > 260) continue;
      const d = dist2(c.x, c.y, pl.cx, pl.cy);
      if (d < best) { best = d; tx = c.x; ty = c.y; }
    }
    for (const e of this.enemies) {
      const d = dist2(e.cx, e.cy, pl.cx, pl.cy);
      if (d < best * 1.6) { best = d; tx = e.cx; ty = e.cy; }
    }
    if (tx !== null) {
      const len = Math.sqrt(dist2(tx, ty, pl.cx, pl.cy)) || 1;
      pl.lookX = lerp(pl.lookX, (tx - pl.cx) / len, 0.2);
      pl.lookY = lerp(pl.lookY, (ty - pl.cy) / len, 0.2);
    } else {
      pl.lookX = lerp(pl.lookX, pl.facing * 0.5, 0.1);
      pl.lookY = lerp(pl.lookY, 0, 0.1);
    }
    pl.scared = this.fireballs.some((f) => dist2(f.x, f.y, pl.cx, pl.cy) < 150 * 150) || this.stones.some((s) => Math.abs(s.cx - pl.cx) < 60 && s.y < pl.y && pl.y - s.y < 220);

    // effects
    this.particles.update(dt);
    for (const s of this.shockwaves) { s.life -= dt; s.r += (s.big ? 900 : 300) * dt; if (s.life <= 0) s.dead = true; }
    sweep(this.shockwaves);
    for (const p of this.popups) { p.life -= dt; p.y -= 40 * dt; if (p.life <= 0) p.dead = true; }
    sweep(this.popups);
    this.updateFireworks(dt);

    // music intensity: calm in secret room, rising towards the boss
    let intensity = 1;
    if (this.inRoom) intensity = 0;
    else if (this.boss && (this.boss.active || this.boss.state === 'dying')) intensity = 2;
    else if (this.boss && !this.boss.dead) intensity = 1 + 0.8 * clamp(1 - (this.boss.x0 - pl.cx) / 1600, 0, 1);
    this.audio.setIntensity(intensity);

    // camera
    this.camera.follow(pl.cx, pl.cy, pl.facing, pl.vx, dt, this.bounds());
  }

  collisions(prevBottom) {
    const pl = this.player;
    const lv = this.level;
    const hb = { x: pl.x + 3, y: pl.y + 3, w: pl.w - 6, h: pl.h - 4 };

    for (const c of lv.coins) {
      if (!c.taken && Math.abs(c.x - pl.cx) < 30 && dist2(c.x, c.y, pl.cx, pl.cy) < (c.r + 15) * (c.r + 15)) this.collectCoin(c);
    }
    for (const it of lv.items) {
      if (!it.taken && dist2(it.x, it.y, pl.cx, pl.cy) < 40 * 40) this.collectItem(it);
    }
    const s = lv.secret;
    if (!s.star.taken && dist2(s.star.x, s.star.y, pl.cx, pl.cy) < 30 * 30) {
      s.star.taken = true;
      this.score += 1000;
      this.audio.play('star');
      this.popup(s.star.x, s.star.y - 20, 'SECRET STAR!', '#fff27a');
      this.particles.burst(s.star.x, s.star.y, 100, { speed: [60, 300], life: [0.5, 1.2], size: [2, 5], color: ['#fff27a', '#ffffff', '#ffd23d'], drag: 1.2 });
      this.shockwaves.push({ x: s.star.x, y: s.star.y, r: 8, life: 0.6, max: 0.6, color: '#fff27a' });
    }
    if (!this.inRoom && dist2(s.entry.x, s.entry.y, pl.cx, pl.cy) < 28 * 28) { this.enterRoom(); return; }
    if (this.inRoom && dist2(s.exit.x, s.exit.y, pl.cx, pl.cy) < 28 * 28) { this.leaveRoom(); return; }

    for (const c of lv.checkpoints) {
      if (!c.active && pl.cx > c.x - 8 && Math.abs(pl.y + pl.h - c.y) < 200) {
        c.active = true;
        this.checkpoint = { x: c.x, y: c.y };
        this.audio.play('checkpoint');
        this.particles.burst(c.x, c.y - 58, 50, { speed: [60, 220], life: [0.4, 0.9], size: [2, 4], color: ['#3dffb0', '#ffffff'], drag: 1 });
        this.shockwaves.push({ x: c.x, y: c.y - 58, r: 6, life: 0.5, max: 0.5, color: '#3dffb0' });
        this.popup(c.x, c.y - 90, 'CHECKPOINT', '#3dffb0');
      }
    }

    // the portal stands on a pedestal: entering its column (ground to top ring) counts
    if (!lv.goal.locked && Math.abs(lv.goal.x - pl.cx) < 34 && pl.cy > lv.goal.y - 76 && pl.cy < lv.goal.y + 80) { this.startVictory(); return; }

    // enemies: stomp from above, shield kills on contact, otherwise death
    for (const e of this.enemies) {
      if (e.dead) continue;
      const er = { x: e.x + 2, y: e.y + 2, w: e.w - 4, h: e.h - 3 };
      if (!overlap(hb, er)) continue;
      if (pl.vy > 0 && prevBottom <= e.y + 10) {
        this.killEnemy(e);
        pl.vy = -(this.input.isDown('Space') ? PHYS.stompBounce * 1.3 : PHYS.stompBounce);
        pl.sqx = 1.3;
        pl.sqy = 0.75;
        this.audio.play('stomp');
      } else if (pl.shieldT > 0) {
        this.killEnemy(e);
      } else {
        this.killPlayer('monster');
        return;
      }
    }

    for (const f of this.fireballs) {
      const r = f.r * 0.85;
      const nx = clamp(f.x, hb.x, hb.x + hb.w);
      const ny = clamp(f.y, hb.y, hb.y + hb.h);
      if (dist2(nx, ny, f.x, f.y) < r * r) {
        f.dead = true;
        if (pl.shieldT > 0) {
          this.particles.burst(f.x, f.y, 14, { speed: [60, 200], life: [0.2, 0.5], size: [2, 3], color: ['#4fc3ff', '#ffffff'] });
        } else {
          this.killPlayer('fireball');
          return;
        }
      }
    }
    for (const st of this.stones) {
      if (overlap(hb, { x: st.x + 2, y: st.y + 2, w: st.w - 4, h: st.h - 4 })) {
        st.dead = true;
        if (pl.shieldT > 0) {
          this.particles.burst(st.cx, st.y, 14, { speed: [60, 200], life: [0.2, 0.5], size: [2, 3], color: ['#4fc3ff', '#ffffff'] });
        } else {
          this.killPlayer('stone');
          return;
        }
      }
    }
    if (this.boss && this.boss.active && this.boss.hits(hb) && pl.shieldT <= 0) {
      this.killPlayer('boss');
      return;
    }

    // bullets vs enemies, stones and the boss
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (b.x > e.x - b.r && b.x < e.x + e.w + b.r && b.y > e.y - b.r && b.y < e.y + e.h + b.r) {
          b.dead = true;
          this.killEnemy(e);
          break;
        }
      }
      if (b.dead) continue;
      for (const st of this.stones) {
        if (!st.dead && b.x > st.x - 4 && b.x < st.x + st.w + 4 && b.y > st.y - 4 && b.y < st.y + st.h + 4) {
          st.dead = true;
          b.dead = true;
          this.particles.burst(st.cx, st.y, 10, { speed: [40, 140], life: [0.2, 0.5], size: [2, 3], color: ['#ffcc66', '#ffffff'] });
          break;
        }
      }
      if (!b.dead && this.boss && this.boss.vulnerable && this.boss.hitByBullet(b)) {
        b.dead = true;
        this.boss.damage(this);
      }
    }
  }

  updateFireworks(dt) {
    for (const f of this.fireworks) {
      f.t -= dt;
      if (f.t <= 0 && !f.done) {
        f.done = true;
        const col = pick(['#ff5fd2', '#38e1ff', '#ffd23d', '#3dffb0', '#c08bff', '#ff8a3d']);
        this.particles.burst(f.x, f.y, 70, { speed: [80, 260], life: [0.7, 1.4], size: [2, 4], color: [col, '#ffffff'], g: 120, drag: 1.2 });
        this.audio.play('stomp');
      }
    }
    this.fireworks = this.fireworks.filter((f) => !f.done);
  }

  stepVictory(dt) {
    const pl = this.player;
    const g = this.level.goal;
    const k = this.stateT;
    this.bg.update(dt);
    this.level.update(dt, this.time, this);
    // the cube gets sucked into the portal with a spin
    const suck = clamp(k / 1.3, 0, 1);
    const e = suck * suck;
    const nx = lerp(this.victory.sx, g.x, e);
    const ny = lerp(this.victory.sy, g.y, e);
    pl.x = nx - pl.w / 2;
    pl.y = ny - pl.h / 2;
    pl.spin = e * 14;
    pl.scale = 1 - e * 0.95;
    if (Math.random() < 0.6) this.particles.add({ x: pl.cx + rand(-30, 30), y: pl.cy + rand(-30, 30), vx: (g.x - pl.cx) * 2, vy: (g.y - pl.cy) * 2, life: 0.4, size: 3, color: pl.glowColor() });
    if (k > 1.3 && !this.victory.done) {
      this.victory.done = true;
      pl.visible = false;
      this.audio.play('victory');
      this.flashA = this.settings.reduceFlash ? 0.2 : 0.85;
      this.camera.shake(8, 0.5);
      for (let i = 0; i < 4; i++) this.shockwaves.push({ x: g.x, y: g.y, r: 10, life: 0.7 + i * 0.15, max: 0.7 + i * 0.15, color: i % 2 ? this.level.T.edge : '#ffffff', big: true });
      // star burst
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * TAU;
        this.particles.add({ x: g.x, y: g.y, vx: Math.cos(a) * 380, vy: Math.sin(a) * 380, life: 1.0, size: 6, color: '#fff27a', drag: 1.5 });
      }
      for (let i = 0; i < 8; i++) this.fireworks.push({ t: 0.15 + i * 0.18, x: g.x + rand(-300, 300), y: g.y - rand(60, 240) });
    }
    this.particles.update(dt);
    for (const s of this.shockwaves) { s.life -= dt; s.r += (s.big ? 900 : 300) * dt; if (s.life <= 0) s.dead = true; }
    sweep(this.shockwaves);
    for (const p of this.popups) { p.life -= dt; p.y -= 40 * dt; if (p.life <= 0) p.dead = true; }
    sweep(this.popups);
    this.updateFireworks(dt);
    this.camera.follow(g.x, g.y, 0, 0, dt, this.bounds());
    if (k > 3.0) this.finishLevel();
  }

  stepComplete(dt) {
    this.bg.update(dt);
    this.particles.update(dt);
    this.updateFireworks(dt);
    const c = this.completeInfo;
    // coin bonus count-up
    if (this.stateT > 0.4 && this.bonusShown < c.bonus) {
      const before = this.bonusShown;
      this.bonusShown = Math.min(c.bonus, this.bonusShown + Math.max(10, c.bonus / 1.4) * dt);
      this.score += this.bonusShown - before;
      if (Math.floor(before / 100) !== Math.floor(this.bonusShown / 100)) this.audio.play('select');
    }
    if (this.stateT > 0.6 && this.stateT < 1.8 && Math.abs(this.stateT - (0.85 + Math.floor((this.stateT - 0.6) / 0.35) * 0.35)) < dt / 2 + 0.001) {
      // star appear "ding"
      const s = Math.floor((this.stateT - 0.6) / 0.35);
      if (s < c.stars) this.audio.play('coin');
    }
    if (this.input.wasPressed('Enter')) {
      if (this.stateT < 1.6) {
        // first ENTER skips the count-up
        this.score += c.bonus - this.bonusShown;
        this.bonusShown = c.bonus;
        this.stateT = 2.1;
      } else {
        this.audio.play('confirm');
        this.setState('warp');
        this.warp = { stars: [] };
        for (let i = 0; i < 260; i++) this.warp.stars.push({ a: rand(0, TAU), d: rand(5, 60), sp: rand(0.6, 1.4) });
        this.audio.play('portal');
      }
    }
  }

  stepWarp(dt) {
    for (const s of this.warp.stars) s.d *= 1 + dt * 4.2 * s.sp;
    if (this.stateT > 1.4) {
      const next = this.levelIndex + 1;
      if (next < LEVELS.length) {
        this.loadLevel(next);
        this.setState('intro');
      } else {
        this.setState('final');
        this.audio.startMusic(2);
        this.audio.setIntensity(1.6);
      }
    }
  }

  stepFinal(dt) {
    this.bg.update(dt);
    this.particles.update(dt);
    this.updateFireworks(dt);
    if (Math.random() < dt * 2.2) {
      this.fireworks.push({ t: 0, x: this.camera.x + rand(100, VIEW_W - 100), y: this.camera.y + rand(60, 320) });
    }
    if (this.stateT > 1 && this.input.wasPressed('Enter')) {
      this.audio.play('confirm');
      this.setState('levelselect');
      this.loadLevel(0);
      this.audio.setIntensity(0.6);
    }
  }

  // --- rendering --------------------------------------------------------------

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const st = this.state;
    const cam = this.camera;
    const camX = cam.ox;
    const camY = cam.oy;
    const t = this.time;

    if (st === 'warp') {
      this.renderWarp(ctx);
    } else {
      this.bg.draw(ctx, camX, camY, this.realTime, this.settings.reduceFlash);
      const world = st !== 'title' && st !== 'levelselect' && !(st === 'settings' && this.settingsReturn === 'title') && st !== 'final';
      if (world) {
        this.level.drawStatic(ctx, camX, camY);
        this.level.drawDynamic(ctx, camX, camY, t, this);
        for (const e of this.enemies) if (this.onScreen(e.cx, e.cy, 60)) e.draw(ctx, camX, camY, t);
        if (this.boss) this.boss.draw(ctx, camX, camY, t, this.settings.reduceFlash);
        for (const s of this.stones) s.draw(ctx, camX, camY);
        for (const f of this.fireballs) f.draw(ctx, camX, camY, t);
        for (const b of this.bullets) b.draw(ctx, camX, camY);
        this.player.draw(ctx, camX, camY, t, this.settings.reduceFlash);
      }
      this.particles.draw(ctx, camX, camY);
      this.drawShockwaves(ctx, camX, camY);
      if (world) {
        this.bg.drawForeground(ctx, camX, camY, this.realTime);
        for (const p of this.popups) {
          ctx.globalAlpha = clamp(p.life / p.max * 1.5, 0, 1);
          text(ctx, p.str, p.x - camX, p.y - camY, 16, p.color, 'center', p.color);
          ctx.globalAlpha = 1;
        }
        if (this.player.dead && this.player.deadT > 0.6) {
          const a = clamp((this.player.deadT - 0.6) / 0.3, 0, 1);
          ctx.globalAlpha = a;
          text(ctx, 'Try again!', VIEW_W / 2, VIEW_H / 2 - 20, 44, '#ffffff', 'center', this.level.T.edge, '900');
          ctx.globalAlpha = 1;
        }
        if (st !== 'complete') UI.hud(ctx, this);
      }
      if (st === 'title') UI.title(ctx, this);
      else if (st === 'levelselect') UI.levelSelect(ctx, this);
      else if (st === 'settings') UI.settings(ctx, this);
      else if (st === 'pause') UI.pause(ctx, this);
      else if (st === 'intro') UI.intro(ctx, this);
      else if (st === 'complete') UI.complete(ctx, this);
      else if (st === 'final') UI.final(ctx, this);
    }

    if (this.flashA > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + clamp(this.flashA, 0, 1) + ')';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    if (this.settings.crt) this.drawCRT(ctx);
  }

  drawShockwaves(ctx, camX, camY) {
    if (!this.shockwaves.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.shockwaves) {
      ctx.globalAlpha = clamp(s.life / s.max, 0, 1);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.big ? 6 : 3;
      ctx.beginPath();
      ctx.arc(s.x - camX, s.y - camY, s.r, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  renderWarp(ctx) {
    ctx.fillStyle = '#02020a';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of this.warp.stars) {
      const x1 = cx + Math.cos(s.a) * s.d;
      const y1 = cy + Math.sin(s.a) * s.d;
      const x0 = cx + Math.cos(s.a) * s.d * 0.7;
      const y0 = cy + Math.sin(s.a) * s.d * 0.7;
      ctx.strokeStyle = 'rgba(200,230,255,' + clamp(s.d / 300, 0.1, 0.9) + ')';
      ctx.lineWidth = clamp(s.d / 150, 1, 3);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.restore();
    const a = clamp((this.stateT - 1.0) / 0.4, 0, 1);
    if (a > 0) {
      ctx.fillStyle = 'rgba(255,255,255,' + a * (this.settings.reduceFlash ? 0.3 : 0.9) + ')';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    text(ctx, 'WARP SPEED', cx, cy, 30, '#ffffff', 'center', '#38e1ff', '900');
  }

  drawCRT(ctx) {
    if (!this.crtCache) {
      const pat = makeCanvas(4, 4);
      const pg = pat.getContext('2d');
      pg.fillStyle = 'rgba(0,0,0,0.28)';
      pg.fillRect(0, 2, 4, 1);
      pg.fillRect(0, 3, 4, 1);
      const vig = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.35, VIEW_W / 2, VIEW_H / 2, VIEW_W * 0.65);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(0,0,0,0.55)');
      this.crtCache = { pattern: ctx.createPattern(pat, 'repeat'), vig };
    }
    ctx.save();
    ctx.fillStyle = this.crtCache.pattern;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.crtCache.vig;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.globalAlpha = 0.03 + 0.02 * Math.sin(this.realTime * 50);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// 16. Boot + test hooks + Node export
// ---------------------------------------------------------------------------
/** Deterministic hooks used by tools/headless-test.js. Harmless in normal play. */
function attachTestHooks(game) {
  return {
    game,
    step(n) { for (let i = 0; i < (n || 1); i++) { game.step(STEP); game.input.endStep(); } },
    press(code) { game.input.down.add(code); game.input.pressed.add(code); },
    release(code) { game.input.down.delete(code); },
    tap(code) { game.input.pressed.add(code); },
    loadLevel(i) { game.loadLevel(i); game.setState('play'); },
    teleport(tx, row) { const p = game.player; p.reset((tx + 0.5) * TILE, row * TILE); game.camera.snap(p.cx, p.cy, game.bounds()); },
    state() {
      const p = game.player;
      return {
        state: game.state, level: game.levelIndex, x: p.x, y: p.y, vx: p.vx, vy: p.vy, onGround: p.onGround, dead: p.dead,
        deaths: game.stats.deaths, coins: game.stats.coins, coinTotal: game.level.coinTotal, enemies: game.enemies.length,
        particles: game.particles.list.length, boss: game.boss ? { hp: game.boss.hp, state: game.boss.state } : null,
        goalLocked: game.level.goal.locked, inRoom: game.inRoom, score: game.score,
      };
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__COSMO_NO_BOOT__) {
  window.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('game');
    const game = new Game(canvas);
    window.__cosmo = attachTestHooks(game);
    game.start();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LEVELS, PHYS, THEMES, TILE, WORLD_ROWS, VIEW_W, VIEW_H, STEP, Game, Level, attachTestHooks };
}
