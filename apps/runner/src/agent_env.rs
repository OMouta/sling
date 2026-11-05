//! The environment agent processes run with. Sling's own settings and the
//! Runner's git and GitHub tokens stay out of it, so an agent can't use them
//! or leak them.

/// Removed from every agent's environment, along with every `SLING_*`
/// variable (which covers `SLING_GIT_TOKEN`).
pub const REMOVED: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN"];

/// `vars` without the removed names, plus `also_remove`.
pub fn scrubbed<I>(vars: I, also_remove: &[String]) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    vars.into_iter()
        .filter(|(name, _)| !is_removed(name, also_remove))
        .collect()
}

fn is_removed(name: &str, also_remove: &[String]) -> bool {
    name.starts_with("SLING_") || REMOVED.contains(&name) || also_remove.iter().any(|a| a == name)
}

/// The Runner's own environment, scrubbed for an agent. Variables whose name
/// or value isn't valid UTF-8 are left out.
pub fn for_agent(also_remove: &[String]) -> Vec<(String, String)> {
    scrubbed(
        std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
        also_remove,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(names: &[&str]) -> Vec<(String, String)> {
        names
            .iter()
            .map(|n| (n.to_string(), format!("value-of-{n}")))
            .collect()
    }

    fn names(v: &[(String, String)]) -> Vec<&str> {
        v.iter().map(|(k, _)| k.as_str()).collect()
    }

    #[test]
    fn removes_sling_variables_and_tokens() {
        let env = vars(&[
            "PATH",
            "HOME",
            "SLING_URL",
            "SLING_PAIR_CODE",
            "SLING_GIT_TOKEN",
            "SLING_RUNNER_HOME",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "MY_SLING_THING",
        ]);
        let out = scrubbed(env, &[]);
        assert_eq!(
            names(&out),
            [
                "PATH",
                "HOME",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "MY_SLING_THING"
            ]
        );
        assert_eq!(out[0].1, "value-of-PATH", "values are kept");
    }

    #[test]
    fn removes_extra_names() {
        let env = vars(&["PATH", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
        let out = scrubbed(env, &["OPENAI_API_KEY".to_string()]);
        assert_eq!(names(&out), ["PATH", "ANTHROPIC_API_KEY"]);
    }

    #[test]
    fn names_are_matched_exactly() {
        let env = vars(&["sling_lowercase", "GH_TOKEN_EXTRA", "XGITHUB_TOKEN"]);
        assert_eq!(scrubbed(env, &[]).len(), 3);
    }
}
