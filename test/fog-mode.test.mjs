import test from "node:test";
import assert from "node:assert/strict";
import { patchVisibilityFilterShader } from "../scripts/fogweaver.mjs";

const SAMPLE_GLSL = `
precision mediump float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec3 unexploredColor;
uniform vec3 exploredColor;
void main() {
    float r = texture2D(uSampler, vTextureCoord).r;
    float v = texture2D(uSampler, vTextureCoord).g;
    vec4 unexplored = vec4(unexploredColor, 1.0);
    vec4 explored = vec4(unexploredColor, 1.0);
    vec4 fow = mix(unexplored, explored, max(r,v));
    gl_FragColor = mix(fow, vec4(0.0), v);
}
`;

test("patchVisibilityFilterShader leaves shader unchanged in hybrid mode", () => {
    const result = patchVisibilityFilterShader(SAMPLE_GLSL, {}, "hybrid", true);
    assert.equal(result, SAMPLE_GLSL);
    assert.ok(result.includes("max(r,v)"));
    assert.ok(result.includes("mix(fow, vec4(0.0), v)"));
});

test("patchVisibilityFilterShader leaves shader unchanged when disabled", () => {
    const result = patchVisibilityFilterShader(SAMPLE_GLSL, {}, "manual", false);
    assert.equal(result, SAMPLE_GLSL);
});

test("patchVisibilityFilterShader transforms shader in manual mode when enabled", () => {
    const result = patchVisibilityFilterShader(SAMPLE_GLSL, {}, "manual", true);
    assert.notEqual(result, SAMPLE_GLSL);
    assert.ok(result.includes("mix(unexplored, explored, r)"));
    assert.ok(result.includes("mix(fow, vec4(0.0), r)"));
    assert.ok(result.includes("uniform float uFogAlpha;"));
    assert.ok(result.includes("vec4(unexploredColor, uFogAlpha)"));
    assert.ok(!result.includes("max(r,v)"));
});

test("patchVisibilityFilterShader ignores persistentVision options", () => {
    const result = patchVisibilityFilterShader(SAMPLE_GLSL, { persistentVision: true }, "manual", true);
    assert.equal(result, SAMPLE_GLSL);
});
