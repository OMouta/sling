//! `sling-runner pair`: trades a one-time code for a Runner identity.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::{Config, Paths};
use crate::connection::VERSION;
use crate::identity::Identity;
use crate::sys::{hostname, os};

/// An HTTP client for the control plane. It trusts the same roots as the
/// WebSocket: the system's, so a private CA the OS trusts works for all
/// three. Mozilla's roots are the fallback only when the system has none.
pub(crate) fn http_agent(timeout: std::time::Duration) -> ureq::Agent {
    use std::sync::OnceLock;
    use ureq::tls::{Certificate, RootCerts, TlsConfig};
    static ROOTS: OnceLock<RootCerts> = OnceLock::new();
    let roots = ROOTS.get_or_init(|| {
        let found = rustls_native_certs::load_native_certs();
        for e in &found.errors {
            tracing::debug!("skipped a system certificate: {e}");
        }
        if found.certs.is_empty() {
            return RootCerts::WebPki;
        }
        found
            .certs
            .iter()
            .map(|c| Certificate::from_der(c.as_ref()).to_owned())
            .collect::<Vec<_>>()
            .into()
    });
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .tls_config(TlsConfig::builder().root_certs(roots.clone()).build())
        .build()
        .new_agent()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    code: &'a str,
    public_key: String,
    name: &'a str,
    os: &'a str,
    arch: &'a str,
    hostname: String,
    version: &'a str,
    max_mode: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    runner_id: String,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: Option<String>,
    message: Option<String>,
}

pub fn pair(paths: &Paths, url: &str, code: &str, name: Option<String>) -> Result<String> {
    let url = url.trim_end_matches('/');
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("the URL must start with http:// or https://");
    }
    let mut cfg = Config::load(paths)?;
    if let Some(name) = name {
        cfg.name = name;
    }
    // A fresh identity per pairing. It's only saved once the server accepts it.
    let identity = Identity::generate()?;
    let agent = http_agent(std::time::Duration::from_secs(30));
    let mut res = agent
        .post(&format!("{url}/api/runner/pair"))
        .send_json(PairRequest {
            code,
            public_key: identity.public_key_b64(),
            name: &cfg.name,
            os: os(),
            arch: std::env::consts::ARCH,
            hostname: hostname(),
            version: VERSION,
            max_mode: cfg.max_mode.as_str(),
        })
        .with_context(|| format!("could not reach {url}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let detail = res
            .body_mut()
            .read_json::<ErrorResponse>()
            .ok()
            .and_then(|e| e.error.or(e.message))
            .unwrap_or_default();
        bail!("pairing failed ({status}): {detail}");
    }
    let body: PairResponse = res.body_mut().read_json()?;
    identity.save(paths)?;
    cfg.server_url = Some(url.to_string());
    cfg.runner_id = Some(body.runner_id.clone());
    cfg.save(paths)?;
    Ok(body.runner_id)
}
