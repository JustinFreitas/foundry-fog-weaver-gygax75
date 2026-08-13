// Mock Foundry VTT and PIXI globals for headless Node.js unit testing
globalThis.foundry = {
    canvas: {
        layers: {
            InteractionLayer: class {}
        },
        Canvas: {
            getRenderTexture: () => ({})
        }
    },
    utils: {
        mergeObject: (a, b) => Object.assign({}, a, b),
        randomID: () => "test_id_123"
    }
};

globalThis.PIXI = {
    LegacyGraphics: class {
        position = { set() {} };
        beginFill() {}
        endFill() {}
        drawEllipse() {}
        drawCircle() {}
        drawRect() {}
        lineStyle() {}
        moveTo() {}
        lineTo() {}
        clear() {}
    },
    Filter: class {},
    Matrix: class {
        tx = 0;
        ty = 0;
    },
    Container: class {
        addChild() {}
        removeChild() {}
        destroy() {}
    },
    Sprite: class {
        position = { set() {} };
        destroy() {}
    },
    RenderTexture: class {
        destroy() {}
    },
    BLEND_MODES: {
        ERASE: "erase"
    },
    LINE_CAP: {
        ROUND: "round"
    },
    LINE_JOIN: {
        ROUND: "round"
    }
};

globalThis.CONFIG = {
    Canvas: {
        visibilityFilter: {
            defaultUniforms: {}
        },
        layers: {}
    }
};

globalThis.Hooks = {
    once: () => {},
    on: () => {}
};

globalThis.libWrapper = {
    register: () => {}
};

globalThis.game = {
    settings: {
        register: () => {},
        get: () => {}
    },
    user: {
        isGM: true
    },
    release: {
        generation: 14
    }
};
