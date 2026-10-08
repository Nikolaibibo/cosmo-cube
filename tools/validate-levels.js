// Level data validator for Cosmo Cube.
//   node tools/validate-levels.js
// Checks every level for: start/goal/platforms present, exactly one of each item, one secret star,
// nothing inside a solid wall, enemies standing on something, duckable fireballs, and — most
// important — that the goal is reachable from the start with NORMAL jumps only (bounce pads and
// low-gravity zones count, power-up platforms don't). Bonus platforms must be reachable with the
// super jump after their power-up. Exit code 1 on any error.
'use strict';
const path = require('path');
const { LEVELS, PHYS, TILE, WORLD_ROWS } = require(path.join(__dirname, '..', 'game.js'));

const errors = [];
const warnings = [];
const err = (lv, msg) => errors.push(`[L${lv + 1}] ${msg}`);
const warn = (lv, msg) => warnings.push(`[L${lv + 1}] ${msg}`);

const SAFETY = 0.85;      // only 85 % of the theoretical jump reach counts (fair, not pixel-perfect)
const RISE_SAFETY = 0.9;

function rects(d) {
  const out = [];
  for (const [x, w, row] of d.ground) out.push({ x: x * TILE, y: row * TILE, w: w * TILE, h: (WORLD_ROWS - row) * TILE });
  for (const [x, row, w, h] of d.blocks) out.push({ x: x * TILE, y: row * TILE, w: w * TILE, h: h * TILE });
  return out;
}

const inside = (px, py, r) => px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h;
const circleHits = (cx, cy, rad, r) => {
  const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
  const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
  return (nx - cx) ** 2 + (ny - cy) ** 2 < rad * rad;
};

function zoneAt(d, x0, x1, y) {
  return d.lowGrav.some(([x, row, w, h]) => x1 > x * TILE && x0 < (x + w) * TILE && y >= row * TILE && y <= (row + h) * TILE);
}

/** Standable surfaces: {x0, x1, y, kind, id}. */
function surfaces(d, solids, includeBonus) {
  const S = [];
  // tops of solids, minus the parts covered by another solid sitting directly on top
  solids.forEach((r, i) => {
    let segs = [[r.x, r.x + r.w]];
    for (const o of solids) {
      if (o === r || o.y + o.h !== r.y) continue;
      if (!(o.y < r.y && o.y + o.h >= r.y)) continue;
      segs = segs.flatMap(([a, b]) => {
        if (o.x >= b || o.x + o.w <= a) return [[a, b]];
        const res = [];
        if (o.x > a) res.push([a, o.x]);
        if (o.x + o.w < b) res.push([o.x + o.w, b]);
        return res;
      });
    }
    // a solid that overlaps the top band (e.g. block standing on ground) also covers it
    for (const o of solids) {
      if (o === r) continue;
      if (o.y < r.y && o.y + o.h > r.y) {
        segs = segs.flatMap(([a, b]) => {
          if (o.x >= b || o.x + o.w <= a) return [[a, b]];
          const res = [];
          if (o.x > a) res.push([a, o.x]);
          if (o.x + o.w < b) res.push([o.x + o.w, b]);
          return res;
        });
      }
    }
    segs.forEach(([a, b], k) => { if (b - a >= 8) S.push({ x0: a, x1: b, y: r.y, kind: 'solid', id: `s${i}.${k}` }); });
  });
  d.plats.forEach(([x, row, w, bonus], i) => {
    if (bonus && !includeBonus) return;
    S.push({ x0: x * TILE, x1: (x + w) * TILE, y: row * TILE, kind: bonus ? 'bonus' : 'plat', id: `p${i}` });
  });
  d.crumbles.forEach(([x, row, w], i) => S.push({ x0: x * TILE, x1: (x + w) * TILE, y: row * TILE, kind: 'crumble', id: `c${i}` }));
  d.movers.forEach(([x, row, w, dx, dy], i) => {
    S.push({ x0: x * TILE, x1: (x + w) * TILE, y: row * TILE, kind: 'mover', id: `m${i}a`, link: `m${i}b` });
    S.push({ x0: (x + dx) * TILE, x1: (x + dx + w) * TILE, y: (row + dy) * TILE, kind: 'mover', id: `m${i}b`, link: `m${i}a` });
  });
  return S;
}

/** Can a jump with launch speed v from surface A land on surface B? */
function canJump(d, A, B, v) {
  const g = PHYS.gravity * (zoneAt(d, A.x0, A.x1, A.y - 4) ? PHYS.lowGravScale : 1);
  const rise = (v * v) / (2 * g);
  const dyUp = A.y - B.y;
  if (dyUp > rise * RISE_SAFETY) return false;
  const disc = v * v - 2 * g * dyUp;
  if (disc < 0) return false;
  const t = (v + Math.sqrt(disc)) / g;
  const reach = PHYS.runSpeed * t * SAFETY;
  const gap = Math.max(0, B.x0 - A.x1, A.x0 - B.x1);
  return gap <= reach;
}

function canFallOrWalk(A, B) {
  // walking off an edge onto something lower that is horizontally adjacent or overlapping
  if (B.y < A.y) return false;
  const gap = Math.max(0, B.x0 - A.x1, A.x0 - B.x1);
  const fall = B.y - A.y;
  // fall time from rest, run speed reach
  const t = Math.sqrt((2 * fall) / PHYS.gravity);
  return gap <= PHYS.runSpeed * t * SAFETY + 4;
}

function launchFrom(d, A, pads) {
  // bounce pads on surface A give an extra, higher launch from the pad's x position
  const out = [{ src: A, v: PHYS.jumpVel }];
  for (const [x, row] of pads) {
    const px0 = x * TILE;
    const px1 = (x + 1) * TILE;
    if (row * TILE === A.y && px1 > A.x0 && px0 < A.x1) out.push({ src: { x0: px0, x1: px1, y: A.y }, v: PHYS.bounceVel });
  }
  return out;
}

function reachable(d, S, startS, jumpV, extraSources) {
  const seen = new Set();
  const queue = [];
  const push = (s) => { if (!seen.has(s.id)) { seen.add(s.id); queue.push(s); } };
  startS.forEach(push);
  (extraSources || []).forEach(push);
  while (queue.length) {
    const A = queue.shift();
    if (A.link) { const L = S.find((s) => s.id === A.link); if (L) push(L); }
    const launches = launchFrom(d, A, d.bounces).map((l) => (l.v === PHYS.jumpVel ? { src: l.src, v: jumpV } : l));
    for (const B of S) {
      if (seen.has(B.id)) continue;
      if (canFallOrWalk(A, B) || launches.some((l) => canJump(d, l.src, B, l.v))) push(B);
    }
  }
  return seen;
}

function surfaceUnder(S, px, py) {
  // the surface a point at feet height py stands on
  return S.filter((s) => px >= s.x0 - 2 && px <= s.x1 + 2 && Math.abs(s.y - py) < 2);
}

LEVELS.forEach((d, li) => {
  const solids = rects(d);
  const W = d.width * TILE;
  const room = { x: d.secret.room[0] * TILE, y: d.secret.room[1] * TILE, w: d.secret.room[2] * TILE, h: d.secret.room[3] * TILE };
  const inMain = (x) => x < W;

  // --- presence
  if (!d.start) err(li, 'no start position');
  if (!d.goal) err(li, 'no goal');
  if (!d.ground.length) err(li, 'no ground');
  if (d.plats.length + d.crumbles.length + d.movers.length === 0) err(li, 'no platforms');
  const itemTypes = d.items.map((i) => i[0]).sort().join(',');
  if (itemTypes !== 'boots,shield,spring') err(li, `items must be exactly one boots, spring, shield — got ${itemTypes}`);
  if (!d.secret || !d.secret.star) err(li, 'no secret star');
  if (d.secret.room[0] * TILE < W) err(li, 'secret room overlaps the main level');
  if (li === LEVELS.length - 1 && !d.boss) err(li, 'last level needs a boss');

  // --- nothing inside walls
  const coinPts = [];
  for (const [x, row] of d.coins) coinPts.push([x, row]);
  for (const [x, row, n] of d.coinRows) for (let i = 0; i < n; i++) coinPts.push([x + i, row]);
  for (const [x, row, w, n, h] of d.coinArcs) for (let i = 0; i < n; i++) { const f = n === 1 ? 0.5 : i / (n - 1); coinPts.push([x + f * w, row - h * 4 * f * (1 - f)]); }
  const centre = ([x, row]) => [x * TILE + TILE / 2, row * TILE + TILE / 2];
  coinPts.forEach((c) => {
    const [cx, cy] = centre(c);
    if (solids.some((r) => circleHits(cx, cy, 8, r))) err(li, `coin inside a solid at tile ${c[0].toFixed(1)},${c[1].toFixed(1)}`);
    if (cy < 0 || cy > WORLD_ROWS * TILE) err(li, `coin outside the world at ${c}`);
  });
  for (const [type, x, row] of d.items) {
    const [cx, cy] = centre([x, row]);
    if (solids.some((r) => circleHits(cx, cy, 14, r))) err(li, `${type} inside a solid`);
  }
  {
    const [cx, cy] = centre(d.secret.star);
    if (solids.some((r) => circleHits(cx, cy, 14, r))) err(li, 'secret star inside a solid');
    if (!inside(cx, cy, room)) err(li, 'secret star is not inside the secret room');
  }
  {
    const [cx, cy] = centre(d.secret.entry);
    if (solids.some((r) => circleHits(cx, cy, 20, r))) err(li, 'secret entry portal inside a solid');
  }

  // --- fireballs must be duckable but hit a standing cube
  const fbBottom = PHYS.fireballHeight - PHYS.fireballRadius * 0.85;
  const fbTop = PHYS.fireballHeight + PHYS.fireballRadius * 0.85;
  if (fbBottom <= PHYS.duckH - 3 + 0.5) err(li, `fireball (bottom ${fbBottom}px) would hit a ducking cube (${PHYS.duckH}px)`);
  if (fbBottom >= PHYS.playerH - 1) err(li, 'fireball flies over a standing cube — ducking would be pointless');
  void fbTop;

  // --- reachability
  const S = surfaces(d, solids, false).filter((s) => inMain(s.x0));
  const startPx = (d.start[0] + 0.5) * TILE;
  const startS = surfaceUnder(S, startPx, d.start[1] * TILE);
  if (!startS.length) err(li, 'start is not standing on a surface');
  const seen = reachable(d, S, startS, PHYS.jumpVel);
  const goalPx = (d.goal[0] + 0.5) * TILE;
  const goalS = surfaceUnder(S, goalPx, d.goal[1] * TILE);
  if (!goalS.length) err(li, 'goal is not standing on a surface');
  else if (!goalS.some((s) => seen.has(s.id))) {
    // report the furthest reachable point to help fix the data
    const far = Math.max(...S.filter((s) => seen.has(s.id)).map((s) => s.x1)) / TILE;
    err(li, `goal NOT reachable with normal jumps — furthest reachable x ≈ tile ${far.toFixed(1)}`);
  }
  // checkpoints reachable + on ground
  for (const [x, row] of d.checkpoints) {
    const cs = surfaceUnder(S, (x + 0.5) * TILE, row * TILE);
    if (!cs.length) err(li, `checkpoint at ${x} not on a surface`);
    else if (!cs.some((s) => seen.has(s.id))) err(li, `checkpoint at ${x} not reachable`);
  }
  // secret entry reachable by a normal jump from some reachable surface
  {
    const [ex, ey] = centre(d.secret.entry);
    const ok = S.some((s) => seen.has(s.id) && ex >= s.x0 - 3 * TILE && ex <= s.x1 + 3 * TILE &&
      (s.y - PHYS.playerH - ey) < ((PHYS.jumpVel ** 2) / (2 * PHYS.gravity * (zoneAt(d, s.x0, s.x1, s.y - 4) ? PHYS.lowGravScale : 1))) * RISE_SAFETY + 20);
    if (!ok) err(li, 'secret entry portal not reachable');
  }
  // items reachable (they float one tile above a surface)
  for (const [type, x, row] of d.items) {
    const [ix, iy] = centre([x, row]);
    const ok = S.some((s) => seen.has(s.id) && ix >= s.x0 && ix <= s.x1 && s.y - iy < 80 && s.y >= iy);
    if (!ok) err(li, `${type} at tile ${x} is not directly above a reachable surface`);
  }

  // --- bonus platforms: reachable with the super jump after the power-up, and NOT required
  const Sb = surfaces(d, solids, true).filter((s) => inMain(s.x0));
  const superItems = d.items.filter((i) => i[0] !== 'shield');
  d.plats.forEach(([x, row, w, bonus], i) => {
    if (!bonus) return;
    const B = Sb.find((s) => s.id === `p${i}`);
    const normalOK = S.some((A) => seen.has(A.id) && launchFrom(d, A, d.bounces).some((l) => canJump(d, l.src, B, l.v)));
    if (normalOK) warn(li, `bonus platform at ${x},${row} is also reachable without a power-up`);
    const okSuper = superItems.some(([type, ix]) => {
      const dur = type === 'boots' ? PHYS.bootsTime : PHYS.springTime;
      const maxDist = dur * PHYS.runSpeed * 0.5;
      return S.some((A) => seen.has(A.id) && A.x1 >= ix * TILE && Math.abs(A.x0 - ix * TILE) < maxDist && Math.abs(x - ix) * TILE < maxDist &&
        canJump(d, A, B, PHYS.superJumpVel));
    });
    if (!okSuper) err(li, `bonus platform at ${x},${row} is not reachable with a super jump after its power-up`);
  });

  // --- coins must be collectable: within jump reach above some reachable surface
  const allSeen = new Set(seen);
  Sb.filter((s) => s.kind === 'bonus').forEach((s) => allSeen.add(s.id));
  const roomS = surfaces(d, solids, true).filter((s) => !inMain(s.x0));
  coinPts.forEach((c) => {
    const [cx, cy] = centre(c);
    const pool = inMain(cx) ? Sb.filter((s) => allSeen.has(s.id)) : roomS;
    const ok = pool.some((s) => {
      const lg = zoneAt(d, s.x0, s.x1, s.y - 4) || zoneAt(d, cx - 1, cx + 1, cy);
      const v = s.kind === 'bonus' ? PHYS.superJumpVel : Math.max(PHYS.jumpVel, d.bounces.some(([bx, br]) => br * TILE === s.y && bx * TILE >= s.x0 - TILE && bx * TILE <= s.x1) ? PHYS.bounceVel : 0);
      const rise = (v * v) / (2 * PHYS.gravity * (lg ? PHYS.lowGravScale : 1));
      const above = s.y - cy;
      return cx >= s.x0 - 5 * TILE && cx <= s.x1 + 5 * TILE && above <= rise + PHYS.playerH && above >= -4 * TILE;
    });
    if (!ok) err(li, `coin at tile ${c[0].toFixed(1)},${c[1].toFixed(1)} looks unreachable`);
  });

  // --- enemies
  for (const e of d.enemies) {
    const [type, x, row] = e;
    if (type === 'flyer') {
      const [fx, fy] = centre([x, row]);
      if (solids.some((r) => circleHits(fx, fy, 16, r))) err(li, `flyer at ${x} inside a solid`);
      continue;
    }
    const ex = (x + 0.5) * TILE;
    const ok = Sb.some((s) => ex >= s.x0 && ex <= s.x1 && s.y === row * TILE);
    if (!ok) err(li, `${type} at ${x},${row} is not standing on a surface`);
    if (Math.abs(ex - startPx) < 6 * TILE) err(li, `${type} at ${x} is too close to the start`);
  }

  // --- secret room: spawn → star and exit reachable
  {
    const RS = roomS;
    const sp = surfaceUnder(RS, (d.secret.spawn[0] + 0.5) * TILE, d.secret.spawn[1] * TILE);
    if (!sp.length) err(li, 'secret room spawn not on a surface');
    else {
      const rs = reachable(d, RS, sp, PHYS.jumpVel);
      const [sx, sy] = centre(d.secret.star);
      const starOK = RS.some((s) => rs.has(s.id) && sx >= s.x0 - TILE && sx <= s.x1 + TILE && s.y - sy <= (PHYS.jumpVel ** 2) / (2 * PHYS.gravity * (zoneAt(d, s.x0, s.x1, s.y - 4) ? PHYS.lowGravScale : 1)) * RISE_SAFETY + PHYS.playerH && s.y >= sy);
      if (!starOK) err(li, 'secret star not reachable inside the room');
      const [xx, xy] = centre(d.secret.exit);
      const exitOK = RS.some((s) => rs.has(s.id) && xx >= s.x0 && xx <= s.x1 && s.y - xy < 64 && s.y >= xy);
      if (!exitOK) err(li, 'secret room exit not reachable');
    }
    const [rx, ry] = [(d.secret.returnTo[0] + 0.5) * TILE, d.secret.returnTo[1] * TILE];
    const back = surfaceUnder(S, rx, ry);
    if (!back.length || !back.some((s) => seen.has(s.id))) err(li, 'secret room return point is not on a reachable surface');
  }

  // --- boss arena
  if (d.boss) {
    const [a0, a1] = d.boss.arena;
    if (!(d.goal[0] >= a1 - 2)) err(li, 'goal must be at the end of the boss arena');
    const arenaPlats = d.plats.filter(([x, , w, b]) => !b && x >= a0 && x + w <= a1);
    if (arenaPlats.length < 2) err(li, 'boss arena needs platforms to shoot from');
    if (!d.checkpoints.some(([x]) => x < a0 && x > a0 - 10)) err(li, 'boss arena needs a checkpoint at its entrance');
  }

  const len = d.width;
  console.log(`L${li + 1} ${d.name}: ${coinPts.length} coins, ${d.enemies.length} enemies, ${S.length} surfaces, width ${len} tiles, ${seen.size} surfaces reachable`);
});

for (const w of warnings) console.log('WARN  ' + w);
for (const e of errors) console.log('ERROR ' + e);
if (errors.length) {
  console.log(`\n${errors.length} error(s)`);
  process.exit(1);
}
console.log('\nAll levels valid.');
