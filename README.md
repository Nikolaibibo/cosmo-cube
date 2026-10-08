# Cosmo Cube

A 2D side-scrolling space platformer inspired by *The Great Giana Sisters*. Plain HTML5 Canvas and JavaScript, with no libraries and no asset files. Every graphic is drawn in code and every sound and piece of music is synthesised with the Web Audio API.

## How to run

**Double-click `index.html`.** That's it. The game runs straight from `file://` and needs no server. It has been tested in Chrome; Edge uses the same engine. Firefox should work, since the game uses only standard Canvas and Web Audio, but it hasn't been tested.

There is also a landing page: open **`landing.html`** for an overview with screenshots, levels, monsters and controls. Its "Play" buttons open the game. The screenshots are in `assets/`.

Press **ENTER** on the title screen to start. Sound starts with that first key press, because browsers don't allow audio before the player interacts with the page.

**Online:** https://cosmo-cube.web.app (landing page) · https://cosmo-cube.web.app/play (straight into the game). To redeploy after changes, run `firebase deploy --only hosting:cosmo-cube` (Firebase project `nikolaibibo-7f28d`; `tools/` and this README aren't uploaded).

## Controls

| Key | Action |
|---|---|
| **D** | run right |
| **A** | run left |
| **S** | duck: the cube goes flat and low fireballs pass over it |
| **SPACE** | jump (hold it longer to jump higher) |
| **W** | shoot an energy ball in the direction you're facing |
| **P** or **ESC** | pause / resume |
| **M** | mute on/off |
| **C** | retro CRT filter on/off |
| **ENTER** | start / confirm |
| Arrow keys | navigate menus (←/→ also run, ↓ also ducks) |
| **Gamepad** (optional) | left stick or D-pad to move · A jump · X/B shoot · Start pause |

In menus, **W/S** or **↑/↓** select an item, **A/D** change a value, **ENTER** confirms and **ESC** goes back. On the title screen only **↑/↓** move the selection and **C** does nothing, so typing the easter-egg word doesn't jump around the menu or flip the filter.

**Easter egg:** type **STAR** on the title screen.

## The game

- **3 levels:** *Nebula Fields* teaches the mechanics, *Asteroid Belt* adds more gaps, enemies and anti-gravity bubbles, and *Crystal Moon* combines everything and ends with a boss fight against the **Nebula Jelly** (10 hits with W).
- **Monsters:** the *Walker* patrols, the *Fire Shooter* spits fireballs at head height (duck!), and the *Flyer* drops stones (watch for its blinking warning). You can shoot or stomp all three.
- **Items** (each appears once per level):
  - **Super-Jump Boots** give 15 s of super jump.
  - **Spring Guardian** gives 10 s of super jump. If one is already active, picking up the other keeps whichever timer is longer.
  - **Shield** lasts 5 s and protects against fireballs, stones, monsters and the boss. Monsters that touch the shield die. It doesn't save you from a chasm.
- **Power-ups are never required.** Platforms with a **golden edge** can only be reached with a super jump, and they only hold bonus coins.
- **Checkpoints:** beacon pylons in the middle of each level and at the boss arena entrance. After a death you respawn at the last one you passed. Monsters, crumbling platforms and the boss reset. Coins you've collected stay collected.
- **Lives:** unlimited. The level-complete screen counts your deaths.
- **Secret room:** every level hides a faint portal that leads to a secret room with extra coins and a **secret star**. Collecting the star counts as "Secrets found: 1/1".
- **Combo:** collecting coins or defeating monsters within 2 seconds of each other builds a multiplier of up to x8 on your score.
- **Stars per level:**
  - ★ = level finished
  - ★★ = at least 70 % of the coins
  - ★★★ = at least 90 % of the coins, plus the secret star, plus no more than 3 deaths
- **Progress:** best stars, best coin count and secrets are saved in your browser's `localStorage`. If the browser blocks storage (some do for `file://`), the game still runs and progress lasts only until you close the tab.
- **Settings:** volume, mute, screen shake, CRT filter and **Reduce flashing**, which tones down the portal, supernova and boss flashes.

## If something doesn't work

| Problem | What to do |
|---|---|
| Black screen | Make sure `index.html`, `game.js` and `style.css` are in the same folder. Open the browser console with F12 and look for errors. |
| No sound | Press a key first: audio starts with the first key press. Check that the game isn't muted (**M**) and that the volume under *Settings* isn't at 0. |
| Keys do nothing | Click into the game window once so it has keyboard focus. |
| Progress isn't saved | In Chrome, saving works straight from `file://` (tested: the save survives a reload). If your browser blocks storage for local files, the game still runs but forgets progress when you close the tab. Serving the folder fixes that: `python -m http.server`, then open `http://localhost:8000`. |
| Game stutters | Turn off the CRT filter (**C**) and close other heavy tabs. The particle system caps at 1,500 particles. |

## For developers

- `game.js` is split into clearly marked sections: constants, helpers, LEVELS, Save, AudioEngine, Input, Particles, Camera, SpaceBackground, Level, Player, enemies and projectiles, Boss, UI, Game, and boot.
- **Levels are plain data** at the top of `game.js` (`const LEVELS`). Coordinates are in tiles (32 px), and a comment above the array explains every field. After editing, run the validator.
- The loop runs at a fixed 60 Hz timestep with an accumulator. Frame gaps are clamped to 0.25 s, so switching tabs never breaks the physics. Movement is resolved one axis at a time in ≤ 6 px sub-steps, so nothing tunnels through walls.

### Tests

Run these from the project folder. The first three need Node.js 18 or newer. `browser-test.js` needs Node.js 22 or newer (it uses the built-in `WebSocket`) and Chrome; set `CHROME=<path>` if Chrome isn't in its default location.

```sh
node --check game.js               # syntax check
node tools/validate-levels.js      # level data: start/goal, items, nothing in walls, every level completable
node tools/headless-test.js        # 25 gameplay tests in Node with a stubbed canvas (moves, jumps, deaths, boss, menus …)
node tools/browser-test.js         # real headless Chrome: real key events, zero console errors/warnings, screenshots → tools/out/
```

**`validate-levels.js`** checks that each level can be completed from start to goal using **normal jumps only**. The check uses the game's own physics constants with a 15 % safety margin. Bounce pads and low-gravity zones count toward the route; power-up platforms don't. It also checks that every bonus platform can be reached with a super jump after its power-up.

**What the tests can't tell you** is whether a level is fun, how hard it really is, or how long it takes. Sprinting from start to goal with no stops takes 53–56 s per level (computed from length ÷ run speed). The target is about 3 minutes for an average player, who will stop for enemies and take detours for coins. That figure is an estimate and hasn't been measured with real players. The boss test fires at the boss with an invincible player: it proves the boss can be defeated, but not how fair the arena feels.
