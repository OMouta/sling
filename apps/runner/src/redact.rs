//! Scrubs secrets from task output before it's written to the spool and sent
//! to the control plane (stage1.md M7). Two sources: values of this process's
//! secret-looking environment variables, and well-known token shapes.

use std::sync::OnceLock;

const SECRET_NAME_HINTS: &[&str] = &[
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "API_KEY",
    "APIKEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
];
const TOKEN_PREFIXES: &[&str] = &[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "sk-",
    "sk_live_",
    "rk_live_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "AKIA",
    "ASIA",
    "npm_",
];
const MASK: &str = "[redacted]";

fn env_secrets() -> &'static [String] {
    static VALUES: OnceLock<Vec<String>> = OnceLock::new();
    VALUES.get_or_init(|| {
        let mut v: Vec<String> = std::env::vars()
            .filter(|(k, val)| {
                let k = k.to_uppercase();
                val.len() >= 8 && SECRET_NAME_HINTS.iter().any(|h| k.contains(h))
            })
            .map(|(_, val)| val)
            .collect();
        v.sort_by_key(|s| std::cmp::Reverse(s.len()));
        v
    })
}

/// Returns `text` with secrets masked.
pub fn redact(text: &str) -> String {
    redact_with(text, env_secrets())
}

pub fn redact_with(text: &str, known: &[String]) -> String {
    let mut out = text.to_string();
    for secret in known {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), MASK);
        }
    }
    mask_token_shapes(&out)
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-')
}

/// Masks words that start with a known token prefix and are long enough to be
/// a real token.
fn mask_token_shapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        let start = rest
            .char_indices()
            .find(|(i, _)| {
                let tail = &rest[*i..];
                let at_word_start =
                    *i == 0 || !rest[..*i].chars().last().is_some_and(is_token_char);
                at_word_start && TOKEN_PREFIXES.iter().any(|p| tail.starts_with(p))
            })
            .map(|(i, _)| i);
        let Some(start) = start else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let len = tail.find(|c: char| !is_token_char(c)).unwrap_or(tail.len());
        if len >= 16 {
            out.push_str(MASK);
        } else {
            out.push_str(&tail[..len]);
        }
        rest = &tail[len..];
    }
    out
}

/// Scrubs the free-text fields of a task event.
pub fn redact_kind(
    kind: sling_runner_protocol::task_event::Kind,
) -> sling_runner_protocol::task_event::Kind {
    use sling_runner_protocol::task_event::Kind;
    match kind {
        Kind::AgentMessage(mut m) => {
            m.text = redact(&m.text);
            Kind::AgentMessage(m)
        }
        Kind::Command(mut c) => {
            c.command = redact(&c.command);
            c.output = redact(&c.output);
            Kind::Command(c)
        }
        Kind::Log(mut l) => {
            l.text = redact(&l.text);
            Kind::Log(l)
        }
        Kind::Finished(mut f) => {
            f.summary = redact(&f.summary);
            f.error = redact(&f.error);
            Kind::Finished(f)
        }
        Kind::ActionResult(mut a) => {
            a.message = redact(&a.message);
            Kind::ActionResult(a)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_known_values() {
        let known = vec!["hunter2hunter2".to_string()];
        assert_eq!(
            redact_with("pw=hunter2hunter2 ok", &known),
            "pw=[redacted] ok"
        );
    }

    #[test]
    fn masks_token_shapes() {
        let t = "export GH=ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-short";
        let r = redact_with(t, &[]);
        assert!(!r.contains("ghp_abcdef"));
        assert!(r.contains("[redacted]"));
        assert!(r.contains("sk-short"), "short words are left alone: {r}");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let t = "task-runner skipped 3 files; AKIA is a prefix";
        assert_eq!(redact_with(t, &[]), t);
    }
}
