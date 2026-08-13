import test from "node:test";
import assert from "node:assert/strict";
import { hexToRgbArray, normalizeBoundingBox } from "../scripts/layer.mjs";

test("hexToRgbArray converts CSS hex strings to [0..1] RGB arrays", () => {
    assert.deepEqual(hexToRgbArray("#ffffff"), [1, 1, 1]);
    assert.deepEqual(hexToRgbArray("#000000"), [0, 0, 0]);
    assert.deepEqual(hexToRgbArray("#ff0000"), [1, 0, 0]);
    assert.deepEqual(hexToRgbArray("#00ff00"), [0, 1, 0]);
    assert.deepEqual(hexToRgbArray("#0000ff"), [0, 0, 1]);

    const mixed = hexToRgbArray("#804020");
    assert.ok(Math.abs(mixed[0] - 128 / 255) < 1e-6);
    assert.ok(Math.abs(mixed[1] - 64 / 255) < 1e-6);
    assert.ok(Math.abs(mixed[2] - 32 / 255) < 1e-6);
});

test("normalizeBoundingBox normalizes standard and inverted drags", () => {
    // Normal drag (top-left to bottom-right)
    const normal = normalizeBoundingBox({ x: 100, y: 100 }, { x: 300, y: 400 }, false, false);
    assert.deepEqual(normal, {
        from: { x: 100, y: 100 },
        to: { x: 300, y: 400 }
    });

    // Inverted drag (bottom-right to top-left)
    const inverted = normalizeBoundingBox({ x: 300, y: 400 }, { x: 100, y: 100 }, false, false);
    assert.deepEqual(inverted, {
        from: { x: 100, y: 100 },
        to: { x: 300, y: 400 }
    });

    // Cross drag (bottom-left to top-right)
    const cross = normalizeBoundingBox({ x: 100, y: 400 }, { x: 300, y: 100 }, false, false);
    assert.deepEqual(cross, {
        from: { x: 100, y: 100 },
        to: { x: 300, y: 400 }
    });
});

test("normalizeBoundingBox handles Shift modifier (draw from center)", () => {
    const center = normalizeBoundingBox({ x: 200, y: 200 }, { x: 250, y: 300 }, true, false);
    assert.deepEqual(center, {
        from: { x: 150, y: 100 },
        to: { x: 250, y: 300 }
    });
});

test("normalizeBoundingBox handles Ctrl modifier (constrain to square)", () => {
    // dx = 50, dy = 150 -> constrained side = 150
    const constrained = normalizeBoundingBox({ x: 100, y: 100 }, { x: 150, y: 250 }, false, true);
    assert.deepEqual(constrained, {
        from: { x: 100, y: 100 },
        to: { x: 250, y: 250 }
    });
});

test("normalizeBoundingBox handles combined Shift + Ctrl modifiers", () => {
    const combined = normalizeBoundingBox({ x: 200, y: 200 }, { x: 250, y: 300 }, true, true);
    // side = 100 (dy = 100 > dx = 50), fromCenter = true
    assert.deepEqual(combined, {
        from: { x: 100, y: 100 },
        to: { x: 300, y: 300 }
    });
});
