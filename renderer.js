// SpaceSails canvas renderer (M2). Pure screen-space 2D canvas wrapper: this module knows nothing
// about world meters or the camera — it only decodes the opcode command buffer that
// SpaceSails.Client.Rendering.CanvasRenderer batches in C# and paints it with Canvas2D.
//
// Exports consumed from C# via [JSImport] (SpaceSails.Client/Rendering/RendererInterop.cs):
//   initCanvas(canvasId), startLoop(canvasId), stopLoop(canvasId),
//   drawFrame(canvasId, buffer, length), drawTexts(canvasId, json)
//
// Calls back into C# via the assembly's [JSExport]ed RendererInterop.Tick / .OnResize, obtained
// through the runtime's getAssemblyExports (see ensureExports below) — this module owns the
// requestAnimationFrame loop, not C#.

const OP_POLYLINE = 1;
const OP_CIRCLE = 2;
const OP_POLYGON = 3;
const OP_IMAGE = 4;
const OP_IMAGE_SLICE = 5;

/** @type {Map<string, { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, rafId: number|null, running: boolean }>} */
const canvases = new Map();

// Raster image cache, keyed by the integer id C# assigns in CanvasRenderer.RegisterImage. The
// float command buffer can only carry an id + dest rect, so the decoded bitmap must live here.
/** @type {Map<number, HTMLImageElement>} */
const images = new Map();

// Preload an image by id (C# → JS via RendererInterop.LoadImage). Decodes asynchronously; an
// OP_IMAGE draw before it finishes simply skips (img.complete is false) and starts painting once
// the browser has it. Idempotent per id.
export function loadImage(id, url) {
    if (images.has(id)) {
        return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    images.set(id, img);
}

let exportsPromise = null;

async function ensureExports() {
    exportsPromise ??= (async () => {
        const { getAssemblyExports } = await globalThis.getDotnetRuntime(0);
        const exports = await getAssemblyExports('SpaceSails.Client.dll');
        return exports.SpaceSails.Client.Rendering.RendererInterop;
    })();
    return exportsPromise;
}

function reportSize(entry, canvasId) {
    const rect = entry.canvas.getBoundingClientRect();
    ensureExports().then((rendererInterop) => rendererInterop.OnResize(rect.width, rect.height));
}

export function initCanvas(canvasId, observeResize) {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById(canvasId));
    if (!canvas) {
        throw new Error(`renderer.js: no canvas element with id "${canvasId}"`);
    }

    const ctx = canvas.getContext('2d');
    const entry = { canvas, ctx, rafId: null, running: false };
    canvases.set(canvasId, entry);

    // Secondary canvases (the scope inset) must NOT report their size: OnResize feeds the
    // main map viewport, and a 280px inset would shrink the whole world.
    if (observeResize) {
        const observer = new ResizeObserver(() => reportSize(entry, canvasId));
        observer.observe(canvas);
        reportSize(entry, canvasId);
    }
}

export function drawFrame(canvasId, buffer, length) {
    const entry = canvases.get(canvasId);
    if (!entry) {
        return;
    }

    // `buffer` is a short-lived MemoryView over the C# command buffer, reinterpreted as bytes on the
    // C# side (source-generated JS interop only supports MemoryView<byte>, not MemoryView<float> —
    // see RendererInterop.DrawFrame). Copy it out once (cheap — 500 polylines is a few thousand
    // floats) since the view is only valid for the duration of this call, then reinterpret those
    // bytes as the Float32Array `length` says they are.
    const bytes = buffer.slice();
    const view = new Float32Array(bytes.buffer, bytes.byteOffset, length);
    const { canvas, ctx } = entry;

    const widthPx = view[0] | 0;
    const heightPx = view[1] | 0;
    if (canvas.width !== widthPx || canvas.height !== heightPx) {
        canvas.width = widthPx;
        canvas.height = heightPx;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = rgba(view[2], view[3], view[4], view[5]);
    ctx.fillRect(0, 0, widthPx, heightPx);

    let i = 6;
    while (i < length) {
        const op = view[i++];

        if (op === OP_POLYLINE) {
            const r = view[i++], g = view[i++], b = view[i++], a = view[i++];
            const lineWidth = view[i++];
            const n = view[i++] | 0;

            // One stroke() per polyline is deliberate: trajectory ribbons are drawn translucent, and
            // per-polyline stroking lets overlapping paths accumulate opacity (denser = more traffic).
            // Merging same-styled polylines into a single path would flatten that and change the look.
            ctx.beginPath();
            for (let p = 0; p < n; p++) {
                const x = view[i++], y = view[i++];
                if (p === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.strokeStyle = rgba(r, g, b, a);
            ctx.lineWidth = lineWidth;
            ctx.stroke();
        } else if (op === OP_POLYGON) {
            // Closed, optionally-filled polygon (SundaySecondPlan PR-B): trade-lane areas and
            // scan wedges. Same fill/stroke header shape as OP_CIRCLE, then a point list.
            const hasFill = view[i++];
            const fr = view[i++], fg = view[i++], fb = view[i++], fa = view[i++];
            const sr = view[i++], sg = view[i++], sb = view[i++], sa = view[i++];
            const strokeWidth = view[i++];
            const n = view[i++] | 0;

            ctx.beginPath();
            for (let p = 0; p < n; p++) {
                const x = view[i++], y = view[i++];
                if (p === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.closePath();
            if (hasFill) {
                ctx.fillStyle = rgba(fr, fg, fb, fa);
                ctx.fill();
            }
            if (strokeWidth > 0) {
                ctx.strokeStyle = rgba(sr, sg, sb, sa);
                ctx.lineWidth = strokeWidth;
                ctx.stroke();
            }
        } else if (op === OP_CIRCLE) {
            const hasFill = view[i++];
            const fr = view[i++], fg = view[i++], fb = view[i++], fa = view[i++];
            const sr = view[i++], sg = view[i++], sb = view[i++], sa = view[i++];
            const strokeWidth = view[i++];
            const x = view[i++], y = view[i++], radius = view[i++];

            ctx.beginPath();
            ctx.arc(x, y, Math.max(radius, 0), 0, Math.PI * 2);
            if (hasFill) {
                ctx.fillStyle = rgba(fr, fg, fb, fa);
                ctx.fill();
            }
            if (strokeWidth > 0) {
                ctx.strokeStyle = rgba(sr, sg, sb, sa);
                ctx.lineWidth = strokeWidth;
                ctx.stroke();
            }
        } else if (op === OP_IMAGE) {
            // Raster backdrop / texture: id + dest rect + alpha. drawImage confines the bitmap to
            // the rect (it cannot bleed past it), so room backdrops stay inside their room.
            const id = view[i++] | 0;
            const x = view[i++], y = view[i++], w = view[i++], h = view[i++], alpha = view[i++];
            const img = images.get(id);
            if (img && img.complete && img.naturalWidth > 0) {
                const prevAlpha = ctx.globalAlpha;
                ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
                ctx.drawImage(img, x, y, w, h);
                ctx.globalAlpha = prevAlpha;
            }
        } else if (op === OP_IMAGE_SLICE) {
            // Textured raycaster column: id + NORMALIZED source rect (0..1) + dest rect + alpha. The
            // source fractions are multiplied by the decoded bitmap's natural size here, so C# never
            // needs the texture's pixel dimensions. sw is clamped to >= 1px so a thin vertical strip
            // still samples a real texel column.
            const id = view[i++] | 0;
            const sxf = view[i++], syf = view[i++], swf = view[i++], shf = view[i++];
            const dx = view[i++], dy = view[i++], dw = view[i++], dh = view[i++], alpha = view[i++];
            const img = images.get(id);
            if (img && img.complete && img.naturalWidth > 0 && dh > 0) {
                const nw = img.naturalWidth, nh = img.naturalHeight;
                const sx = sxf * nw, sy = syf * nh;
                const sw = Math.max(1, swf * nw), sh = Math.max(1, shf * nh);
                const prevAlpha = ctx.globalAlpha;
                ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
                ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
                ctx.globalAlpha = prevAlpha;
            }
        } else {
            // Unknown opcode: stop rather than looping forever on a corrupted buffer.
            break;
        }
    }
}

export function drawTexts(canvasId, json) {
    const entry = canvases.get(canvasId);
    if (!entry) {
        return;
    }

    const texts = JSON.parse(json);
    const { ctx } = entry;
    for (const t of texts) {
        ctx.fillStyle = rgba(t.r, t.g, t.b, t.a);
        ctx.font = t.font;
        ctx.textAlign = t.align;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(t.text, t.x, t.y);
    }
}

export async function startLoop(canvasId) {
    const entry = canvases.get(canvasId);
    if (!entry) {
        return;
    }

    entry.running = true;
    const rendererInterop = await ensureExports();

    const frame = (timestampMs) => {
        if (!entry.running) {
            return;
        }
        rendererInterop.Tick(timestampMs);
        entry.rafId = requestAnimationFrame(frame);
    };
    entry.rafId = requestAnimationFrame(frame);

    // Browsers suspend requestAnimationFrame entirely for hidden documents (tab switched,
    // window occluded, machine locked), which would silently freeze the whole simulation —
    // warp time stops passing the moment the player looks away. While hidden, tick from a
    // 1 Hz interval instead (background timers are throttled to about that anyway); rendering
    // to an invisible canvas is wasted but 1 Hz of it is free, and C#'s accumulator clamp
    // already bounds the per-tick work. Timestamps stay on the performance.now() clock either
    // way, so the C# dt math never sees a seam.
    entry.hiddenTimerId = setInterval(() => {
        if (entry.running && document.visibilityState === 'hidden') {
            rendererInterop.Tick(performance.now());
        }
    }, 1000);
}

export function stopLoop(canvasId) {
    const entry = canvases.get(canvasId);
    if (!entry) {
        return;
    }

    entry.running = false;
    if (entry.rafId !== null) {
        cancelAnimationFrame(entry.rafId);
        entry.rafId = null;
    }
    if (entry.hiddenTimerId) {
        clearInterval(entry.hiddenTimerId);
        entry.hiddenTimerId = null;
    }
}

function rgba(r, g, b, a) {
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

// ---- Audio cues (M10 polish) ----
// Tiny WebAudio blips, no assets. The context can only start after a user gesture; the cues
// are triggered by keyboard/click handlers, which qualify, and we lazily resume each call.

let audioCtx = null;

// ─── #338 addendum (owner, 2026-07-18 — THE GAME'S FIRST SOUND): the audio switch. "An audio toggle
// (default ON, remembered) so streamers and the noise-averse can mute; all future sounds hang off the
// same switch." Kept as a browser-local pref (localStorage, NOT the game vault/save) so a mute survives a
// reload without touching persistence. Every cue below early-returns when it is off. ───
const AUDIO_PREF_KEY = 'spaceSails.audioEnabled';
let audioEnabled = true;
try { audioEnabled = window.localStorage.getItem(AUDIO_PREF_KEY) !== '0'; } catch { /* default on */ }

/** The current audio-on state (so C# can sync its toggle label). */
export function getAudioEnabled() { return audioEnabled; }

/** Flip the master audio switch and remember it browser-locally. All cues + the chirp hang off this. */
export function setAudioEnabled(on) {
    audioEnabled = !!on;
    try { window.localStorage.setItem(AUDIO_PREF_KEY, audioEnabled ? '1' : '0'); } catch { /* pref is a nicety */ }
}

/** #338 addendum item 4 — WebAudio needs a user gesture before it will play, so unlock the context on the
 *  first click/keypress of the session. Then a cue fired later from the rAF loop (the first-contact chirp,
 *  which is not itself a gesture) can sound instead of being silently blocked. */
export function armAudio() {
    try {
        audioCtx ??= new AudioContext();
        if (audioCtx.state === 'suspended') { audioCtx.resume(); }
    } catch { /* audio is decoration */ }
}

const CUES = {
    rum: { type: 'triangle', freq: 392, to: 587, duration: 0.35, gain: 0.09 }, // a jaunty rising swagger for the rum locker
    pulse: { freq: 220, to: 440, duration: 0.09, gain: 0.06, type: 'square' },   // engine thump
    vent:  { freq: 900, to: 300, duration: 0.25, gain: 0.05, type: 'sawtooth' }, // discharge hiss-fall
    board: { freq: 523, to: 784, duration: 0.35, gain: 0.08, type: 'sine' },     // prize jingle rise
    arc:   { freq: 80,  to: 60,  duration: 0.5,  gain: 0.10, type: 'sawtooth' }, // thunder growl
    fire:  { freq: 130, to: 45,  duration: 0.4,  gain: 0.12, type: 'square' },   // the driver's boom
    hit:   { freq: 660, to: 990, duration: 0.3,  gain: 0.10, type: 'triangle' }, // splash — bright ping up
    miss:  { freq: 440, to: 160, duration: 0.5,  gain: 0.07, type: 'sine' },     // round gone — sad fall
    reveal:{ freq: 587, to: 1175, duration: 0.45, gain: 0.08, type: 'sine' },    // a scan resolves it — bright discovery rise
    voidjump:{ freq: 196, to: 784, duration: 0.7, gain: 0.10, type: 'sawtooth' }, // #255 long-haul engage — a rising bottle-pop whoosh into the void
    buzzer:{ freq: 175, to: 150, duration: 0.32, gain: 0.045, type: 'square' },   // #424 THE UNEXPLAINED SIGNAL — a faint, low buzzer off-deck; quiet + muffled, no one explains it
    // #467 · BEING HURT MUST BE UNMISSABLE (owner, 2026-07-27: "I had no sound to alert that I was taking
    // damage… I should know when I'm hurt"). The generic `alarm` was shared with a dozen other things, so a
    // blow read as background in a fight. Two distinct voices instead:
    block: { freq: 1400, to: 520, duration: 0.14, gain: 0.11, type: 'square' },   // steel turns it — a hard bright CLANG
    wound: { freq: 150,  to: 42,  duration: 0.55, gain: 0.16, type: 'sawtooth' }, // it got in — low, wet and wrong
    last:  { freq: 90,   to: 70,  duration: 0.9,  gain: 0.18, type: 'sawtooth' }, // one more will do it — a floor-level dread tone
};

export function playCue(kind) {
    if (!audioEnabled) {
        return;
    }
    const cue = CUES[kind];
    if (!cue) {
        return;
    }

    try {
        audioCtx ??= new AudioContext();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        const t = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = cue.type;
        osc.frequency.setValueAtTime(cue.freq, t);
        osc.frequency.exponentialRampToValueAtTime(cue.to, t + cue.duration);
        gain.gain.setValueAtTime(cue.gain, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + cue.duration);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + cue.duration);
    } catch {
        // Audio is decoration: autoplay policies or missing WebAudio must never break the game.
    }
}

/** #338 addendum — THE GAME'S FIRST SOUND: the motion tracker's first-contact chirp. Two short, quiet
 *  rising tones, radar-flavoured, no assets — the "device chirps in the holster" moment fired on the 0→N
 *  tracker edge (Core-gated in MotionTracker.StepChirp). Respects the master audio switch and the
 *  gesture-armed context, exactly like every other cue. */
export function playChirp() {
    if (!audioEnabled) {
        return;
    }
    try {
        audioCtx ??= new AudioContext();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const t0 = audioCtx.currentTime;
        // Two quick blips, the second a step higher — a little "ping-ping" that reads as "contact".
        for (let i = 0; i < 2; i++) {
            const t = t0 + (i * 0.12);
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const f = i === 0 ? 660 : 880;
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t);
            osc.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.08);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(t);
            osc.stop(t + 0.11);
        }
    } catch {
        // Audio is decoration: a blocked chirp must never break the sweep.
    }
}

// ─── The personal vault (#225): localStorage autosave + export/import a .json file. ───
// Kept tiny and defensive — a private-browsing localStorage throw, a storage quota, or a cancelled
// file picker must NEVER break the game; the worst case is "the save didn't take", surfaced in C#.

/** Read the vault JSON from localStorage, or null if none / storage unavailable. */
export function vaultRead(key) {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** Write the vault JSON to localStorage. Returns true on success. */
export function vaultWrite(key, json) {
    try {
        window.localStorage.setItem(key, json);
        return true;
    } catch {
        return false; // quota or private-mode denial — C# just notes the autosave didn't land.
    }
}

/** #992 · Bring the first element matching `selector` inside its own scrollers.
 *
 *  The flight plan's step list scrolls now (the panel is bound to the window), so opening a step near the
 *  bottom of a long plan could put that step's editor below the LIST's fold — the owner's complaint one
 *  scroller further in. `block: 'nearest'` is the smallest honest motion: a step already fully in view is
 *  not moved at all, and one hanging off an edge is brought just inside it. Instant, not smooth — the
 *  editor's buttons have to be pressable the moment the row opens, and a running animation is a moving
 *  target for a captain and for a guard alike. Best-effort: a selector that matches nothing is a no-op,
 *  never a throw into the render loop. */
export function scrollIntoView(selector) {
    try {
        const el = document.querySelector(selector);
        if (el) {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        }
    } catch {
        // Decoration: a browser that will not scroll for us still leaves the list scrollable by hand.
    }
}

/** Put text on the clipboard — the [copy] behind the Captain's crash note. Best-effort: a browser that
 *  denies clipboard access (or an insecure origin) falls back to a hidden textarea + execCommand, and if
 *  that fails too we simply report false rather than throwing into the game. */
export function copyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the old way
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/** Forget the vault (used by a fresh start that abandons the save). */
export function vaultClear(key) {
    try {
        window.localStorage.removeItem(key);
    } catch {
        // nothing to do — a storage that can't clear also can't have saved.
    }
}

/** Download the vault as a .json file the owner can keep against a server wipe. */
export function vaultDownload(filename, json) {
    try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
        // A blocked download is not fatal; the localStorage autosave still holds the vault.
    }
}

/** Open a file picker and resolve the chosen .json file's text (or '' if cancelled/failed). */
export function vaultImport() {
    return new Promise((resolve) => {
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.style.display = 'none';
            document.body.appendChild(input);

            const done = (text) => {
                try { document.body.removeChild(input); } catch { /* already gone */ }
                resolve(text);
            };

            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (!file) { done(''); return; }
                const reader = new FileReader();
                reader.onload = () => done(typeof reader.result === 'string' ? reader.result : '');
                reader.onerror = () => done('');
                reader.readAsText(file);
            });
            // A cancel fires no 'change'; resolve empty after focus returns so the caller never hangs.
            window.addEventListener('focus', () => setTimeout(() => {
                if (!input.files || input.files.length === 0) { done(''); }
            }, 300), { once: true });

            input.click();
        } catch {
            resolve('');
        }
    });
}
