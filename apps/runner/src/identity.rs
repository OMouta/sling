//! The Runner's Ed25519 identity (D16). The private key never leaves the
//! machine; the server only ever sees the public key and signatures.

use anyhow::{Context, Result, bail};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};

use crate::config::{Paths, write_private};

pub struct Identity {
    key: SigningKey,
}

impl Identity {
    pub fn generate() -> Result<Identity> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
        Ok(Identity {
            key: SigningKey::from_bytes(&seed),
        })
    }

    pub fn load(paths: &Paths) -> Result<Identity> {
        let file = paths.key_file();
        let bytes = std::fs::read(&file)
            .with_context(|| format!("reading {}. Pair this Runner first.", file.display()))?;
        let seed: [u8; 32] = match bytes.try_into() {
            Ok(s) => s,
            Err(_) => bail!("{} is not a valid key file", file.display()),
        };
        Ok(Identity {
            key: SigningKey::from_bytes(&seed),
        })
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        write_private(&paths.key_file(), &self.key.to_bytes())
    }

    pub fn public_key_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.key.verifying_key().to_bytes())
    }

    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.key.sign(message).to_bytes().to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};

    #[test]
    fn signatures_verify_with_the_public_key() {
        let id = Identity::generate().unwrap();
        let sig = id.sign(b"hello");
        let sig = Signature::from_slice(&sig).unwrap();
        assert!(id.key.verifying_key().verify(b"hello", &sig).is_ok());
        assert!(id.key.verifying_key().verify(b"other", &sig).is_err());
    }
}
