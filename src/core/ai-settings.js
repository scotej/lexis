/**
 * Where the OpenRouter key and model live at rest.
 *
 * The rule is the one the sync vault established: a credential is entered at
 * runtime and stored only as ciphertext. On the web that ciphertext is sealed
 * under the session key derived from the unlock password — the same key that
 * already protects the bank cache and the conflict log — so nothing readable
 * survives the tab, and "use a different account" leaves nothing behind.
 *
 * The desktop has no password by design (the app works fully without sync),
 * so it supplies a device key from the Rust side instead: a random 256-bit
 * key generated once, kept in a file readable only by the user, in the same
 * app-data directory as everything else lexis keeps. That protects the key
 * from other accounts on the machine and from casual file copies; it cannot
 * protect it from someone already running as this user, and it doesn't
 * pretend to.
 */

import { encryptJSON, decryptJSON } from "./crypto.js";
import { storeGet, storeSet, storeRemove } from "../platform/store.js";

const SETTINGS_KEY = "lexis-ai";

/** What a stored settings object looks like when decrypted. */
export function emptyAiSettings() {
  return { key: "", model: "" };
}

/** Reads and unseals the settings. Any failure reads as "not set up yet". */
export async function loadAiSettings(platform) {
  try {
    const envelope = await storeGet(SETTINGS_KEY);
    if (!envelope) return emptyAiSettings();
    return await decryptJSON(await platform.deviceKey(), envelope);
  } catch {
    // Unreadable — a different device key after a reset, or tampered storage.
    // An empty panel is the honest recovery; there is no plaintext anywhere
    // to fall back to.
    return emptyAiSettings();
  }
}

/**
 * Seals and stores the settings, returning the cleaned copy actually saved.
 * The key is trimmed here so "it failed because of a trailing newline" never
 * happens; the model string is left to the client's normalizeModel().
 */
export async function saveAiSettings(platform, settings) {
  const clean = {
    key: String(settings?.key ?? "").trim(),
    model: String(settings?.model ?? "").trim(),
  };
  if (!clean.key) throw new Error("Paste your OpenRouter key first.");
  const envelope = await encryptJSON(await platform.deviceKey(), clean);
  await storeSet(SETTINGS_KEY, envelope);
  return clean;
}

export async function clearAiSettings() {
  await storeRemove(SETTINGS_KEY);
}
