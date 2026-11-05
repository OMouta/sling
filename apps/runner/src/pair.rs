//! `sling-runner pair`: trades a one-time code for a Runner identity.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::config::{Config, Paths};
use crate::connection::VERSION;
use crate::identity::Identity;
use crate::sys::{hostname, os};

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
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .build()
        .new_agent();
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
