//! The identity token contract.
//!
//! AttackFM's accounts live in one central directory (the registry). A music
//! server does not hold passwords or a users table any more; it trusts a small
//! signed token the registry issued and a listener presents. This crate is the
//! whole of that trust: the shape of the token, how the registry signs one, and
//! how a server checks one.
//!
//! The design goal is that verification is **offline**. The registry signs with
//! an Ed25519 private key; every server holds only the matching public key and
//! checks the signature itself. So a token is validated with no call back to the
//! registry - a server keeps letting its members in even while the directory is
//! unreachable, which is the difference between "the registry is down" being a
//! signup outage and being a total blackout.
//!
//! The token is deliberately NOT a JWT. A JWT's header carries the algorithm the
//! verifier will use, which is a foot-gun (the `alg: none` family of bugs); here
//! the algorithm is fixed at compile time and there is nothing to negotiate. The
//! wire form is three dot-separated base64url fields - a version tag, the claims
//! as JSON, and the signature over the first two - which reads at a glance and
//! carries no attacker-chosen knobs.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The token version, so the format can change without a server mistaking an old
/// token for a new one. Bumped only on a breaking shape change.
const TOKEN_V: &str = "afm1";

/// What a verified token asserts: who the bearer is, and for how long.
///
/// Kept minimal on purpose - identity only. What a given account may DO on a
/// given server (owner, member, banned) is the server's own business, read from
/// its memberships table keyed by `sub`, never carried in the token. That keeps
/// the token stable when a role changes and means a server is the sole authority
/// on its own permissions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Claims {
    /// The account id in the registry. Stable for the life of the account, and
    /// the key a server stores memberships against.
    pub sub: i64,
    /// The handle at issue time, for display without a round-trip. A server must
    /// treat `sub` - not this - as identity: handles can be changed, ids cannot.
    pub handle: String,
    /// Issued-at, unix seconds.
    pub iat: i64,
    /// Expiry, unix seconds. A short life is fine because the app refreshes
    /// against the registry; a stolen token is only useful until it lapses.
    pub exp: i64,
}

/// Why a token was refused. Distinguished so a caller can tell "sign in again"
/// (expired) from "this is not one of ours" (bad signature / malformed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// The wire form was not `v.claims.sig`, or a field would not decode.
    Malformed,
    /// A field decoded but the version tag is not one this build speaks.
    Version,
    /// The signature did not match the public key. Not one of ours, or tampered.
    BadSignature,
    /// The signature was good but the token has lapsed.
    Expired,
}

/// The registry's signing half. Held ONLY by the registry; never shipped to a
/// server or a client.
pub struct Issuer {
    key: SigningKey,
}

impl Issuer {
    /// A fresh signing key. Called once, when a registry is first set up; the
    /// bytes are then persisted (see `secret_b64`) and reloaded on every boot.
    pub fn generate() -> Self {
        let mut rng = rand::rngs::OsRng;
        Self { key: SigningKey::generate(&mut rng) }
    }

    /// Reload from the 32 secret bytes produced by `secret_b64`.
    pub fn from_secret_b64(s: &str) -> Option<Self> {
        let bytes = URL_SAFE_NO_PAD.decode(s.trim()).ok()?;
        let arr: [u8; 32] = bytes.try_into().ok()?;
        Some(Self { key: SigningKey::from_bytes(&arr) })
    }

    /// The secret, base64url, for storing in the registry's config. This is the
    /// crown jewel: anyone holding it can mint a token for any account.
    pub fn secret_b64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.to_bytes())
    }

    /// The public half, base64url, to hand to every server. Safe to publish -
    /// it verifies tokens but cannot mint them.
    pub fn public_b64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes())
    }

    /// The verifier for this issuer, for tests and for a registry that also
    /// wants to check its own tokens.
    pub fn verifier(&self) -> Verifier2 {
        Verifier2 { key: self.key.verifying_key() }
    }

    /// Sign a set of claims into a wire token.
    pub fn issue(&self, claims: &Claims) -> String {
        let body = format!(
            "{TOKEN_V}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("claims serialize"))
        );
        let sig = self.key.sign(body.as_bytes());
        format!("{body}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }
}

/// A server's verifying half: the registry's public key, and nothing else. Named
/// with the `2` so it does not collide with dalek's `Verifier` trait in callers.
#[derive(Clone)]
pub struct Verifier2 {
    key: VerifyingKey,
}

impl Verifier2 {
    /// Build from the base64url public key a registry published (`public_b64`).
    pub fn from_public_b64(s: &str) -> Option<Self> {
        let bytes = URL_SAFE_NO_PAD.decode(s.trim()).ok()?;
        let arr: [u8; 32] = bytes.try_into().ok()?;
        VerifyingKey::from_bytes(&arr).ok().map(|key| Self { key })
    }

    /// Check a token against a wall-clock `now` (unix seconds) and return its
    /// claims. The signature is checked before the clock, so a lapsed-but-valid
    /// token is distinguishable from a forgery.
    pub fn verify(&self, token: &str, now: i64) -> Result<Claims, VerifyError> {
        let mut it = token.splitn(3, '.');
        let ver = it.next().ok_or(VerifyError::Malformed)?;
        let claims_b64 = it.next().ok_or(VerifyError::Malformed)?;
        let sig_b64 = it.next().ok_or(VerifyError::Malformed)?;
        if it.next().is_some() {
            return Err(VerifyError::Malformed);
        }
        if ver != TOKEN_V {
            return Err(VerifyError::Version);
        }

        let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(sig_b64)
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or(VerifyError::Malformed)?;
        let signature = Signature::from_bytes(&sig_bytes);
        let body = format!("{ver}.{claims_b64}");
        self.key
            .verify(body.as_bytes(), &signature)
            .map_err(|_| VerifyError::BadSignature)?;

        let claims: Claims = URL_SAFE_NO_PAD
            .decode(claims_b64)
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .ok_or(VerifyError::Malformed)?;
        if now >= claims.exp {
            return Err(VerifyError::Expired);
        }
        Ok(claims)
    }
}

/// Verify a detached Ed25519 signature: `message` was signed by the private key
/// matching `public_b64`, and `sig_b64` is the result.
///
/// This is the primitive behind passwordless login. A device holds its own key
/// and registers the public half; to log in it signs a one-time challenge the
/// registry hands out, and the registry checks it here. Same curve as the token,
/// but a wholly separate key per device - the registry never sees a device's
/// private key, only that it can produce signatures the public half accepts.
pub fn verify_detached(public_b64: &str, message: &[u8], sig_b64: &str) -> bool {
    let Some(pk_bytes) = URL_SAFE_NO_PAD
        .decode(public_b64.trim())
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
    else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&pk_bytes) else {
        return false;
    };
    let Some(sig_bytes) = URL_SAFE_NO_PAD
        .decode(sig_b64.trim())
        .ok()
        .and_then(|v| <[u8; 64]>::try_from(v).ok())
    else {
        return false;
    };
    key.verify(message, &Signature::from_bytes(&sig_bytes)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(now: i64, ttl: i64) -> Claims {
        Claims { sub: 42, handle: "matt".into(), iat: now, exp: now + ttl }
    }

    #[test]
    fn round_trips() {
        let iss = Issuer::generate();
        let ver = Verifier2::from_public_b64(&iss.public_b64()).unwrap();
        let c = claims(1_000, 3_600);
        let token = iss.issue(&c);
        assert_eq!(ver.verify(&token, 1_000).unwrap(), c);
    }

    #[test]
    fn secret_reload_issues_the_same_key() {
        let iss = Issuer::generate();
        let reloaded = Issuer::from_secret_b64(&iss.secret_b64()).unwrap();
        assert_eq!(iss.public_b64(), reloaded.public_b64());
    }

    #[test]
    fn rejects_expiry() {
        let iss = Issuer::generate();
        let ver = iss.verifier();
        let token = iss.issue(&claims(1_000, 60));
        assert_eq!(ver.verify(&token, 1_061), Err(VerifyError::Expired));
    }

    #[test]
    fn rejects_a_foreign_key() {
        let a = Issuer::generate();
        let b = Issuer::generate();
        let token = a.issue(&claims(1_000, 60));
        assert_eq!(b.verifier().verify(&token, 1_000), Err(VerifyError::BadSignature));
    }

    #[test]
    fn rejects_tampering() {
        let iss = Issuer::generate();
        let token = iss.issue(&claims(1_000, 60));
        // Flip the last body char before the signature.
        let mut parts: Vec<&str> = token.splitn(3, '.').collect();
        let mutated = parts[1].to_string() + "x";
        parts[1] = &mutated;
        let bad = parts.join(".");
        assert_eq!(iss.verifier().verify(&bad, 1_000), Err(VerifyError::BadSignature));
    }
}
