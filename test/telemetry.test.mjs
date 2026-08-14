import test from "node:test";
import assert from "node:assert/strict";
import { maybeSendInstallRecord, registerInstallTrackerSetting } from "../scripts/installTracker.mjs";

test("maybeSendInstallRecord is a safe no-op that makes no network calls", async () => {
    // Overwrite global fetch to ensure it is never called
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
        fetchCalled = true;
        throw new Error("fetch should not be called when telemetry is disabled");
    };

    try {
        await assert.doesNotReject(async () => {
            await maybeSendInstallRecord();
        });
        assert.equal(fetchCalled, false, "Outbound network fetch must not be invoked");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("registerInstallTrackerSetting registers the setting without throwing", () => {
    assert.doesNotThrow(() => {
        registerInstallTrackerSetting();
    });
});
