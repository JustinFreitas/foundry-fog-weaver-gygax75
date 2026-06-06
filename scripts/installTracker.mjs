/**
 * Install tracking utility for fog-weaver.
 *
 * Posts a one-time install record to the public install-tracker API when the
 * module loads in a Foundry world. The record is re-sent when the module
 * version changes (treating an upgrade as a new install). Failed sends are
 * retried up to MAX_ATTEMPTS times across world loads, then silently abandoned.
 *
 * NOTE: The API key below is NOT a security boundary. It is visible to anyone
 * who reads this source and exists solely to let the public endpoint reject
 * obvious unauthenticated spam. Do not treat it as a secret.
 */

const MODULE_ID = "fog-weaver";
const SETTING_KEY = "installTracker";
const ENDPOINT = "https://foundry.turkeysunite-local.org/module-install";
// Not a security boundary — anyone reading module source can extract this.
// It exists only to let the public endpoint reject obvious unauthenticated spam.
const API_KEY = "1d1075fcabbb5e3e6757f7cc80c229cf4234b1dc226acd91c5d284d3380e0295";
const MAX_ATTEMPTS = 3;

const DEFAULT_STATE = Object.freeze({
  sent: false,
  version: null,
  attempts: 0,
  lastError: null
});

/**
 * Emit a console.log message only when fog-weaver's debugLogging setting is on.
 * Mirrors the private _log helper in fogweaver.mjs so this file stays drop-in.
 *
 * @param {...any} args - Arguments forwarded to console.log.
 */
function _log(...args) {
  try {
    if (!game.settings.get(MODULE_ID, "debugLogging")) return;
  } catch {
    return;
  }
  console.log(`[${MODULE_ID}]`, ...args);
}

/**
 * Register the hidden world-scoped setting that persists install-tracker state.
 * Call once from the module's `init` hook alongside other settings.registrations.
 */
export function registerInstallTrackerSetting() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: { ...DEFAULT_STATE }
  });
}

/**
 * Send the install record if the current world+version hasn't been recorded
 * yet (and we haven't exhausted retry attempts). No-op for non-active-GM
 * sessions. Call once from the module's `ready` hook.
 */
export async function maybeSendInstallRecord() {
  if (!game.user.isActiveGM) {
    _log("install:maybeSend", "skipping — not active GM");
    return;
  }

  const state = _readState();
  const currentVersion = game.modules.get(MODULE_ID)?.version ?? "unknown";

  if (!_shouldSendInstallRecord(state, currentVersion)) {
    _log("install:maybeSend", "skipping — already recorded or retries exhausted", {
      sent: state.sent, storedVersion: state.version,
      currentVersion, attempts: state.attempts
    });
    return;
  }

  // Version differs from the stored version → reset attempt counter so an
  // upgrade always gets a fresh 3 tries regardless of prior failure history.
  const attemptsForThisVersion = state.version === currentVersion ? state.attempts : 0;
  const isUpgrade = state.version !== null && state.version !== currentVersion;

  const payload = _buildPayload(currentVersion, isUpgrade);
  _log("install:maybeSend", "posting install record", {
    endpoint: ENDPOINT, payload, attempt: attemptsForThisVersion + 1
  });

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-install-tracker-key": API_KEY
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    await _writeState({
      sent: true,
      version: currentVersion,
      attempts: attemptsForThisVersion + 1,
      lastError: null
    });
    _log("install:maybeSend", "install record posted successfully");
  } catch (err) {
    const newAttempts = attemptsForThisVersion + 1;
    const message = err?.message ?? String(err);
    await _writeState({
      sent: false,
      version: currentVersion,
      attempts: newAttempts,
      lastError: message
    });
    _log("install:maybeSend", "install record post failed", {
      error: message, attempts: newAttempts, max: MAX_ATTEMPTS
    });
    if (newAttempts >= MAX_ATTEMPTS) {
      console.warn(`${MODULE_ID} | Install tracking gave up after ${MAX_ATTEMPTS} failed attempts: ${message}`);
    }
  }
}

/**
 * Decide whether the install record should be sent for the current load.
 *
 * Returns true when:
 * - The record has never been sent for the current version (first-ever send or
 *   version change treated as a fresh install).
 * - A prior attempt failed but we haven't yet reached MAX_ATTEMPTS.
 *
 * Returns false when:
 * - The record was already sent successfully for the current version.
 * - Attempts for this version are exhausted.
 *
 * @param {object} state - Current persisted tracker state.
 * @param {string} currentVersion - Module version from `module.json`.
 * @returns {boolean}
 */
function _shouldSendInstallRecord(state, currentVersion) {
  if (state.sent && state.version === currentVersion) return false;
  if (!state.sent && state.version === currentVersion && state.attempts >= MAX_ATTEMPTS) return false;
  return true;
}

/**
 * Build the JSON payload sent to the install-tracker endpoint.
 *
 * @param {string} moduleVersion - Current module version string.
 * @param {boolean} updated - True when the module version changed since the last recorded send.
 * @returns {object}
 */
function _buildPayload(moduleVersion, updated = false) {
  return {
    moduleId: MODULE_ID,
    updated,
    system: game.system.id,
    systemVersion: game.system.version,
    foundryVersion: game.version,
    worldId: game.world.id,
    moduleVersion
  };
}

/**
 * Read and normalise the persisted tracker state from world settings.
 * Defends against a hand-edited settings.db that stored a non-object value.
 *
 * @returns {object} Normalised state merged over DEFAULT_STATE defaults.
 */
function _readState() {
  const raw = game.settings.get(MODULE_ID, SETTING_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...raw };
}

/**
 * Persist updated tracker state to the world setting.
 *
 * @param {object} state - New state to store.
 * @returns {Promise<void>}
 */
async function _writeState(state) {
  await game.settings.set(MODULE_ID, SETTING_KEY, state);
}
