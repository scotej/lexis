/**
 * The local vault: your GitHub token and sync settings, encrypted at rest
 * under the same password that encrypts the synced data.
 *
 * The token is never committed, never baked into the build, and never
 * leaves the device except as an Authorization header to api.github.com.
 * It is entered once at runtime and stored only in ciphertext.
 */

import { deriveKey, encryptJSON, decryptJSON, randomSalt, ITERATIONS } from "./crypto.js";
import { fetchRemote, checkAccess, claimSalt } from "./sync.js";
import { emptyBank } from "./bank.js";
import { storeGet, storeSet, storeRemove } from "../platform/store.js";

const VAULT_KEY = "lexis-vault";

export async function hasVault() {
  try {
    return Boolean(await storeGet(VAULT_KEY));
  } catch {
    return false;
  }
}

async function readVault() {
  try {
    return await storeGet(VAULT_KEY);
  } catch {
    return null;
  }
}

async function writeVault(key, salt, config) {
  const payload = await encryptJSON(key, config);
  await storeSet(VAULT_KEY, { v: 1, salt, iterations: ITERATIONS, ...payload });
}

export async function clearVault() {
  await storeRemove(VAULT_KEY);
}

/**
 * First-time setup on this device.
 *
 * If the repository already holds a lexis file, we adopt *its* salt and
 * prove the password by decrypting it — that is what makes "same password
 * on every device" work, and what turns a typo into a clear error instead
 * of a second, silently divergent bank.
 */
export async function createVault({ password, token, owner, repo, path }) {
  if (!password || password.length < 8) {
    throw new Error("Use a password of at least 8 characters.");
  }
  const config = { token, owner, repo, path };
  const access = await checkAccess(config);

  const { envelope } = await fetchRemote(config);
  if (envelope) return adopt(envelope, password, config, access.warning);

  // No file yet — mint a salt and claim it. If another device is setting up at
  // the same moment, the write loses and we adopt whatever it established
  // rather than stranding this device with an unusable second key.
  const salt = randomSalt();
  const key = await deriveKey(password, salt);
  const won = await claimSalt(config, key, salt, emptyBank());
  if (!won) {
    const { envelope: theirs } = await fetchRemote(config);
    if (!theirs) throw new Error("Could not read the sync file. Try connecting again.");
    return adopt(theirs, password, config, access.warning);
  }
  await writeVault(key, salt, config);
  return { key, config, salt, warning: access.warning, adopted: false };
}

/**
 * Joins an existing sync file: take its salt, and prove the password by
 * decrypting what's already there. This is what makes "same password on every
 * device" work, and what turns a typo into a clear error rather than a second,
 * silently divergent bank.
 */
async function adopt(envelope, password, config, warning) {
  const salt = envelope.kdf?.salt;
  if (!salt) throw new Error("The synced file is missing its key settings.");
  const key = await deriveKey(password, salt, envelope.kdf.iterations ?? ITERATIONS);
  try {
    await decryptJSON(key, envelope);
  } catch {
    throw new Error(
      "That password doesn't match the one used on your other device. Sync is encrypted, so it must be the same password."
    );
  }
  await writeVault(key, salt, config);
  return { key, config, salt, warning, adopted: true };
}

/** Unlocks an existing vault. A wrong password fails the AES-GCM tag check. */
export async function unlockVault(password) {
  const vault = await readVault();
  if (!vault) throw new Error("No sync is set up on this device yet.");
  const key = await deriveKey(password, vault.salt, vault.iterations ?? ITERATIONS);
  let config;
  try {
    config = await decryptJSON(key, vault);
  } catch {
    throw new Error("Wrong password.");
  }
  return { key, config: { ...config, salt: vault.salt }, salt: vault.salt };
}

/** Rewrites the stored settings (e.g. a rotated token) under the same key. */
export async function updateVault(key, salt, config) {
  await writeVault(key, salt, config);
}
