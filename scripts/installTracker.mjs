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
 * yet. In this gygax75 fork, outbound telemetry is disabled.
 */
export async function maybeSendInstallRecord() {
  // Telemetry disabled in gygax75 fork: zero outbound network requests.
  return;
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
