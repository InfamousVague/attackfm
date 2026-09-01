//! This device's own key to the account.
//!
//! An AttackFM account is the one key to everything (Phase 5 of the multi-hub
//! plan); the point of this file is that a person types the account password
//! ONCE per device, if at all. The first sign-in on a device makes an Ed25519
//! pair here, registers the public half on the account (`POST /v1/device`),
//! and from then on a token that has aged out is renewed by signing the
//! registry's challenge (`/v1/login/challenge` + `/v1/login/device`) - no
//! password, no prompt.
//!
//! The private key is a non-extractable WebCrypto key kept in IndexedDB:
//! nothing in the app can read its bytes, only ask the browser to sign with
//! it, and clearing the site's data is the only way it leaves. Where WebCrypto
//! has no Ed25519 (an old WebView) everything here answers null and the
//! password path stands as before.

import { addDevice, challenge, loginDevice, type RegistrySession } from './registry.ts';
import { deviceLabel } from '../api/http.ts';

const DB = 'attackfm-device-key';
const STORE = 'keys';
const ID = 'ed25519';
/** Which account this device's key has been registered on, so enrolment is
 *  asked of the registry once per (account, key) and not on every launch. */
const ENROLLED = 'attackfm-device-enrolled';

export function deviceKeySupported(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    !!crypto.subtle &&
    typeof indexedDB !== 'undefined'
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readPair(): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(ID);
      req.onsuccess = () => resolve((req.result as CryptoKeyPair | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function writePair(pair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(pair, ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The pair, made on first use. Null where the platform cannot. */
async function pair(): Promise<CryptoKeyPair | null> {
  if (!deviceKeySupported()) return null;
  try {
    const have = await readPair();
    if (have) return have;
    const made = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    await writePair(made);
    return made;
  } catch {
    return null;
  }
}

/** This device's public key as the registry spells it (base64url, raw 32 bytes). */
export async function devicePublicKey(): Promise<string | null> {
  const p = await pair();
  if (!p) return null;
  try {
    return b64url(new Uint8Array(await crypto.subtle.exportKey('raw', p.publicKey)));
  } catch {
    return null;
  }
}

async function signChallenge(nonce: string): Promise<string | null> {
  const p = await pair();
  if (!p) return null;
  try {
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, p.privateKey, new TextEncoder().encode(nonce));
    return b64url(new Uint8Array(sig));
  } catch {
    return null;
  }
}

/**
 * Register this device on the account just signed into. Idempotent per
 * (handle, key), and never in the way: a failure here leaves the password
 * sign-in that just succeeded exactly as it was.
 */
export async function enrolDevice(session: RegistrySession): Promise<void> {
  const pk = await devicePublicKey();
  if (!pk) return;
  const mark = `${session.account.handle}:${pk}`;
  try {
    if (localStorage.getItem(ENROLLED) === mark) return;
  } catch {
    // No storage: ask the registry again, which ignores a repeat.
  }
  try {
    await addDevice(session.token, pk, deviceLabel());
    localStorage.setItem(ENROLLED, mark);
  } catch {
    // Offline, or an old registry; next sign-in tries again.
  }
}

/**
 * Sign in as `handle` with this device's key alone - the renewal path for a
 * token that aged out while the app was closed. Null when this device holds
 * no key, the account does not know it, or the registry cannot be reached;
 * the caller then leaves the stored session in place as before.
 */
export async function deviceLogin(handle: string): Promise<RegistrySession | null> {
  if (!deviceKeySupported()) return null;
  try {
    const { nonce } = await challenge(handle);
    const signature = await signChallenge(nonce);
    if (!signature) return null;
    return await loginDevice(handle, nonce, signature);
  } catch {
    return null;
  }
}
