import { FogWeaverLayer, drawShapeGeometry, registerFogWeaverCallbacks, hexToRgbArray } from "./layer.mjs";
import { registerInstallTrackerSetting, maybeSendInstallRecord } from "./installTracker.mjs";

const MODULE_ID = "fog-weaver";

// Holds the lighting layer's original reset onChange so it can be restored when FW is disabled.
let _originalLightingResetOnChange = null;

/**
 * Emit a console.log message only when debug logging is enabled in module settings.
 * Safe to call before settings are registered (silently suppressed).
 *
 * @param {...any} args - Arguments forwarded to console.log.
 */
function _log(...args) {
    try {
        if (!game.settings.get(MODULE_ID, "debugLogging")) return;
    } catch {
        return;
    }
    console.log(...args);
}

/**
 * Sentinel level key used on v13, which has no concept of levels.
 * Every read/write routes through this single key so v13 scenes
 * are handled identically to a single-level v14 scene.
 */
const LEGACY_LEVEL_KEY = "_default";

const MAX_HYBRID_UNDO_DEPTH = 5;
const _hybridUndoStacks = new Map();

/**
 * Get or initialize the hybrid mode undo stack for the specified level.
 *
 * @param {string} [levelKey] - Level id or default.
 * @returns {PIXI.RenderTexture[]}
 */
export function _getHybridUndoStack(levelKey = _getLevelKey()) {
    if (!_hybridUndoStacks.has(levelKey)) {
        _hybridUndoStacks.set(levelKey, []);
    }
    return _hybridUndoStacks.get(levelKey);
}

/**
 * Capture a snapshot of the current live fog texture and push it onto the undo stack.
 */
export function _pushHybridUndoSnapshot() {
    const sprite = canvas.fog?.sprite;
    if (!sprite?.texture?.valid) return;
    const tex = _ensureRenderTexture();
    if (!tex) return;

    const snapshot = typeof canvas.fog._createExplorationRenderTexture === "function"
        ? canvas.fog._createExplorationRenderTexture()
        : foundry.canvas.Canvas.getRenderTexture({
            clearColor: [0, 0, 0, 1],
            textureConfiguration: canvas.fog.textureConfiguration
        });

    const dims = canvas.dimensions;
    const transform = new PIXI.Matrix();
    transform.tx = -dims.sceneX;
    transform.ty = -dims.sceneY;
    canvas.app.renderer.render(sprite, { renderTexture: snapshot, clear: false, transform });

    const stack = _getHybridUndoStack();
    stack.push(snapshot);
    while (stack.length > MAX_HYBRID_UNDO_DEPTH) {
        const oldest = stack.shift();
        oldest?.destroy(true);
    }
}

/**
 * Clear and destroy textures in hybrid undo stacks.
 *
 * @param {string|null} [levelKey] - Specific level key to clear, or null for all levels.
 */
export function _clearHybridUndoStacks(levelKey = null) {
    if (levelKey) {
        const stack = _hybridUndoStacks.get(levelKey);
        if (stack) {
            for (const tex of stack) tex.destroy(true);
            _hybridUndoStacks.delete(levelKey);
        }
    } else {
        for (const stack of _hybridUndoStacks.values()) {
            for (const tex of stack) tex.destroy(true);
        }
        _hybridUndoStacks.clear();
    }
}

/**
 * Pure function to apply VisibilityFilter fragment shader modifications based on fog mode and enabled state.
 *
 * @param {string} src - Source fragment shader GLSL.
 * @param {object} [options] - Shader options.
 * @param {string} [mode="hybrid"] - Active fog mode ("hybrid" or "manual").
 * @param {boolean} [enabled=true] - Whether Fog Weaver is enabled.
 * @returns {string} The transformed shader string.
 */
export function patchVisibilityFilterShader(src, options = {}, mode = "hybrid", enabled = true) {
    if (!enabled) return src;
    if (mode === "hybrid") return src;
    if (options?.persistentVision) return src;
    return src
        .replace("mix(unexplored, explored, max(r,v))",
                 "mix(unexplored, explored, r)")
        .replace("mix(fow, vec4(0.0), v)",
                 "mix(fow, vec4(0.0), r)")
        .replace("uniform vec3 unexploredColor;",
                 "uniform vec3 unexploredColor;\nuniform float uFogAlpha;")
        .replace("vec4(unexploredColor, 1.0)", "vec4(unexploredColor, uFogAlpha)")
        .replace("vec4(unexploredColor, 1.0)", "vec4(unexploredColor, uFogAlpha)")
        .replace("vec4(fogColor.rgb * backgroundColor, 1.0)",
                 "vec4(fogColor.rgb * backgroundColor, uFogAlpha)")
        .replace("vec3(1.0)), 0.5)", "vec3(1.0)), uFogAlpha * 0.5)");
}

/**
 * Resolve the current level id, or the v13 sentinel.
 * v14: canvas.scene._view is the active level id (string).
 * v13: no levels concept — every read/write routes through "_default".
 *
 * @returns {string} The current level id, or "_default" on v13.
 */
function _getLevelKey() {
    return canvas.scene?._view ?? LEGACY_LEVEL_KEY;
}

/**
 * Read the shapes array for the current level from the scene flags.
 * Returns an empty array when the scene has no shapes flag yet, when
 * the flag is in the legacy single-array shape (pre-migration), or
 * when this level has never been painted on.
 *
 * @returns {object[]} The shapes for the current level.
 */
function _getShapesForCurrentLevel() {
    const all = canvas.scene.getFlag(MODULE_ID, "shapes");
    if (!all) return [];
    if (Array.isArray(all)) return all; // legacy / pre-migration scenes
    return all[_getLevelKey()] ?? [];
}

/**
 * Write the shapes array for the current level via setFlag. Always
 * writes the keyed object format — never the legacy array format.
 *
 * @param {object[]} shapes - The shapes array to store for this level.
 * @returns {Promise<void>}
 */
async function _setShapesForCurrentLevel(shapes) {
    const all = canvas.scene.getFlag(MODULE_ID, "shapes");
    const map = (!all || Array.isArray(all)) ? {} : { ...all };
    map[_getLevelKey()] = shapes;
    await canvas.scene.setFlag(MODULE_ID, "shapes", map);
}

/**
 * Read the weaverFog base64 string for the current level from the
 * scene flags. Returns null when absent or when the flag is in the
 * legacy single-string shape (pre-migration).
 *
 * @returns {string|null} The weaverFog base64 string, or null if absent.
 */
function _getWeaverFogForCurrentLevel() {
    const all = canvas.scene.getFlag(MODULE_ID, "weaverFog");
    if (!all) return null;
    if (typeof all === "string") return all; // legacy / pre-migration
    return all[_getLevelKey()] ?? null;
}

/**
 * Write the weaverFog base64 string for the current level via setFlag.
 * Always writes the keyed object format — never the legacy string format.
 * Pass null to clear just this level's slot.
 *
 * @param {string|null} value - The base64 weaverFog string, or null to clear.
 * @returns {Promise<void>}
 */
async function _setWeaverFogForCurrentLevel(value) {
    const all = canvas.scene.getFlag(MODULE_ID, "weaverFog");
    const map = (!all || typeof all === "string") ? {} : { ...all };
    if (value === null) delete map[_getLevelKey()];
    else map[_getLevelKey()] = value;
    await canvas.scene.setFlag(MODULE_ID, "weaverFog", map);
}

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "debugLogging", {
        name: "FOGWEAVER.Settings.DebugLogging.Name",
        hint: "FOGWEAVER.Settings.DebugLogging.Hint",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, "enabled", {
        name: "FOGWEAVER.Settings.Enabled.Name",
        hint: "FOGWEAVER.Settings.Enabled.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: false,
        onChange: _onEnabledChange
    });

    game.settings.register(MODULE_ID, "fogMode", {
        name: "FOGWEAVER.Settings.FogMode.Name",
        hint: "FOGWEAVER.Settings.FogMode.Hint",
        scope: "world",
        config: true,
        type: String,
        choices: {
            hybrid: "FOGWEAVER.Settings.FogMode.Hybrid",
            manual: "FOGWEAVER.Settings.FogMode.Manual"
        },
        default: "hybrid",
        requiresReload: false,
        onChange: () => _onEnabledChange(game.settings.get(MODULE_ID, "enabled"))
    });

    game.settings.register(MODULE_ID, "lineWidth", {
        name: "FOGWEAVER.Settings.LineWidth.Name",
        hint: "FOGWEAVER.Settings.LineWidth.Hint",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 20, max: 500, step: 10 },
        default: 100,
        onChange: value => {
            // Keep inline slider in sync when setting changes externally (e.g. settings menu).
            const slider = document.querySelector("#fw-line-width-slider");
            if (!slider) return;
            slider.value = value;
            const label = document.querySelector("#fw-line-width-value");
            if (label) label.textContent = `${value}px`;
        }
    });

    game.settings.register(MODULE_ID, "gmFogAlpha", {
        name: "FOGWEAVER.Settings.GmFogAlpha.Name",
        hint: "FOGWEAVER.Settings.GmFogAlpha.Hint",
        scope: "client",
        config: true,
        type: Number,
        range: { min: 0.2, max: 1, step: 0.05 },
        default: 0.7,
        onChange: value => {
            if (!canvas.visibility?.filter) return;
            if (ui.controls?.control?.name !== "fogweaver") return;
            canvas.visibility.filter.uniforms.uFogAlpha = value;
            // Keep inline slider in sync when setting changes externally (e.g. settings menu).
            const slider = document.querySelector("#fw-opacity-slider");
            if (slider) slider.value = value;
        }
    });

    game.settings.register(MODULE_ID, "gmFogTint", {
        name: "FOGWEAVER.Settings.GmFogTint.Name",
        hint: "FOGWEAVER.Settings.GmFogTint.Hint",
        scope: "client",
        config: true,
        type: String,
        default: "#000000",
        onChange: value => {
            if (!canvas.visibility?.filter) return;
            if (ui.controls?.control?.name !== "fogweaver") return;
            const rgb = hexToRgbArray(value);
            canvas.visibility.filter.uniforms.unexploredColor = rgb;
            // Keep GM overlay color in sync.
            const overlay = canvas.fogweaver?._gmOverlay;
            if (overlay?.filters?.[0]) {
                const fc = overlay.filters[0].uniforms.fogColor;
                overlay.filters[0].uniforms.fogColor = [rgb[0], rgb[1], rgb[2], fc?.[3] ?? 0.75];
            }
            // Keep inline color picker in sync when setting changes externally.
            const picker = document.querySelector("#fw-tint-picker");
            if (picker) picker.value = value;
        }
    });

    game.settings.register(MODULE_ID, "isolateStates", {
        name: "FOGWEAVER.Settings.IsolateStates.Name",
        hint: "FOGWEAVER.Settings.IsolateStates.Hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, "snapshotSizeWarning", {
        name: "FOGWEAVER.Settings.SnapshotSizeWarning.Name",
        hint: "FOGWEAVER.Settings.SnapshotSizeWarning.Hint",
        scope: "world",
        config: true,
        type: Number,
        range: { min: 100, max: 2000, step: 100 },
        default: 500
    });

    // Ensure the VisibilityFilter has the uFogAlpha uniform at its default before any filter
    // instance is created. The fragment shader patch (in _wrapFogCommit) declares the uniform;
    // setting the default here prevents WebGL from silently treating it as 0 on first draw.
    CONFIG.Canvas.visibilityFilter.defaultUniforms.uFogAlpha = 1.0;

    CONFIG.Canvas.layers.fogweaver = {
        layerClass: FogWeaverLayer,
        group: "interface"
    };

    _wrapFogCommit();

    registerFogWeaverCallbacks(commitShape, _undoLastShape);

    // Hidden world setting that persists the install-tracker state (sent flag,
    // version, attempt count, last error). Managed entirely by installTracker.mjs.
    registerInstallTrackerSetting();
});

// After any vision refresh, reconcile the GM overlay with the current fog texture.
// Foundry can swap the fog texture out from under us (e.g., on canvas.fog.reset(), scene
// reload, or FogManager.load() finishing a saved-image load); when that happens, our
// overlay sprite still points at the destroyed texture and PIXI crashes during hit-test.
Hooks.on("sightRefresh", () => {
    if (!game.user.isGM) return;
    const layer = canvas.fogweaver;
    if (!layer || !game.settings.get(MODULE_ID, "enabled")) return;

    const liveTex = canvas.fog.sprite?.texture;
    const overlayTex = layer._gmOverlay?.texture;
    if (overlayTex && overlayTex !== liveTex) {
        // Overlay's texture has been replaced (or destroyed) — drop the stale sprite
        // so it can be rebuilt cleanly with the new texture.
        layer._gmOverlay.destroy({ children: true, texture: false, textureSource: false });
        layer._gmOverlay = null;
    }
    if (!layer._gmOverlay && liveTex?.valid) {
        layer._buildGMOverlay();
    }
});

// One-time migration: convert legacy single-bucket fog scene flags to the per-level keyed
// layout introduced in v14. Runs on the GM only, once per world (at game-ready time), so
// all scenes are migrated up-front before any per-level writes can inadvertently discard
// legacy data. Uses a progress-bar notification for worlds with many scenes.
// Gate flag: `scene.flags.fogweaver.levelsMigratedToV14` per scene.
Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    if (game.release.generation < 14) return;

    const toMigrate = game.scenes.filter(s =>
        !s.getFlag(MODULE_ID, "levelsMigratedToV14") &&
        (Array.isArray(s.getFlag(MODULE_ID, "shapes")) || typeof s.getFlag(MODULE_ID, "weaverFog") === "string")
    );

    if (!toMigrate.length) return;

    const progress = ui.notifications.info(
        `Fog Weaver: Migrating fog data for ${toMigrate.length} scene(s)...`,
        { progress: true, console: false }
    );

    for (let i = 0; i < toMigrate.length; i++) {
        const scene = toMigrate[i];
        progress.update({ pct: i / toMigrate.length, message: `Fog Weaver: Migrating "${scene.name}" (${i + 1}/${toMigrate.length})` });

        const legacyShapes = scene.getFlag(MODULE_ID, "shapes");
        const legacyWeaverFog = scene.getFlag(MODULE_ID, "weaverFog");
        const targetKey = scene.levels?.contents?.[0]?.id ?? scene.initialLevel?.id ?? LEGACY_LEVEL_KEY;
        const update = { flags: { [MODULE_ID]: { levelsMigratedToV14: true } } };
        if (Array.isArray(legacyShapes)) update.flags[MODULE_ID].shapes = { [targetKey]: legacyShapes };
        if (typeof legacyWeaverFog === "string") update.flags[MODULE_ID].weaverFog = { [targetKey]: legacyWeaverFog };
        await scene.update(update);
        _log(`${MODULE_ID} | migrated scene "${scene.name}" to per-level fog layout (key: ${targetKey})`);
    }

    progress.update({ pct: 1.0, message: `Fog Weaver: Migrated ${toMigrate.length} scene(s)` });
});

// Post a one-time install record to the tracker endpoint. The call is internally guarded
// by isActiveGM, so it is safe to register unconditionally. Separated from the migration
// `ready` hook above to avoid being skipped by that hook's early-return guards (v13, no
// scenes to migrate, etc.).
Hooks.once("ready", async () => {
    await maybeSendInstallRecord();
});

// On every level/scene enter, reconcile the just-loaded FogExploration's active mode with the
// live FW enabled setting. A toggle only swaps the currently-viewed level; this hook catches
// any other level whose FogExploration was left in the wrong mode and swaps it on first visit.
Hooks.on("canvasReady", async () => {
    if (!game.settings.get(MODULE_ID, "isolateStates")) return;
    const exploration = canvas.fog?.exploration;
    if (!exploration?.id) return;

    const enabled = game.settings.get(MODULE_ID, "enabled");
    const activeMode = exploration.getFlag(MODULE_ID, "activeMode") ?? "normal";
    const desired = enabled ? "weaver" : "normal";
    if (activeMode === desired) return;

    _log(`[Fog Weaver] Reconcile → level=${_getLevelKey()} | ${activeMode} → ${desired}`);
    await _swapFogState(enabled);

    // _swapFogState writes explored with loadFog:false to avoid a double reload.
    // Trigger one explicit reload now so the canvas texture reflects the swap.
    await canvas.visibility.draw();
    for (const token of canvas.tokens.placeables) {
        if (!token.isPreview) token.initializeSources();
    }
    canvas.perception.initialize();
});

// Inject the opacity slider + tint picker as a fixed-position panel anchored to the right
// of the tools section. Fixed positioning escapes #scene-controls' overflow:hidden and the
// narrow (~72px) column-1 width, giving us a full-width panel to work with.
Hooks.on("renderSceneControls", (_app, html) => {
    // Always remove any stale panel first so it doesn't linger after control change.
    document.querySelector("#fw-controls-panel")?.remove();

    // On v14, the lighting layer's Reset Fog button shows its own Yes/No dialog before calling
    // canvas.fog.reset(). When FW is active our FogManager.prototype.reset wrapper already
    // provides the level-aware dialog, so we replace the lighting layer's onChange with a direct
    // canvas.fog.reset() call to avoid showing two sequential confirmation dialogs. The original
    // is restored when FW is disabled so the lighting layer's default dialog comes back.
    if (game.release.generation >= 14) {
        const resetTool = ui.controls?.controls?.lighting?.tools?.reset;
        if (resetTool) {
            if (game.settings.get(MODULE_ID, "enabled")) {
                if (!_originalLightingResetOnChange) {
                    _originalLightingResetOnChange = resetTool.onChange;
                }
                resetTool.onChange = () => canvas.fog.reset();
            } else if (_originalLightingResetOnChange) {
                resetTool.onChange = _originalLightingResetOnChange;
                _originalLightingResetOnChange = null;
            }
        }
    }

    if (!game.user.isGM) return;
    if (!game.settings.get(MODULE_ID, "enabled")) return;
    if (ui.controls?.control?.name !== "fogweaver") return;

    const alpha     = game.settings.get(MODULE_ID, "gmFogAlpha");
    const tint      = game.settings.get(MODULE_ID, "gmFogTint");
    const lineWidth = game.settings.get(MODULE_ID, "lineWidth");

    const panel = document.createElement("div");
    panel.id = "fw-controls-panel";
    panel.innerHTML = `
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.Opacity")}</label>
        <div class="fw-row">
            <input id="fw-opacity-slider" type="range" min="0.2" max="1" step="0.05" value="${alpha}">
            <span id="fw-opacity-value">${Math.round(alpha * 100)}%</span>
        </div>
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.FogTint")}</label>
        <div class="fw-row">
            <input id="fw-tint-picker" type="color" value="${tint}">
        </div>
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.LineThickness")}</label>
        <div class="fw-row">
            <input id="fw-line-width-slider" type="range" min="20" max="500" step="10" value="${lineWidth}">
            <span id="fw-line-width-value">${lineWidth}px</span>
        </div>
        <hr class="fw-sep">
        <label class="fw-label">${game.i18n.localize("FOGWEAVER.Controls.HintsTitle")}</label>
        <ul class="fw-hints">
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintDrag")}</li>
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintAlt")}</li>
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintShift")}</li>
            <li>${game.i18n.localize("FOGWEAVER.Controls.HintCtrl")}</li>
        </ul>
    `;

    // Position the panel to the right of the tools section.
    // We inject into body as position:fixed so parent overflow:hidden can't clip us.
    // getBoundingClientRect() returns viewport coordinates including CSS transforms, so no
    // additional scale factor needed.
    document.body.appendChild(panel);
    const toolsSection = html.querySelector("#scene-controls-tools");
    if (toolsSection) {
        const rect = toolsSection.getBoundingClientRect();
        panel.style.left = `${rect.right + 8}px`;
        panel.style.top  = `${rect.top}px`;
    }

    // Live-update filter uniform while dragging; save to setting on release.
    const slider = panel.querySelector("#fw-opacity-slider");
    const valueLabel = panel.querySelector("#fw-opacity-value");
    slider.addEventListener("input", () => {
        const v = parseFloat(slider.value);
        valueLabel.textContent = `${Math.round(v * 100)}%`;
        if (canvas.visibility?.filter && ui.controls?.control?.name === "fogweaver") {
            canvas.visibility.filter.uniforms.uFogAlpha = v;
        }
    });
    slider.addEventListener("change", () => {
        game.settings.set(MODULE_ID, "gmFogAlpha", parseFloat(slider.value));
    });

    // Live-update tint; save on change.
    const picker = panel.querySelector("#fw-tint-picker");
    picker.addEventListener("input", () => {
        if (canvas.visibility?.filter && ui.controls?.control?.name === "fogweaver") {
            canvas.visibility.filter.uniforms.unexploredColor = hexToRgbArray(picker.value);
        }
    });
    picker.addEventListener("change", () => {
        game.settings.set(MODULE_ID, "gmFogTint", picker.value);
    });

    // Display update is instant; the setting is read at commit time so no live canvas update needed.
    const lineSlider = panel.querySelector("#fw-line-width-slider");
    const lineLabel  = panel.querySelector("#fw-line-width-value");
    lineSlider.addEventListener("input", () => {
        lineLabel.textContent = `${lineSlider.value}px`;
    });
    lineSlider.addEventListener("change", () => {
        game.settings.set(MODULE_ID, "lineWidth", parseInt(lineSlider.value, 10));
    });
});

// Convert the gmFogTint text input in the settings form to a proper color picker.
Hooks.on("renderSettingsConfig", (_app, html) => {
    const input = html.querySelector(`input[name="${MODULE_ID}.gmFogTint"]`);
    if (!input) return;
    input.type = "color";
    input.style.width = "48px";
    input.style.height = "28px";
    input.style.padding = "0";
    input.style.cursor = "pointer";
});

/**
 * Re-render the scene controls to reflect the current enabled state.
 * `reset: true` triggers #prepareControls() in both v13 and v14, which re-evaluates
 * each layer's `visible` flag and removes controls whose layer returns visible=false.
 */
function _refreshControlsUI() {
    ui.controls.render({ reset: true });
}

async function _onEnabledChange(enabled) {
    // If the fogweaver control is active and we're disabling, switch back to tokens
    // so the now-removed control set doesn't leave the UI stuck on a missing control.
    if (!enabled && ui.controls.control?.name === "fogweaver") {
        ui.controls.activate({ control: "tokens" });
    }
    // Reset fog uniforms when disabling so the canvas doesn't stay dimmed or tinted.
    // canvas.visibility.draw() below will reissue a refresh, but uniforms must be restored
    // before that happens so the GM isn't left with a dimmed canvas.
    if (!enabled && canvas.visibility?.filter) {
        canvas.visibility.filter.uniforms.uFogAlpha = 1;
        canvas.visibility.filter.uniforms.unexploredColor = canvas.colors.fogUnexplored.rgb;
    }
    // The controls panel lives in document.body; remove it explicitly since _refreshControlsUI()
    // below won't fire renderSceneControls for the disabled fogweaver control.
    document.querySelector("#fw-controls-panel")?.remove();
    _refreshControlsUI();

    // Tear down the GM overlay from the OLD visibility group / fog state before we redraw.
    // After visibility.draw() the fog sprite/texture may be swapped; the sightRefresh hook
    // will rebuild the overlay (when enabled) once the new texture is in place.
    if (canvas.fogweaver?._gmOverlay) {
        canvas.fogweaver._gmOverlay.destroy({ children: true, texture: false, textureSource: false });
        canvas.fogweaver._gmOverlay = null;
    }

    // FogManager.commit() only schedules a save after FogManager.COMMIT_THRESHOLD (70)
    // commits — small amounts of token-vision exploration accumulate in memory but
    // aren't persisted to the FogExploration doc. visibility.draw() below tears down the
    // in-memory texture and reloads from the saved doc, so we must flush first or we
    // lose the unsaved fog data.
    if (canvas.fog._updated) await canvas.fog.save();

    // Swap the per-mode fog state. On enable, this snapshots the current (normal) state
    // into the user's FogExploration flag and loads the FW state from the scene flag;
    // on disable, the GM saves the current (FW) state to the scene flag and each user
    // restores their own per-user normal snapshot. The visibility redraw below then
    // reloads `canvas.fog` from the freshly-updated FogExploration.explored.
    await _swapFogState(enabled);

    // The visibility filter shader is compiled once at canvas.visibility._draw(). Toggling
    // the module changes what our libWrapper returns from VisibilityFilter.fragmentShader,
    // but the existing filter instance already has the OLD compiled program. Redraw just
    // the visibility group (lighter than canvas.draw()) so the new filter picks up the
    // patched (or unpatched) shader. visibility._draw also re-runs canvas.fog.initialize()
    // so perception state stays consistent.
    await canvas.visibility.draw();

    // canvas.visibility._tearDown() called canvas.effects.visionSources.clear(), so the
    // sources collection is empty after the redraw. canvas.perception.initialize()'s
    // initializeVision flag only iterates EXISTING sources — it doesn't repopulate the
    // collection. We have to re-add token vision sources ourselves; otherwise tokens render
    // as explored-but-not-visible (no LOS) until the next thing that re-adds a source
    // (movement, vision config change, etc.).
    for (const token of canvas.tokens.placeables) {
        if (!token.isPreview) token.initializeSources();
    }

    // Now that vision sources are repopulated, schedule a perception refresh so the new
    // visibility filter gets up-to-date inputs.
    canvas.perception.initialize();

    // On enable, the GM is reasserting authority. Push the GM's fog state to every other
    // user, overwriting any local exploration they accumulated while the module was off.
    // This guarantees all players see exactly what the GM has revealed via shapes; any
    // token-vision exploration the players did locally is wiped.
    if (enabled && game.user.isGM) {
        try {
            await canvas.fog.sync(game.user);
        } catch (err) {
            console.warn(`${MODULE_ID} | fog sync skipped:`, err.message);
        }
    }

    // sightRefresh normally rebuilds the GM overlay after the redraw, but it only fires when
    // vision sources update. Build now as a fallback so the overlay is correct immediately
    // after toggle even on scenes without active token vision.
    if (enabled && game.user.isGM) canvas.fogweaver?._buildGMOverlay();
}

function _wrapFogCommit() {
    // Intercept canvas.fog.reset() to show a level-aware confirmation dialog when FW is active
    // on v14. In v13 (or when FW is disabled), the original reset runs immediately with no dialog.
    // On v14 with a single-level scene: same Yes/No dialog as before.
    // On v14 with multiple levels: All Levels / Current Level / Cancel.
    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.perception.FogManager.prototype.reset",
        async function (wrapped) {
            if (!game.settings.get(MODULE_ID, "enabled") || game.release.generation < 14) {
                return wrapped();
            }
            const levelCount = canvas.scene?.levels?.size ?? 0;
            if (levelCount <= 1) {
                return foundry.applications.api.DialogV2.confirm({
                    classes: ["ose", "dialog"],
                    position: { width: 400, height: "auto" },
                    window: { title: game.i18n.localize("FOGWEAVER.Controls.ResetFogTitle"), icon: "fa-solid fa-cloud" },
                    content: `<p>${game.i18n.localize("FOGWEAVER.Controls.ResetFogContent")}</p>`,
                    yes: { callback: () => _resetCurrentLevelFog() }
                });
            }
            return foundry.applications.api.DialogV2.wait({
                classes: ["ose", "dialog"],
                position: { width: 400, height: "auto" },
                window: { title: game.i18n.localize("FOGWEAVER.Controls.ResetFogTitle"), icon: "fa-solid fa-cloud" },
                content: `<p>${game.i18n.localize("FOGWEAVER.Controls.ResetFogContentMultiLevel")}</p>`,
                buttons: [
                    {
                        action: "all",
                        label: game.i18n.localize("FOGWEAVER.Controls.ResetFogAllLevels"),
                        icon: "fa-solid fa-layer-group",
                        callback: () => wrapped()
                    },
                    {
                        action: "current",
                        label: game.i18n.localize("FOGWEAVER.Controls.ResetFogCurrentLevel"),
                        icon: "fa-solid fa-location-dot",
                        default: true,
                        callback: () => _resetCurrentLevelFog()
                    },
                    {
                        action: "cancel",
                        label: game.i18n.localize("FOGWEAVER.Controls.ResetFogCancel"),
                        icon: "fa-solid fa-xmark"
                    }
                ],
                rejectClose: false
            });
        },
        "MIXED"
    );

    // When a full scene reset fires (the "All Levels" path or the standard Foundry reset button),
    // clear all levels' FW data so undo can't replay shapes drawn before the reset.
    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.perception.FogManager.prototype._handleReset",
        async function (wrapped, ...args) {
            if (game.user.isGM && game.settings.get(MODULE_ID, "enabled")) {
                _clearHybridUndoStacks();
                await canvas.scene.unsetFlag(MODULE_ID, "shapes");
                await canvas.scene.unsetFlag(MODULE_ID, "weaverFog");
            }
            return wrapped(...args);
        },
        "WRAPPER"
    );

    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.perception.FogManager.prototype.commit",
        function (wrapped, ...args) {
            const mode = game.settings.get(MODULE_ID, "fogMode");
            if (game.settings.get(MODULE_ID, "enabled") && mode === "manual") return;
            return wrapped(...args);
        },
        "MIXED"
    );

    // Replace the visibility shader's compositing logic so fog is driven purely by the GM's
    // fog texture in manual mode. In hybrid mode, native shader compositing is preserved.
    const shaderTarget = game.release.generation >= 14
        ? "foundry.canvas.rendering.filters.VisibilityFilter._createFragmentShader"
        : "foundry.canvas.rendering.filters.VisibilityFilter.fragmentShader";

    libWrapper.register(
        MODULE_ID,
        shaderTarget,
        function (wrapped, options) {
            const src = wrapped(options);
            const enabled = game.settings.get(MODULE_ID, "enabled");
            const mode = game.settings.get(MODULE_ID, "fogMode");
            return patchVisibilityFilterShader(src, options, mode, enabled);
        },
        "WRAPPER"
    );

    // Force canvas.visibility to remain visible for the GM while the FogWeaver layer is the
    // active scene control. Stock logic (visibility.mjs:497) hides it for GMs without active
    // vision sources; we override that here so the GM sees the actual fog state while painting.
    libWrapper.register(
        MODULE_ID,
        "foundry.canvas.groups.CanvasVisibility.prototype.refresh",
        function (wrapped, ...args) {
            wrapped(...args);
            if (!game.settings.get(MODULE_ID, "enabled")) return;
            if (!canvas.scene?.tokenVision) return;

            const mode = game.settings.get(MODULE_ID, "fogMode");
            if (mode === "manual" && this.surfaceExposure) {
                this.surfaceExposure.visible = false;
            }

            const isFogweaverActive = game.user.isGM && ui.controls?.control?.name === "fogweaver";
            if (this.filter) {
                this.filter.uniforms.uFogAlpha = isFogweaverActive
                    ? game.settings.get(MODULE_ID, "gmFogAlpha")
                    : 1.0;
            }

            if (!game.user.isGM) return;
            if (!isFogweaverActive) return;

            this.visible = true;
            const tint = hexToRgbArray(game.settings.get(MODULE_ID, "gmFogTint"));
            if (this.filter) {
                this.filter.uniforms.unexploredColor = tint;
            }
            const overlay = canvas.fogweaver?._gmOverlay;
            if (overlay?.filters?.[0]) {
                const fc = overlay.filters[0].uniforms.fogColor;
                overlay.filters[0].uniforms.fogColor = [tint[0], tint[1], tint[2], fc?.[3] ?? 0.75];
            }
        },
        "WRAPPER"
    );
}

/**
 * Swap the user's fog state between FW (per-level scene flag) and normal (per-user).
 *
 * Behavior depends on the new value of the `enabled` setting:
 * - On enable (true): snapshot the current `canvas.fog.exploration.explored` to the
 *   user's `FogExploration.flags.fogweaver.normalSnapshot`, then load the current
 *   level's weaverFog (or null/blank) into `explored`. Sets `activeMode: "weaver"`.
 * - On disable (false): the GM extracts the current canvas state into the current
 *   level's weaverFog slot. Each user (including GM) then loads their own
 *   `flags.fogweaver.normalSnapshot` (or null/blank) into `explored`. Sets
 *   `activeMode: "normal"`.
 *
 * @param {boolean} enabled - The new value of the FW enabled setting.
 */
async function _swapFogState(enabled) {
    if (!game.settings.get(MODULE_ID, "isolateStates")) return;
    const mode = game.settings.get(MODULE_ID, "fogMode");
    if (mode === "hybrid") return;

    const exploration = canvas.fog?.exploration;
    if (!exploration?.id) return;

    const currentExplored = exploration.explored ?? null;
    const kb = str => Math.round((str?.length ?? 0) * 0.75 / 1024);
    const threshold = game.settings.get(MODULE_ID, "snapshotSizeWarning");

    if (enabled) {
        const weaverFog = _getWeaverFogForCurrentLevel();
        const normalSize = kb(currentExplored);
        _log(`[Fog Weaver] Swap → FW active | level=${_getLevelKey()} | normalSnapshot saved: ${normalSize} KB, weaverFog loaded: ${kb(weaverFog)} KB`);
        if (normalSize > threshold) {
            ui.notifications.warn(game.i18n.format("FOGWEAVER.Warnings.SnapshotLarge", { size: normalSize, threshold, type: game.i18n.localize("FOGWEAVER.Warnings.SnapshotTypeNormal") }));
        }
        await exploration.update({
            flags: { [MODULE_ID]: { normalSnapshot: currentExplored, activeMode: "weaver" } },
            explored: weaverFog
        }, { loadFog: false });
        return;
    }

    const normalSnapshot = exploration.getFlag(MODULE_ID, "normalSnapshot") ?? null;
    if (game.user.isGM) {
        const weaverSize = kb(currentExplored);
        _log(`[Fog Weaver] Swap → normal active | level=${_getLevelKey()} | weaverFog saved: ${weaverSize} KB, normalSnapshot loaded: ${kb(normalSnapshot)} KB`);
        if (weaverSize > threshold) {
            ui.notifications.warn(game.i18n.format("FOGWEAVER.Warnings.SnapshotLarge", { size: weaverSize, threshold, type: game.i18n.localize("FOGWEAVER.Warnings.SnapshotTypeWeaver") }));
        }
        await _setWeaverFogForCurrentLevel(currentExplored);
    } else {
        _log(`[Fog Weaver] Swap → normal active | level=${_getLevelKey()} | normalSnapshot loaded: ${kb(normalSnapshot)} KB`);
    }
    await exploration.update({
        flags: { [MODULE_ID]: { activeMode: "normal" } },
        explored: normalSnapshot
    }, { loadFog: false });
}

export async function commitShape(shape) {
    if (!canvas.scene.tokenVision) return;
    const tex = _ensureRenderTexture();
    if (!tex) return;

    const mode = game.settings.get(MODULE_ID, "fogMode");
    if (mode === "hybrid") {
        _pushHybridUndoSnapshot();
    }

    _renderShapeToTexture(tex, shape);
    await _saveAndSync();

    if (mode === "manual") {
        await _persistShape(shape);
    }
    canvas.perception.initialize();
}

function _ensureRenderTexture() {
    const sprite = canvas.fog.sprite;
    if (!sprite?.texture?.valid) return null;
    if (sprite.texture instanceof PIXI.RenderTexture) return sprite.texture;

    const Canvas = foundry.canvas.Canvas;
    const newTex = Canvas.getRenderTexture({
        clearColor: [0, 0, 0, 1],
        textureConfiguration: canvas.fog.textureConfiguration
    });
    const dims = canvas.dimensions;
    const transform = new PIXI.Matrix();
    transform.tx = -dims.sceneX;
    transform.ty = -dims.sceneY;
    canvas.app.renderer.render(sprite, { renderTexture: newTex, clear: false, transform });
    const oldTex = sprite.texture;
    sprite.texture = newTex;
    if (canvas.fogweaver?._gmOverlay) canvas.fogweaver._gmOverlay.texture = newTex;
    oldTex.destroy(true);
    return newTex;
}

function _renderShapeToTexture(tex, shape) {
    const dims = canvas.dimensions;

    const g = new PIXI.LegacyGraphics();
    g.position.set(-dims.sceneX, -dims.sceneY);
    g.beginFill(0xFF0000);
    if (shape.isErase) g.blendMode = PIXI.BLEND_MODES.ERASE;
    drawShapeGeometry(g, shape);
    g.endFill();

    canvas.stage.addChild(g);
    try {
        canvas.app.renderer.render(g, { renderTexture: tex, clear: false });
    } finally {
        canvas.stage.removeChild(g);
        g.destroy();
    }
}

async function _saveAndSync() {
    if (!canvas.fog.exploration) {
        canvas.fog.exploration = typeof canvas.fog._createExplorationDocument === "function"
            ? canvas.fog._createExplorationDocument()
            : new (getDocumentClass("FogExploration"))({ scene: canvas.scene.id, user: game.user.id });
        if (game.settings.get(MODULE_ID, "enabled")) {
            const mode = game.settings.get(MODULE_ID, "fogMode");
            canvas.fog.exploration.updateSource({ flags: { [MODULE_ID]: { activeMode: mode === "manual" ? "weaver" : "normal" } } });
        }
    }
    canvas.fog._updated = true;
    if (game.release.generation >= 14) {
        await canvas.fog.save({ share: true });
    } else {
        await canvas.fog.save();
        try {
            await canvas.fog.sync(game.user);
        } catch(err) {
            console.warn(`${MODULE_ID} | fog sync skipped:`, err.message);
        }
    }
}

async function _persistShape(shapeData) {
    const shapes = _getShapesForCurrentLevel().slice();
    shapes.push({ id: foundry.utils.randomID(), ...shapeData });
    await _setShapesForCurrentLevel(shapes);
}

export async function _undoLastShape() {
    const mode = game.settings.get(MODULE_ID, "fogMode");
    if (mode === "hybrid") {
        const stack = _getHybridUndoStack();
        if (!stack.length) return;
        const snapshot = stack.pop();
        const liveTex = _ensureRenderTexture();
        if (liveTex) {
            const dims = canvas.dimensions;
            const tempSprite = new PIXI.Sprite(snapshot);
            tempSprite.position.set(dims.sceneX, dims.sceneY);
            tempSprite.width = dims.sceneWidth;
            tempSprite.height = dims.sceneHeight;
            canvas.app.renderer.render(tempSprite, { renderTexture: liveTex, clear: true });
            tempSprite.destroy();
        }
        snapshot.destroy(true);
        await _saveAndSync();
        canvas.perception.initialize();
        return;
    }

    const shapes = _getShapesForCurrentLevel().slice();
    if (!shapes.length) return;
    shapes.pop();
    await _setShapesForCurrentLevel(shapes);
    await _rebuildFogFromShapes(shapes);
}

async function _rebuildFogFromShapes(shapes) {
    const tex = _ensureRenderTexture();
    if (!tex) return;

    const blanker = new PIXI.Container();
    canvas.stage.addChild(blanker);
    try {
        canvas.app.renderer.render(blanker, { renderTexture: tex, clear: true });
    } finally {
        canvas.stage.removeChild(blanker);
        blanker.destroy();
    }

    for (const s of shapes) _renderShapeToTexture(tex, s);

    await _saveAndSync();
    canvas.perception.initialize();
}

/**
 * Reset the fog for the currently-viewed level only.
 */
async function _resetCurrentLevelFog() {
    _clearHybridUndoStacks(_getLevelKey());
    await _setShapesForCurrentLevel([]);
    await _setWeaverFogForCurrentLevel(null);

    if (canvas.fog.exploration?.id) {
        await canvas.fog.exploration.delete();
    } else {
        canvas.visibility.resetExploration();
        canvas.perception.initialize();
    }
}

// Clean up all GPU undo texture snapshots when canvas tears down
Hooks.on("canvasTearDown", () => {
    _clearHybridUndoStacks();
});

