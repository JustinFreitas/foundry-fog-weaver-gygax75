import test from "node:test";
import assert from "node:assert/strict";
import { _getHybridUndoStack, _clearHybridUndoStacks } from "../scripts/fogweaver.mjs";

class MockRenderTexture {
    constructor(id) {
        this.id = id;
        this.destroyed = false;
    }
    destroy(options) {
        this.destroyed = true;
    }
}

test("hybrid undo stack maintains separate stacks per level", () => {
    _clearHybridUndoStacks();
    const stack1 = _getHybridUndoStack("level1");
    const stack2 = _getHybridUndoStack("level2");

    stack1.push(new MockRenderTexture("l1_1"));
    stack2.push(new MockRenderTexture("l2_1"));

    assert.equal(stack1.length, 1);
    assert.equal(stack2.length, 1);
    assert.equal(stack1[0].id, "l1_1");
    assert.equal(stack2[0].id, "l2_1");
});

test("hybrid undo stack enforces max depth 5 and destroys evicted textures", () => {
    _clearHybridUndoStacks();
    const stack = _getHybridUndoStack("levelA");
    const textures = [];

    for (let i = 1; i <= 6; i++) {
        const tex = new MockRenderTexture(`tex_${i}`);
        textures.push(tex);
        stack.push(tex);
        if (stack.length > 5) {
            const oldest = stack.shift();
            oldest.destroy(true);
        }
    }

    assert.equal(stack.length, 5);
    assert.equal(textures[0].destroyed, true, "First texture should be destroyed upon eviction");
    assert.equal(textures[1].destroyed, false, "Second texture should remain in stack");
    assert.equal(stack[0].id, "tex_2");
    assert.equal(stack[4].id, "tex_6");
});

test("clearHybridUndoStacks destroys all allocated textures across levels", () => {
    _clearHybridUndoStacks();
    const stack1 = _getHybridUndoStack("lvl1");
    const stack2 = _getHybridUndoStack("lvl2");

    const t1 = new MockRenderTexture("t1");
    const t2 = new MockRenderTexture("t2");
    stack1.push(t1);
    stack2.push(t2);

    _clearHybridUndoStacks();

    assert.equal(t1.destroyed, true);
    assert.equal(t2.destroyed, true);
    assert.equal(_getHybridUndoStack("lvl1").length, 0);
    assert.equal(_getHybridUndoStack("lvl2").length, 0);
});

test("clearHybridUndoStacks targets single level when specified", () => {
    _clearHybridUndoStacks();
    const stack1 = _getHybridUndoStack("lvlA");
    const stack2 = _getHybridUndoStack("lvlB");

    const tA = new MockRenderTexture("tA");
    const tB = new MockRenderTexture("tB");
    stack1.push(tA);
    stack2.push(tB);

    _clearHybridUndoStacks("lvlA");

    assert.equal(tA.destroyed, true);
    assert.equal(tB.destroyed, false);
    assert.equal(_getHybridUndoStack("lvlA").length, 0);
    assert.equal(_getHybridUndoStack("lvlB").length, 1);

    _clearHybridUndoStacks();
});
