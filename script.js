/* ===========================================================================
   DINO RUSH
   An endless runner in vanilla JS + Canvas. No dependencies, no build step.

   Layout of this file:
     1. Canvas, constants, math helpers
     2. Audio (synthesised with WebAudio -- no asset files)
     3. Input (keyboard + touch, with coyote time and jump buffering)
     4. World state, reset and spawning
     5. Simulation (fixed timestep)
     6. Rendering (parallax world, sprites, HUD, overlays)
     7. Main loop
   =========================================================================== */

(() => {
"use strict";

/* --- 1. canvas, constants, helpers --------------------------------------- */

// The game is authored against a fixed 800x300 logical stage; the canvas is
// then scaled to whatever the CSS box happens to be (and to the device pixel
// ratio) so it stays crisp on retina screens and playable on phones.
const W = 800;
const H = 300;
const GROUND_Y = 252;             // y of the ground surface, in logical px

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.getBoundingClientRect().width || W;
    const cssH = cssW * (H / W);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const s = (cssW / W) * dpr;
    ctx.setTransform(s, 0, 0, s, 0, 0);
}
window.addEventListener("resize", resize);
window.addEventListener("load", resize);

// Physics. Tuned so a full-height jump peaks near 130px (clears everything)
// and a quick tap peaks near 85px (clears the small cactus only).
const GRAVITY      = 2500;        // px/s^2, applied while falling
const RISE_HOLD    = 0.82;        // gravity scale while rising, jump held
const RISE_RELEASE = 1.90;        // gravity scale while rising, jump released
const FAST_FALL    = 2.20;        // gravity scale while ducking mid-air
const JUMP_V       = -730;        // px/s launch velocity
const MAX_FALL     = 1500;
const COYOTE       = 0.09;        // grace to still jump after leaving ground
const JUMP_BUFFER  = 0.12;        // grace to queue a jump before landing

const STAND_W = 44, STAND_H = 47;
const DUCK_W  = 58, DUCK_H  = 28;

const SPEED_MIN = 340;            // px/s at the start
const SPEED_MAX = 900;            // px/s once fully ramped
const RAMP_DIST = 26000;          // distance over which difficulty maxes out

const BEST_KEY = "dinorush.best";
const MUTE_KEY = "dinorush.muted";

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
// smoothstep -- used for the day/night blend so dusk is not a hard cut
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function fillRR(x, y, w, h, r, color) {
    ctx.fillStyle = color;
    roundRect(x, y, w, h, r);
    ctx.fill();
}

function circle(x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
}

function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
}

// Deterministic RNG, so the mountain ridges look identical every reload.
function seeded(seed) {
    let r = seed >>> 0 || 1;
    return () => {
        r = (r * 1664525 + 1013904223) >>> 0;
        return r / 4294967296;
    };
}

const hexCache = new Map();
function toRGB(hex) {
    let v = hexCache.get(hex);
    if (!v) {
        v = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
        hexCache.set(hex, v);
    }
    return v;
}
function mix(a, b, t) {
    const A = toRGB(a), B = toRGB(b);
    return "rgb(" + Math.round(lerp(A[0], B[0], t)) + "," +
                    Math.round(lerp(A[1], B[1], t)) + "," +
                    Math.round(lerp(A[2], B[2], t)) + ")";
}

/* --- 2. audio ------------------------------------------------------------ */

// Everything is synthesised on the fly so the game stays a three-file drop-in.
const Sound = (() => {
    let actx = null, master = null;
    let muted = localStorage.getItem(MUTE_KEY) === "1";

    function ensure() {
        if (actx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        actx = new AC();
        master = actx.createGain();
        master.gain.value = 0.16;
        master.connect(actx.destination);
    }

    function tone(freq, dur, type, vol, slideTo) {
        if (muted) return;
        ensure();
        if (!actx) return;
        if (actx.state === "suspended") actx.resume();
        const t = actx.currentTime;
        const osc = actx.createOscillator();
        const gain = actx.createGain();
        osc.type = type || "square";
        osc.frequency.setValueAtTime(freq, t);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(vol, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain);
        gain.connect(master);
        osc.start(t);
        osc.stop(t + dur + 0.03);
    }

    const later = (ms, fn) => setTimeout(fn, ms);

    return {
        jump:   () => tone(430, 0.12, "square", 0.42, 720),
        land:   () => tone(150, 0.06, "sine", 0.28),
        coin:   (streak) => {
            const p = Math.pow(1.06, Math.min(streak || 0, 12));
            tone(880 * p, 0.08, "square", 0.32);
            later(55, () => tone(1320 * p, 0.09, "square", 0.24));
        },
        power:  () => {
            tone(520, 0.10, "triangle", 0.42, 1040);
            later(90, () => tone(1040, 0.18, "triangle", 0.34, 1560));
        },
        shield: () => tone(760, 0.28, "triangle", 0.42, 190),
        hit:    () => {
            tone(220, 0.40, "sawtooth", 0.48, 55);
            later(40, () => tone(140, 0.34, "square", 0.30, 40));
        },
        milestone: () => {
            tone(660, 0.08, "square", 0.32);
            later(85, () => tone(990, 0.14, "square", 0.32));
        },
        nearMiss: () => tone(1180, 0.06, "sine", 0.20, 1500),
        get muted() { return muted; },
        toggle() {
            muted = !muted;
            localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
            if (!muted) this.milestone();
            return muted;
        },
        unlock() {
            ensure();
            if (actx && actx.state === "suspended") actx.resume();
        }
    };
})();

/* --- 3. input ------------------------------------------------------------ */

const JUMP_KEYS = new Set(["Space", "ArrowUp", "KeyW"]);
const DUCK_KEYS = new Set(["ArrowDown", "KeyS"]);

const input = { jumpHeld: false, duckHeld: false, jumpBuffer: 0 };

window.addEventListener("keydown", (e) => {
    if (JUMP_KEYS.has(e.code) || DUCK_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    Sound.unlock();

    if (JUMP_KEYS.has(e.code)) {
        input.jumpHeld = true;
        input.jumpBuffer = JUMP_BUFFER;
        primaryAction();
    }
    if (DUCK_KEYS.has(e.code)) input.duckHeld = true;
    if (e.code === "KeyM") Sound.toggle();
    if (e.code === "KeyP" || e.code === "Escape") togglePause();
    if (e.code === "KeyR" && state !== "menu") restart();
});

window.addEventListener("keyup", (e) => {
    if (JUMP_KEYS.has(e.code)) input.jumpHeld = false;
    if (DUCK_KEYS.has(e.code)) input.duckHeld = false;
});

// Touch / mouse: the top of the stage jumps, the bottom ducks. Holding works
// for both, so variable jump height and fast-fall survive on a phone.
canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    Sound.unlock();
    const rect = canvas.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / rect.height;
    if (state === "playing" && rel > 0.6) {
        input.duckHeld = true;
    } else {
        input.jumpHeld = true;
        input.jumpBuffer = JUMP_BUFFER;
        primaryAction();
    }
});

function releasePointer() {
    input.jumpHeld = false;
    input.duckHeld = false;
}
window.addEventListener("pointerup", releasePointer);
window.addEventListener("pointercancel", releasePointer);

// Losing focus mid-run should not cost a life.
window.addEventListener("blur", () => {
    releasePointer();
    if (state === "playing") setPaused(true);
});
document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "playing") setPaused(true);
});

/* --- 4. world state ------------------------------------------------------ */

let state = "menu";               // menu | playing | paused | over

const player = {
    x: 64, y: GROUND_Y - STAND_H, w: STAND_W, h: STAND_H,
    vy: 0, onGround: true, ducking: false,
    runPhase: 0, coyote: 0, blink: 2, dead: false, deadSpin: 0
};

let distance, score, speed, diff, time;
let obstacles, coins, powerups, particles, floaters, clouds;
let spawnTimer, powerSpawnTimer, nextMilestone;
let shake, flash, overTimer;
let coinStreak, streakTimer;
let shieldCharged, invuln, x2Time, magnetTime;
let newBest;

let best = parseInt(localStorage.getItem(BEST_KEY) || "0", 10) || 0;

// --- static scenery, generated once ---------------------------------------

const RIDGE_W = 1600;

function makeRidge(step, baseY, ampMin, ampMax, seed) {
    const rnd = seeded(seed);
    const pts = [];
    for (let x = 0; x <= RIDGE_W; x += step) {
        pts.push({ x, y: baseY - lerp(ampMin, ampMax, rnd()) });
    }
    pts[pts.length - 1].y = pts[0].y;   // seamless tile
    return pts;
}

const farRidge = makeRidge(80, 214, 26, 78, 1337);
const midRidge = makeRidge(52, 240, 14, 42, 90210);

const stars = (() => {
    const rnd = seeded(7);
    const out = [];
    for (let i = 0; i < 90; i++) {
        out.push({ x: rnd() * W, y: rnd() * 170, r: 0.6 + rnd() * 1.2, tw: rnd() * 6.28 });
    }
    return out;
})();

const groundMarks = (() => {
    const rnd = seeded(4242);
    const out = [];
    for (let x = 0; x < RIDGE_W; x += 14 + rnd() * 34) {
        out.push({ x, w: 6 + rnd() * 20, y: 6 + rnd() * 32, dot: rnd() > 0.72 });
    }
    return out;
})();

// Parallax scroll offsets, one per depth layer.
const layer = { far: 0, mid: 0, ground: 0 };

let nightAmt = 0;
let dayCycle = 0;

/* --- reset --------------------------------------------------------------- */

function resetWorld() {
    distance = 0;
    score = 0;
    speed = SPEED_MIN;
    diff = 0;
    time = 0;

    obstacles = [];
    coins = [];
    powerups = [];
    particles = [];
    floaters = [];
    clouds = [];
    for (let i = 0; i < 5; i++) {
        clouds.push({ x: rand(0, W), y: rand(28, 120), s: rand(0.55, 1.25), f: rand(0.05, 0.14) });
    }

    spawnTimer = 1.9;                 // a beat to get your bearings before the first cactus
    powerSpawnTimer = rand(11, 16);
    nextMilestone = 500;

    shake = 0;
    flash = 0;
    overTimer = 0;

    coinStreak = 0;
    streakTimer = 0;

    shieldCharged = false;
    invuln = 0;
    x2Time = 0;
    magnetTime = 0;
    newBest = false;

    player.w = STAND_W;
    player.h = STAND_H;
    player.y = GROUND_Y - STAND_H;
    player.vy = 0;
    player.onGround = true;
    player.ducking = false;
    player.dead = false;
    player.deadSpin = 0;
    player.coyote = 0;
    player.runPhase = 0;

    input.jumpBuffer = 0;
}

function startRun() {
    resetWorld();
    state = "playing";
}

function restart() {
    if (state === "over" && overTimer < 0.55) return;  // ignore mash-through
    startRun();
}

function setPaused(on) {
    if (on && state === "playing") state = "paused";
    else if (!on && state === "paused") state = "playing";
}

function togglePause() {
    if (state === "playing") setPaused(true);
    else if (state === "paused") setPaused(false);
}

// Space / tap does the contextually obvious thing.
function primaryAction() {
    if (state === "menu") startRun();
    else if (state === "paused") setPaused(false);
    else if (state === "over") restart();
}

/* --- spawning ------------------------------------------------------------ */

// Obstacle kinds. Birds only appear once the player has warmed up, and the
// two bird heights are chosen so one must be jumped and one must be ducked.
function spawnObstacle() {
    const roll = Math.random();
    const canFly = score > 420;

    if (canFly && roll < 0.26) {
        const duckUnder = Math.random() < 0.55;
        obstacles.push({
            kind: "bird",
            x: W + 30,
            baseY: duckUnder ? GROUND_Y - 66 : GROUND_Y - 36,
            y: 0,
            w: 44, h: 30,
            bob: rand(0, 6.28),
            extra: 1.16,              // birds fly a touch faster than the ground
            flap: 0,
            passed: false, minGap: 1e9
        });
        return;
    }

    let ob;
    if (roll < 0.44) {
        ob = cactus(24, 40);
    } else if (roll < 0.72) {
        ob = cactus(32, 58);
    } else {
        // a cluster reads as one wide wall -- same jump, more menace
        const n = randInt(2, 3);
        ob = cactus(n * 24, 44, n);
    }
    obstacles.push(ob);

    // String the reward arc over the thing that was just spawned, so the coins
    // are paid out for the jump the player already had to make.
    if (Math.random() < 0.45) spawnCoinArc(ob.x + ob.w / 2);
}

function cactus(w, h, count) {
    return {
        kind: "cactus",
        x: W + 20,
        y: GROUND_Y - h,
        w, h,
        count: count || 1,
        extra: 1,
        passed: false, minGap: 1e9
    };
}

// A tempting arc of coins, usually strung over whatever was just spawned.
function spawnCoinArc(centerX) {
    const n = randInt(4, 6);
    const spread = 54 + n * 12;
    const peak = rand(70, 104);
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        coins.push({
            x: centerX - spread / 2 + spread * t,
            y: GROUND_Y - 34 - Math.sin(t * Math.PI) * peak,
            r: 9,
            phase: rand(0, 6.28),
            vx: 0, vy: 0,
            gone: false
        });
    }
}

const POWER_KINDS = ["shield", "x2", "magnet"];

function spawnPowerup() {
    powerups.push({
        kind: pick(POWER_KINDS),
        x: W + 40,
        y: GROUND_Y - rand(70, 120),
        r: 15,
        phase: rand(0, 6.28),
        gone: false
    });
}

/* --- particles and floating text ----------------------------------------- */

function puff(x, y, n, color, spread, speedScale) {
    for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2);
        const s = rand(20, 90) * (speedScale || 1);
        particles.push({
            x: x + rand(-spread, spread), y: y + rand(-spread, spread),
            vx: Math.cos(a) * s - speed * 0.25,
            vy: Math.sin(a) * s - 20,
            life: rand(0.3, 0.7), max: 0.7,
            size: rand(2, 5),
            color, gravity: 240
        });
    }
}

function debris(x, y) {
    for (let i = 0; i < 26; i++) {
        const a = rand(-Math.PI, 0);
        const s = rand(90, 330);
        particles.push({
            x, y,
            vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rand(0.5, 1.1), max: 1.1,
            size: rand(2, 6),
            color: pick(["#4ade80", "#22c55e", "#facc15", "#f87171"]),
            gravity: 900
        });
    }
}

function floater(x, y, text, color) {
    floaters.push({ x, y, text, color, life: 0.9, max: 0.9 });
}

/* --- 5. simulation ------------------------------------------------------- */

function scoreMult() { return x2Time > 0 ? 2 : 1; }

function playerBox() {
    // A hitbox slightly smaller than the drawing -- generous feels better.
    return player.ducking
        ? { x: player.x + 6, y: player.y + 4, w: player.w - 14, h: player.h - 5 }
        : { x: player.x + 9, y: player.y + 6, w: player.w - 20, h: player.h - 8 };
}

function step(dt) {
    time += dt;

    if (state !== "playing") {
        // Keep the scenery alive behind the menu and the game-over card.
        if (state === "menu") {
            layer.far += 20 * dt;
            layer.mid += 40 * dt;
            layer.ground += 90 * dt;
            player.runPhase += 90 * 0.02 * dt * 8;
        }
        if (state === "over") overTimer += dt;
        updateParticles(dt);
        updateFloaters(dt);
        shake = Math.max(0, shake - dt * 26);
        flash = Math.max(0, flash - dt * 2.6);
        if (state === "over") {
            player.deadSpin = Math.min(0.5, player.deadSpin + dt * 1.6);
        }
        return;
    }

    // --- difficulty ramp ---
    diff = clamp(distance / RAMP_DIST, 0, 1);
    speed = lerp(SPEED_MIN, SPEED_MAX, diff * diff * (3 - 2 * diff));
    distance += speed * dt;
    score += speed * dt * 0.10 * scoreMult();

    if (score >= nextMilestone) {
        nextMilestone += 500;
        flash = 0.55;
        Sound.milestone();
        floater(W / 2, 96, Math.floor(score / 500) * 500 + "!", "#ffd35c");
    }

    // --- parallax ---
    layer.far += speed * 0.10 * dt;
    layer.mid += speed * 0.32 * dt;
    layer.ground += speed * dt;

    dayCycle = (distance / 20000) % 1;
    nightAmt = dayCycle < 0.40 ? 0
             : dayCycle < 0.56 ? smooth((dayCycle - 0.40) / 0.16)
             : dayCycle < 0.88 ? 1
             : 1 - smooth((dayCycle - 0.88) / 0.12);

    for (const c of clouds) {
        c.x -= speed * c.f * dt;
        if (c.x < -90) { c.x = W + rand(20, 160); c.y = rand(24, 120); c.s = rand(0.55, 1.25); }
    }

    // --- timers ---
    invuln = Math.max(0, invuln - dt);
    x2Time = Math.max(0, x2Time - dt);
    magnetTime = Math.max(0, magnetTime - dt);
    shake = Math.max(0, shake - dt * 26);
    flash = Math.max(0, flash - dt * 2.6);

    if (streakTimer > 0) {
        streakTimer -= dt;
        if (streakTimer <= 0) coinStreak = 0;
    }

    updatePlayer(dt);
    updateObstacles(dt);
    updateCoins(dt);
    updatePowerups(dt);
    updateParticles(dt);
    updateFloaters(dt);

    // --- spawning ---
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
        spawnObstacle();
        // Gap measured in seconds, so faster running means jumping earlier --
        // that ramp, plus the tightening factor, is where the pressure comes from.
        spawnTimer = rand(1.15, 2.10) * lerp(1.0, 0.80, diff);
    }

    // Only drop a power-up into clear air -- one sitting inside a cactus would
    // be a trap rather than a reward.
    powerSpawnTimer -= dt;
    if (powerSpawnTimer <= 0 && spawnTimer > 0.5 && !obstacleNear(W + 40, 180)) {
        spawnPowerup();
        powerSpawnTimer = rand(15, 24);
    }
}

function obstacleNear(x, range) {
    for (const ob of obstacles) {
        if (Math.abs(ob.x + ob.w / 2 - x) < range) return true;
    }
    return false;
}

function updatePlayer(dt) {
    const p = player;

    // Ducking only changes the silhouette on the ground; in the air the same
    // key buys a fast-fall instead.
    const wantDuck = input.duckHeld && p.onGround;
    if (wantDuck !== p.ducking) {
        p.ducking = wantDuck;
        const bottom = p.y + p.h;
        p.w = wantDuck ? DUCK_W : STAND_W;
        p.h = wantDuck ? DUCK_H : STAND_H;
        p.y = bottom - p.h;
    }

    // Coyote time + jump buffering: the two forgiveness tricks that make an
    // endless runner feel fair instead of twitchy.
    if (p.onGround) p.coyote = COYOTE;
    else p.coyote = Math.max(0, p.coyote - dt);
    input.jumpBuffer = Math.max(0, input.jumpBuffer - dt);

    if (input.jumpBuffer > 0 && p.coyote > 0) {
        p.vy = JUMP_V;
        p.onGround = false;
        p.coyote = 0;
        input.jumpBuffer = 0;
        if (p.ducking) {
            p.ducking = false;
            const bottom = p.y + p.h;
            p.w = STAND_W; p.h = STAND_H; p.y = bottom - p.h;
        }
        Sound.jump();
        puff(p.x + p.w / 2, GROUND_Y - 2, 6, "#cbd5e1", 6, 0.7);
    }

    let g = GRAVITY;
    if (p.vy < 0) g *= input.jumpHeld ? RISE_HOLD : RISE_RELEASE;
    else if (input.duckHeld && !p.onGround) g *= FAST_FALL;

    p.vy = Math.min(MAX_FALL, p.vy + g * dt);
    p.y += p.vy * dt;

    const floorY = GROUND_Y - p.h;
    if (p.y >= floorY) {
        if (!p.onGround) {
            Sound.land();
            puff(p.x + p.w / 2, GROUND_Y - 2, 7, "#cbd5e1", 8, 0.8);
            shake = Math.max(shake, 1.4);
        }
        p.y = floorY;
        p.vy = 0;
        p.onGround = true;
    }

    // Running animation + an occasional blink, purely for personality.
    if (p.onGround) p.runPhase += speed * 0.055 * dt;
    p.blink -= dt;
    if (p.blink < -0.12) p.blink = rand(2.2, 5.0);

    if (p.onGround && Math.random() < speed * dt * 0.012) {
        puff(p.x + 4, GROUND_Y - 3, 1, "#94a3b8", 3, 0.4);
    }
}

function updateObstacles(dt) {
    const box = playerBox();

    for (let i = obstacles.length - 1; i >= 0; i--) {
        const ob = obstacles[i];
        ob.x -= speed * ob.extra * dt;

        if (ob.kind === "bird") {
            ob.bob += dt * 5;
            ob.y = ob.baseY + Math.sin(ob.bob) * 4;
            ob.flap += dt * 14;
        }

        const hit = { x: ob.x + 5, y: ob.y + 4, w: ob.w - 10, h: ob.h - 7 };

        // Track the closest the player got, for the near-miss bonus.
        if (box.x < hit.x + hit.w && box.x + box.w > hit.x) {
            const gap = box.y > hit.y
                ? box.y - (hit.y + hit.h)
                : hit.y - (box.y + box.h);
            ob.minGap = Math.min(ob.minGap, Math.max(0, gap));
        }

        if (!player.dead && overlaps(box, hit)) {
            takeHit(ob);
        }

        if (!ob.passed && ob.x + ob.w < player.x) {
            ob.passed = true;
            // Squeaking under a bird counts too, not just clearing a cactus.
            if (ob.minGap < 16 && (!player.onGround || player.ducking)) {
                score += 40 * scoreMult();
                Sound.nearMiss();
                floater(player.x + 30, player.y - 12, "NEAR MISS +" + 40 * scoreMult(), "#67e8f9");
            }
        }

        if (ob.x < -ob.w - 40) obstacles.splice(i, 1);
    }
}

function updateCoins(dt) {
    const box = playerBox();
    const pcx = box.x + box.w / 2, pcy = box.y + box.h / 2;

    for (let i = coins.length - 1; i >= 0; i--) {
        const c = coins[i];
        c.x -= speed * dt;
        c.phase += dt * 6;

        // Magnet: coins in range peel off their arc and chase the player.
        if (magnetTime > 0) {
            const dx = pcx - c.x, dy = pcy - c.y;
            const d = Math.hypot(dx, dy);
            if (d < 190 && d > 0.1) {
                const pull = (1 - d / 190) * 1400 * dt;
                c.x += (dx / d) * pull;
                c.y += (dy / d) * pull;
            }
        }

        const cb = { x: c.x - c.r, y: c.y - c.r, w: c.r * 2, h: c.r * 2 };
        if (overlaps(box, cb)) {
            coins.splice(i, 1);
            coinStreak++;
            streakTimer = 2.6;
            const value = Math.round(25 * scoreMult() * (1 + Math.min(coinStreak, 10) * 0.1));
            score += value;
            Sound.coin(coinStreak);
            puff(c.x, c.y, 5, "#ffd35c", 3, 0.6);
            floater(c.x, c.y - 6, "+" + value, "#ffd35c");
            continue;
        }

        if (c.x < -30) coins.splice(i, 1);
    }
}

function updatePowerups(dt) {
    const box = playerBox();

    for (let i = powerups.length - 1; i >= 0; i--) {
        const pu = powerups[i];
        pu.x -= speed * dt;
        pu.phase += dt * 3;

        const pb = { x: pu.x - pu.r, y: pu.y - pu.r, w: pu.r * 2, h: pu.r * 2 };
        if (overlaps(box, pb)) {
            powerups.splice(i, 1);
            applyPowerup(pu.kind);
            continue;
        }
        if (pu.x < -40) powerups.splice(i, 1);
    }
}

function applyPowerup(kind) {
    Sound.power();
    flash = Math.max(flash, 0.4);
    if (kind === "shield") {
        shieldCharged = true;
        floater(player.x + 24, player.y - 16, "SHIELD", "#67e8f9");
    } else if (kind === "x2") {
        x2Time = 10;
        floater(player.x + 24, player.y - 16, "DOUBLE POINTS", "#f0abfc");
    } else {
        magnetTime = 9;
        floater(player.x + 24, player.y - 16, "MAGNET", "#fca5a5");
    }
    puff(player.x + player.w / 2, player.y + player.h / 2, 14, "#ffffff", 10, 1.2);
}

function takeHit(ob) {
    if (invuln > 0) return;

    if (shieldCharged) {
        shieldCharged = false;
        invuln = 1.5;                       // long enough to walk out of the hitbox
        shake = 7;
        flash = 0.5;
        Sound.shield();
        puff(player.x + player.w / 2, player.y + player.h / 2, 18, "#67e8f9", 12, 1.4);
        floater(player.x + 24, player.y - 18, "BLOCKED!", "#67e8f9");
        return;
    }

    player.dead = true;
    state = "over";
    overTimer = 0;
    shake = 14;
    flash = 0.85;
    coinStreak = 0;
    Sound.hit();
    debris(player.x + player.w / 2, player.y + player.h / 2);

    const final = Math.floor(score);
    if (final > best) {
        best = final;
        newBest = true;
        localStorage.setItem(BEST_KEY, String(best));
    }
}

function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.y > GROUND_Y) { p.y = GROUND_Y; p.vy *= -0.35; p.vx *= 0.7; }
    }
}

function updateFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
        const f = floaters[i];
        f.life -= dt;
        f.y -= 34 * dt;
        if (f.life <= 0) floaters.splice(i, 1);
    }
}

/* --- 6. rendering -------------------------------------------------------- */

function render() {
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    if (shake > 0.05) {
        ctx.translate(rand(-shake, shake), rand(-shake, shake));
    }

    drawSky();
    drawStars();
    drawCelestial();
    drawRidge(farRidge, layer.far, mix("#8fb2d9", "#1b2450", nightAmt));
    drawClouds();
    drawRidge(midRidge, layer.mid, mix("#6f9ac4", "#141c3e", nightAmt));
    drawGround();

    drawCoins();
    drawPowerups();
    drawObstacles();
    drawParticles();
    drawPlayer();

    // One translucent pass unifies every sprite with the night palette.
    if (nightAmt > 0.01) {
        ctx.fillStyle = "rgba(10,16,44," + (0.30 * nightAmt).toFixed(3) + ")";
        ctx.fillRect(0, 0, W, H);
    }

    drawSpeedLines();
    drawFloaters();
    ctx.restore();

    if (flash > 0.01) {
        ctx.fillStyle = "rgba(255,255,255," + (flash * 0.28).toFixed(3) + ")";
        ctx.fillRect(0, 0, W, H);
    }

    drawHUD();
    if (state === "menu") drawMenu();
    else if (state === "paused") drawPaused();
    else if (state === "over") drawGameOver();
}

function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    g.addColorStop(0, mix("#5ab0f0", "#060b22", nightAmt));
    g.addColorStop(0.55, mix("#a8d8f5", "#0d1435", nightAmt));
    g.addColorStop(1, mix("#ffe8c2", "#161d47", nightAmt));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, GROUND_Y);
}

function drawStars() {
    if (nightAmt < 0.02) return;
    for (const s of stars) {
        const tw = 0.55 + 0.45 * Math.sin(time * 2 + s.tw);
        ctx.fillStyle = "rgba(255,255,255," + (nightAmt * tw * 0.9).toFixed(3) + ")";
        ctx.fillRect(s.x, s.y, s.r, s.r);
    }
}

function drawCelestial() {
    // Sun and moon ride the same arc, half a cycle apart.
    const arc = (phase) => {
        const t = (phase % 1 + 1) % 1;
        return { x: W * (0.12 + t * 0.78), y: 190 - Math.sin(t * Math.PI) * 150 };
    };
    const sun = arc(dayCycle * 2);
    const moon = arc(dayCycle * 2 + 0.5);

    if (nightAmt < 0.98) {
        ctx.globalAlpha = 1 - nightAmt;
        circle(sun.x, sun.y, 26, "rgba(255,214,120,0.22)");
        circle(sun.x, sun.y, 16, "#ffd35c");
        ctx.globalAlpha = 1;
    }
    if (nightAmt > 0.02) {
        ctx.globalAlpha = nightAmt;
        circle(moon.x, moon.y, 22, "rgba(226,232,255,0.16)");
        circle(moon.x, moon.y, 13, "#e6ecff");
        circle(moon.x + 5, moon.y - 4, 11, mix("#a8d8f5", "#0d1435", nightAmt));
        ctx.globalAlpha = 1;
    }
}

function drawRidge(pts, offset, color) {
    const span = RIDGE_W;
    const start = -(offset % span);
    ctx.fillStyle = color;
    for (let k = 0; k < 2; k++) {
        const ox = start + k * span;
        if (ox > W) break;
        ctx.beginPath();
        ctx.moveTo(ox, GROUND_Y);
        for (const p of pts) ctx.lineTo(ox + p.x, p.y);
        ctx.lineTo(ox + span, GROUND_Y);
        ctx.closePath();
        ctx.fill();
    }
}

function drawClouds() {
    ctx.fillStyle = "rgba(255,255,255," + lerp(0.85, 0.16, nightAmt).toFixed(3) + ")";
    for (const c of clouds) {
        const s = c.s;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 13 * s, 0, 6.29);
        ctx.arc(c.x + 16 * s, c.y + 4 * s, 10 * s, 0, 6.29);
        ctx.arc(c.x - 15 * s, c.y + 5 * s, 9 * s, 0, 6.29);
        ctx.arc(c.x + 4 * s, c.y - 8 * s, 10 * s, 0, 6.29);
        ctx.fill();
    }
}

function drawGround() {
    ctx.fillStyle = mix("#c9a26b", "#241f38", nightAmt);
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

    ctx.fillStyle = mix("#6b4f2a", "#0d0b1c", nightAmt);
    ctx.fillRect(0, GROUND_Y, W, 3);

    const detail = mix("#a8804d", "#171331", nightAmt);
    const start = -(layer.ground % RIDGE_W);
    for (let k = 0; k < 2; k++) {
        const ox = start + k * RIDGE_W;
        if (ox > W) break;
        for (const m of groundMarks) {
            const x = ox + m.x;
            if (x < -40 || x > W + 40) continue;
            ctx.fillStyle = detail;
            if (m.dot) ctx.fillRect(x, GROUND_Y + m.y, 3, 3);
            else ctx.fillRect(x, GROUND_Y + m.y, m.w, 2);
        }
    }
}

function drawObstacles() {
    for (const ob of obstacles) {
        if (ob.kind === "cactus") drawCactus(ob);
        else drawBird(ob);
    }
}

function drawCactus(ob) {
    const body = mix("#2f9e5e", "#1c6b41", nightAmt * 0.5);
    const dark = mix("#217346", "#12482c", nightAmt * 0.5);
    const n = ob.count;
    const unit = ob.w / n;

    // Everything is drawn inside [ob.x, ob.x + ob.w] so what you see is what
    // kills you -- arms poking outside the hitbox would read as a cheat.
    for (let i = 0; i < n; i++) {
        const x = ob.x + i * unit;
        const h = ob.h * (n > 1 ? (i === 1 ? 1 : 0.78) : 1);
        const y = GROUND_Y - h;
        const sw = unit * 0.36;
        const sx = x + (unit - sw) / 2;

        fillRR(sx, y, sw, h, sw / 2, body);

        // left arm: elbow out, then up
        const ly = y + h * 0.42;
        fillRR(x + 2, ly + 8, sx - x - 2 + 2, 5, 2.5, body);
        fillRR(x + 2, ly - 2, 5, 15, 2.5, body);

        // right arm, a little higher for asymmetry
        const ry = y + h * 0.30;
        fillRR(sx + sw - 2, ry + 8, x + unit - 2 - (sx + sw) + 2, 5, 2.5, body);
        fillRR(x + unit - 7, ry - 2, 5, 15, 2.5, body);

        // a shading ridge so it is not a flat blob
        ctx.fillStyle = dark;
        ctx.fillRect(sx + sw * 0.62, y + 4, 2, h - 8);
    }
}

function drawBird(ob) {
    const body = mix("#4b3f72", "#2a2450", nightAmt * 0.5);
    const wing = mix("#6d5da8", "#3b3470", nightAmt * 0.5);
    const cx = ob.x + ob.w / 2, cy = ob.y + ob.h / 2;
    const up = Math.sin(ob.flap) > 0;

    // wings
    ctx.fillStyle = wing;
    ctx.beginPath();
    if (up) {
        ctx.moveTo(cx - 4, cy);
        ctx.lineTo(cx - 20, cy - 18);
        ctx.lineTo(cx + 10, cy - 4);
    } else {
        ctx.moveTo(cx - 4, cy);
        ctx.lineTo(cx - 18, cy + 15);
        ctx.lineTo(cx + 10, cy + 3);
    }
    ctx.closePath();
    ctx.fill();

    // body + head
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(cx - 3, cy, 15, 8, 0, 0, 6.29);
    ctx.fill();
    circle(cx + 9, cy - 4, 7, body);

    // beak -- stops at the hitbox edge rather than jutting past it
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.moveTo(cx + 13, cy - 6);
    ctx.lineTo(cx + 21, cy - 2);
    ctx.lineTo(cx + 13, cy + 1);
    ctx.closePath();
    ctx.fill();

    circle(cx + 10, cy - 6, 2.2, "#fff");
    circle(cx + 10.8, cy - 6, 1.1, "#111");
}

function drawCoins() {
    for (const c of coins) {
        const spin = Math.abs(Math.cos(c.phase));
        const rx = Math.max(1.6, c.r * spin);
        ctx.fillStyle = "rgba(255,211,92,0.20)";
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rx + 4, c.r + 4, 0, 0, 6.29);
        ctx.fill();

        ctx.fillStyle = "#ffd35c";
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rx, c.r, 0, 0, 6.29);
        ctx.fill();

        ctx.fillStyle = "#f59e0b";
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rx * 0.55, c.r * 0.55, 0, 0, 6.29);
        ctx.fill();
    }
}

const POWER_STYLE = {
    shield: { color: "#22d3ee", glyph: "S" },
    x2:     { color: "#e879f9", glyph: "2" },
    magnet: { color: "#f87171", glyph: "M" }
};

function drawPowerups() {
    for (const pu of powerups) {
        const bob = Math.sin(pu.phase) * 5;
        const st = POWER_STYLE[pu.kind];
        const y = pu.y + bob;

        ctx.globalAlpha = 0.30;
        circle(pu.x, y, pu.r + 8 + Math.sin(pu.phase * 2) * 2, st.color);
        ctx.globalAlpha = 1;

        fillRR(pu.x - pu.r, y - pu.r, pu.r * 2, pu.r * 2, 7, st.color);
        fillRR(pu.x - pu.r + 3, y - pu.r + 3, pu.r * 2 - 6, pu.r * 2 - 6, 5, "rgba(255,255,255,0.28)");

        ctx.fillStyle = "#0b1020";
        ctx.font = "bold 15px " + MONO;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(st.glyph, pu.x, y + 1);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
}

function drawParticles() {
    for (const p of particles) {
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
}

function drawFloaters() {
    ctx.textAlign = "center";
    ctx.font = "bold 13px " + MONO;
    for (const f of floaters) {
        ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillText(f.text, f.x + 1, f.y + 1);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
}

function drawSpeedLines() {
    if (diff < 0.35 || state !== "playing") return;
    const a = (diff - 0.35) / 0.65;
    ctx.strokeStyle = "rgba(255,255,255," + (a * 0.16).toFixed(3) + ")";
    ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
        const y = 40 + ((i * 53 + (time * 260) % 220)) % 190;
        const len = 40 + i * 12;
        const x = (W - ((time * speed * 1.4 + i * 190) % (W + 240)));
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y);
        ctx.stroke();
    }
}

/* --- the dino ------------------------------------------------------------ */

function drawPlayer() {
    const p = player;

    // A blink while invulnerable makes the shield-save state readable.
    if (invuln > 0 && Math.floor(invuln * 12) % 2 === 0) return;

    ctx.save();
    if (p.dead) {
        ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
        ctx.rotate(p.deadSpin);
        ctx.translate(-(p.x + p.w / 2), -(p.y + p.h / 2));
    }

    if (p.ducking) drawDinoDucking(p);
    else drawDinoStanding(p);

    ctx.restore();

    if (shieldCharged) {
        // An ellipse hugging the silhouette, so the bubble does not sink half
        // way into the ground when the dino ducks.
        const pulse = Math.sin(time * 6) * 1.5;
        ctx.strokeStyle = "rgba(34,211,238,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(p.x + p.w / 2, p.y + p.h / 2,
                    p.w / 2 + 9 + pulse, p.h / 2 + 9 + pulse, 0, 0, 6.29);
        ctx.stroke();
        ctx.fillStyle = "rgba(34,211,238,0.12)";
        ctx.fill();
    }
}

const BODY = "#4ade80";
const BODY_DARK = "#16a34a";

function drawDinoStanding(p) {
    const x = p.x, y = p.y;

    // tail
    ctx.fillStyle = BODY_DARK;
    ctx.beginPath();
    ctx.moveTo(x - 6, y + 16);
    ctx.lineTo(x + 12, y + 11);
    ctx.lineTo(x + 12, y + 28);
    ctx.closePath();
    ctx.fill();

    // legs -- two-frame run cycle, tucked while airborne
    ctx.fillStyle = BODY_DARK;
    if (p.onGround && !p.dead) {
        const s = Math.sin(p.runPhase);
        const c = Math.cos(p.runPhase);
        fillRR(x + 12 + s * 4, y + 32, 8, 15 - Math.abs(s) * 4, 3, BODY_DARK);
        fillRR(x + 24 + c * 4, y + 32, 8, 15 - Math.abs(c) * 4, 3, BODY_DARK);
    } else {
        fillRR(x + 13, y + 32, 8, 10, 3, BODY_DARK);
        fillRR(x + 25, y + 34, 8, 8, 3, BODY_DARK);
    }

    // body + neck + head
    fillRR(x + 8, y + 10, 26, 25, 8, BODY);
    fillRR(x + 22, y, 20, 19, 6, BODY);
    fillRR(x + 33, y + 8, 11, 9, 3, BODY);

    // belly highlight
    fillRR(x + 12, y + 22, 16, 11, 5, "rgba(255,255,255,0.18)");

    // arm
    fillRR(x + 27, y + 20, 9, 5, 2.5, BODY_DARK);

    // spine bumps
    ctx.fillStyle = BODY_DARK;
    ctx.fillRect(x + 12, y + 9, 4, 3);
    ctx.fillRect(x + 18, y + 6, 4, 3);

    drawFace(x + 30, y + 4, p);
}

function drawDinoDucking(p) {
    const x = p.x, y = p.y;

    ctx.fillStyle = BODY_DARK;
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 6);
    ctx.lineTo(x + 12, y + 2);
    ctx.lineTo(x + 12, y + 16);
    ctx.closePath();
    ctx.fill();

    const s = Math.sin(p.runPhase);
    fillRR(x + 16 + s * 3, y + 20, 8, 8, 3, BODY_DARK);
    fillRR(x + 30 - s * 3, y + 20, 8, 8, 3, BODY_DARK);

    fillRR(x + 8, y + 2, 40, 21, 9, BODY);
    fillRR(x + 36, y + 3, 20, 15, 6, BODY);
    fillRR(x + 48, y + 9, 10, 8, 3, BODY);
    fillRR(x + 14, y + 12, 20, 9, 4, "rgba(255,255,255,0.18)");

    drawFace(x + 43, y + 6, p);
}

function drawFace(ex, ey, p) {
    if (p.dead) {
        ctx.strokeStyle = "#0b1020";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex + 7, ey + 7);
        ctx.moveTo(ex + 7, ey);
        ctx.lineTo(ex, ey + 7);
        ctx.stroke();
        return;
    }
    const blinking = p.blink < 0;
    ctx.fillStyle = "#ffffff";
    if (blinking) {
        ctx.fillRect(ex, ey + 3, 7, 2);
    } else {
        ctx.fillRect(ex, ey, 7, 7);
        ctx.fillStyle = "#0b1020";
        ctx.fillRect(ex + 3, ey + 2, 3, 3);
    }
}

/* --- HUD and overlays ---------------------------------------------------- */

const MONO = 'ui-monospace, "Courier New", monospace';

function pad(n) {
    const s = String(Math.floor(n));
    return "00000".slice(0, Math.max(0, 5 - s.length)) + s;
}

// Text that has to stay readable over both a noon sky and a night sky.
function outlined(text, x, y, fill) {
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(6,10,24,0.55)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
}

function drawHUD() {
    ctx.textBaseline = "alphabetic";

    // score / best, top right. Outlined, because a bright noon sky and a
    // midnight sky both pass under this text.
    ctx.textAlign = "right";
    ctx.font = "bold 20px " + MONO;
    outlined(pad(score), W - 16, 30, "#ffffff");

    ctx.font = "bold 12px " + MONO;
    outlined("HI " + pad(best), W - 16, 48, "rgba(255,255,255,0.78)");

    // active power-ups, top left
    ctx.textAlign = "left";
    let px = 16;
    if (shieldCharged) px = pill(px, "SHIELD", 1, POWER_STYLE.shield.color);
    if (x2Time > 0)    px = pill(px, "x2", x2Time / 10, POWER_STYLE.x2.color);
    if (magnetTime > 0) px = pill(px, "MAGNET", magnetTime / 9, POWER_STYLE.magnet.color);

    if (coinStreak > 1 && state === "playing") {
        ctx.font = "bold 12px " + MONO;
        outlined("COMBO x" + coinStreak, 16, 52, "#ffd35c");
    }

    // mute indicator
    ctx.textAlign = "right";
    ctx.font = "bold 11px " + MONO;
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText(Sound.muted ? "MUTED (M)" : "SOUND ON (M)", W - 16, H - 12);
    ctx.textAlign = "left";
}

function pill(x, label, frac, color) {
    ctx.font = "bold 11px " + MONO;
    const w = ctx.measureText(label).width + 18;
    fillRR(x, 18, w, 18, 9, "rgba(0,0,0,0.35)");
    ctx.save();
    roundRect(x, 18, w, 18, 9);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.30;
    ctx.fillRect(x, 18, w * clamp(frac, 0, 1), 18);
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fillText(label, x + 9, 31);
    return x + w + 8;
}

function panel(x, y, w, h) {
    fillRR(x, y, w, h, 14, "rgba(8,12,28,0.82)");
    ctx.strokeStyle = "rgba(150,170,255,0.28)";
    ctx.lineWidth = 1;
    roundRect(x, y, w, h, 14);
    ctx.stroke();
}

function centered(text, y, size, color, weight) {
    ctx.textAlign = "center";
    ctx.font = (weight || "bold") + " " + size + "px " + MONO;
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, y);
    ctx.textAlign = "left";
}

function drawMenu() {
    ctx.fillStyle = "rgba(6,10,24,0.55)";
    ctx.fillRect(0, 0, W, H);
    panel(W / 2 - 210, 58, 420, 180);

    centered("DINO RUSH", 108, 34, "#ffffff");
    centered("jump the cacti, duck the birds, grab the coins", 134, 12, "#8b93b8");

    const blink = 0.6 + 0.4 * Math.sin(time * 4);
    ctx.globalAlpha = blink;
    centered("PRESS SPACE TO RUN", 172, 16, "#ffd35c");
    ctx.globalAlpha = 1;

    centered("hold jump to go higher  ·  down to fast-fall", 198, 11, "#8b93b8");
    if (best > 0) centered("BEST " + pad(best), 222, 12, "#67e8f9");
}

function drawPaused() {
    ctx.fillStyle = "rgba(6,10,24,0.60)";
    ctx.fillRect(0, 0, W, H);
    panel(W / 2 - 150, 100, 300, 96);
    centered("PAUSED", 143, 26, "#ffffff");
    centered("P or SPACE to resume  ·  R to restart", 170, 11, "#8b93b8");
}

function drawGameOver() {
    const a = clamp(overTimer / 0.35, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = "rgba(6,10,24,0.58)";
    ctx.fillRect(0, 0, W, H);

    panel(W / 2 - 190, 62, 380, 172);
    centered("GAME OVER", 108, 30, "#f87171");

    if (newBest) {
        const pulse = 0.7 + 0.3 * Math.sin(time * 6);
        ctx.globalAlpha = a * pulse;
        centered("NEW BEST!", 133, 15, "#ffd35c");
        ctx.globalAlpha = a;
    } else {
        centered("BEST  " + pad(best), 133, 13, "#8b93b8");
    }

    centered(pad(score), 176, 34, "#ffffff");
    centered("SCORE", 194, 10, "#8b93b8");

    if (overTimer > 0.55) {
        const blink = 0.55 + 0.45 * Math.sin(time * 5);
        ctx.globalAlpha = a * blink;
        centered("SPACE or R to run again", 220, 12, "#67e8f9");
    }
    ctx.globalAlpha = 1;
}

/* --- 7. main loop -------------------------------------------------------- */

// Fixed timestep: physics stays identical on a 60Hz laptop and a 144Hz monitor,
// and a slow frame cannot let an obstacle tunnel through the player.
const STEP = 1 / 120;
const MAX_FRAME = 0.10;           // a lag spike must not teleport an obstacle into you
let acc = 0;
let last = 0;

function frame(ts) {
    if (!last) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    acc += dt;
    let guard = 0;
    while (acc >= STEP && guard < 40) {
        step(STEP);
        acc -= STEP;
        guard++;
    }
    if (guard >= 40) acc = 0;

    render();
    requestAnimationFrame(frame);
}

// Load with #debug to get a handle on the internals for tuning.
if (location.hash === "#debug") {
    window.DinoRush = {
        // getters, because resetWorld() swaps the arrays out wholesale
        get state() { return state; },
        get obstacles() { return obstacles; },
        get coins() { return coins; },
        get powerups() { return powerups; },
        get score() { return score; },
        get speed() { return speed; },
        player,
        start: startRun
    };
}

resize();
resetWorld();
requestAnimationFrame(frame);

})();
