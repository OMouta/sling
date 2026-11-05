# Workflow templates

Each directory holds one bundled template:

- `template.json`: `key`, `name`, `description`, `builtIn`, and `bindings`. A binding names a placeholder such as `"$discord"` and the connector it stands for. Installing the template asks you to pick an installation for each one and swaps it into node config.
- `workflow.json`: a `sling.workflow/v1` definition, the same format the editor exports.

Installed templates are ordinary workflows. Edit them, publish new versions, or export them like any other.
