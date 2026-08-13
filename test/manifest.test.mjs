import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(".");
const moduleJsonPath = path.join(rootDir, "module.json");
const enJsonPath = path.join(rootDir, "lang", "en.json");

test("module.json is valid and contains -gygax75.1 versioning", () => {
    assert.ok(fs.existsSync(moduleJsonPath), "module.json must exist");
    const raw = fs.readFileSync(moduleJsonPath, "utf8");
    const mod = JSON.parse(raw);

    assert.equal(mod.id, "fog-weaver");
    assert.ok(mod.version.includes("-gygax75."), `Version "${mod.version}" must include -gygax75. suffix`);
    assert.ok(mod.manifest.includes("JustinFreitas/foundry-fog-weaver-gygax75"));
    assert.ok(mod.download.includes("JustinFreitas/foundry-fog-weaver-gygax75"));
    assert.equal(mod.compatibility?.minimum, "13");
    assert.equal(mod.compatibility?.verified, "14");
});

test("lang/en.json contains required FogMode localization strings", () => {
    assert.ok(fs.existsSync(enJsonPath), "lang/en.json must exist");
    const raw = fs.readFileSync(enJsonPath, "utf8");
    const en = JSON.parse(raw);

    assert.ok(en.FOGWEAVER?.Settings?.FogMode?.Name, "FogMode Name must exist");
    assert.ok(en.FOGWEAVER?.Settings?.FogMode?.Hint, "FogMode Hint must exist");
    assert.ok(en.FOGWEAVER?.Settings?.FogMode?.Hybrid, "FogMode Hybrid choice must exist");
    assert.ok(en.FOGWEAVER?.Settings?.FogMode?.Manual, "FogMode Manual choice must exist");
    assert.ok(en.FOGWEAVER?.Controls?.Title, "Controls Title must exist");
    assert.ok(en.FOGWEAVER?.Controls?.ResetFog, "ResetFog must exist");
});
