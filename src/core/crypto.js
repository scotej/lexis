/**
 * Password-derived encryption, using only the Web Crypto API that both the
 * browser and the Tauri webview already ship.
 *
 * Why this exists: GitHub Pages on a free account serves a *public* page.
 * There is no server to check a password against, so a login that merely
 * hid the interface could be walked straight past with view-source. The
 * password here is therefore cryptographic rather than cosmetic — it derives
 * the key that unwraps your GitHub token and encrypts everything before it
 * leaves the device. Someone who reads the page source learns nothing; the
 * synced file is ciphertext to anyone without the password.
 *
 * The corollary, which the setup screen states plainly: a forgotten password
 * cannot be reset, because nothing anywhere can decrypt without it.
 */

const PBKDF2_ITERATIONS = 600_000; // OWASP guidance for PBKDF2-HMAC-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length

const subtle = globalThis.crypto?.subtle;

export function cryptoAvailable() {
  return Boolean(subtle);
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function randomSalt() {
  return toBase64(randomBytes(SALT_BYTES));
}

export function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derives the AES key. The salt must be identical on every device, which is
 * why it travels inside the synced envelope rather than being generated
 * per-device — two devices with the same password must land on the same key.
 */
export async function deriveKey(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  if (!subtle) throw new Error("this browser has no Web Crypto support");
  const base = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt: fromBase64(saltB64), iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJSON(key, value) {
  const iv = randomBytes(IV_BYTES);
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/**
 * Returns the decrypted value, or throws. AES-GCM authenticates, so a wrong
 * password fails here rather than yielding garbage — which is exactly what
 * makes this usable as the password check.
 */
export async function decryptJSON(key, { iv, ct }) {
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

export const ITERATIONS = PBKDF2_ITERATIONS;
