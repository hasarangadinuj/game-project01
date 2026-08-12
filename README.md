# 🦖 Dino Rush

An endless runner built with vanilla JavaScript and the HTML5 Canvas. No frameworks, no dependencies, no build step — three files and a browser.

Run far. Duck low. Don't get eaten.

## Play

Clone the repo and open `index.html` in any modern browser:

```bash
git clone https://github.com/hasarangadinuj/game-project01.git
cd game-project01
```

That's it — double-click `index.html`, or serve the folder if you prefer:

```bash
python -m http.server 8000   # then visit http://localhost:8000
```

There is nothing to install and nothing to compile.

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Jump | `Space` / `↑` / `W` — hold to jump higher | Tap the top of the stage |
| Duck / fast-fall | `↓` / `S` | Hold the bottom of the stage |
| Pause | `P` or `Esc` | — |
| Mute | `M` | — |
| Restart | `R` | — |

Jump height is variable: a quick tap clears the small cactus, a held jump clears everything. Ducking mid-air pulls you down fast, which is often the quicker way out of trouble.

## Gameplay

**Obstacles.** Cacti come in three flavours — small, tall, and clusters of two or three that read as one wide wall. Once you pass 420 points, birds start showing up at two fixed heights: the low one must be jumped, the high one must be ducked under.

**Scoring.** Points accrue with distance. On top of that:

- **Coins** — strung in tempting arcs over obstacles, so the reward is paid out for a jump you already had to make. Collecting them back-to-back builds a streak that raises their value (up to +100% at a ten-coin streak).
- **Near misses** — squeeze within 16px of an obstacle while airborne or ducking and you bank a bonus.
- **Milestones** — every 500 points triggers a flash and a chime.

**Power-ups.** One drops every 15–24 seconds, and only ever into clear air — a pickup sitting inside a cactus would be a trap rather than a reward.

| | Effect |
| --- | --- |
| 🛡 **Shield** | Absorbs one hit, then grants 1.5s of invulnerability to walk out of the hitbox |
| ✨ **Double points** | 2× score for 10 seconds, coins included |
| 🧲 **Magnet** | Coins within 190px peel off their arc and chase you, for 9 seconds |

**Difficulty.** Speed ramps from 340 to 900 px/s over the first 26,000 units of distance, and the gap between spawns is measured in *seconds* rather than pixels — so running faster means jumping earlier. That, plus a tightening spawn interval, is where the pressure comes from.

**Day/night.** The sky cycles every 20,000 distance units, blended with a smoothstep so dusk isn't a hard cut. Stars, the sun/moon, and the ground palette all shift with it.

Your best score is saved to `localStorage` and survives a reload.

## Project structure

```
index.html   markup, the canvas, and the control legend
style.css    page chrome, responsive stage, dark palette
script.js    the entire game (~1,470 lines)
```

`script.js` is organised in seven labelled sections:

1. Canvas, constants, math helpers
2. Audio
3. Input
4. World state, reset and spawning
5. Simulation
6. Rendering
7. Main loop

## Implementation notes

A few things worth calling out for anyone reading the source:

- **Fixed timestep.** Physics runs at a fixed 120Hz accumulator, decoupled from `requestAnimationFrame`. The game behaves identically on a 60Hz laptop and a 144Hz monitor, and a lag spike can't let an obstacle tunnel through the player.
- **No assets.** Every sprite is drawn with canvas primitives, and every sound is synthesised with WebAudio oscillators at runtime. There are no images, no audio files, and no network requests.
- **Resolution independent.** The game is authored against a fixed 800×300 logical stage, then scaled to the CSS box and the device pixel ratio, so it stays crisp on retina screens and playable on phones.
- **Forgiving input.** Coyote time (90ms) lets you still jump just after walking off an edge, and jump buffering (120ms) queues a jump pressed slightly too early so it fires on landing.
- **Deterministic scenery.** Mountain ridges, stars, and ground detail come from a seeded LCG, so the horizon looks identical on every reload while the obstacles stay random.
- **Auto-pause.** Losing window focus or backgrounding the tab pauses the run rather than costing you a life.

Load the page with `#debug` in the URL to expose a `window.DinoRush` handle with live state, the player object, and a `start()` method for tuning.

## Browser support

Any browser with Canvas 2D, WebAudio, and Pointer Events — Chrome, Firefox, Safari, and Edge, on desktop and mobile. The audio context is created on your first keypress or tap, as browsers require; your mute preference is remembered between sessions.
