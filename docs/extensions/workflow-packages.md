# Workflow packages

A workflow package is an extension that holds workflow templates and no code. It has no `main`, so Sling never starts a process for it, and it can't ask for permissions. Installing one adds its templates to **New from template**.

The [Task alerts](../../extensions/task-alerts) package that ships with Sling is one: a single template, **Notify when a task finishes**, that sends an ntfy notification when a coding task finishes.

## Layout

```text
sling-extension.json
README.md
icon.svg
templates/
  notify-task-finished/
    template.json
    workflow.json
```

The manifest lists each template's key and what the templates need:

```json
{
  "format": "sling.extension/v1",
  "id": "task-alerts",
  "name": "Task alerts",
  "version": "1.0.0",
  "description": "A push notification on your phone when a coding task finishes, through ntfy.",
  "publisher": "Sling",
  "sdk": "^1.0.0",
  "templates": ["notify-task-finished"],
  "requires": { "extensions": { "ntfy": "^1.0.0" }, "connectors": [] }
}
```

Start one with `sling-ext init my-workflows --kind workflows`.

## Templates

Each template is a folder under `templates/` named after its key, with two files. They're the same format as the templates in Sling's `workflows/` folder.

`workflow.json` is a `sling.workflow/v1` definition, the JSON the workflow editor exports. Build the workflow in the editor, export it, and copy it in.

`template.json` describes it:

| Field | Meaning |
|---|---|
| `key` | The folder's name. Once installed, the template's key is `<extension ID>/<key>`, such as `task-alerts/notify-task-finished` |
| `name` | Shown in the template dialog |
| `description` | Shown under the name. Say what it does and what to set up first |
| `builtIn` | Leave it `false` |
| `bindings` | One per installation the workflow needs, see below |

### Bindings

A workflow names connector installations by ID, and those IDs mean nothing on another server. A template uses a placeholder instead, such as `"$ntfy"`, as the whole value of the config field:

```json
"config": { "installationId": "$ntfy", "topic": "" }
```

and declares it:

```json
"bindings": [{ "placeholder": "$ntfy", "connectorId": "ntfy", "label": "ntfy server" }]
```

When someone installs the template, Sling asks them to pick an installation of that connector for each binding, labeled with `label`, and swaps the IDs in. The workflow lands published and turned off, so they can look it over first.

A placeholder starts with `$` and a lowercase letter, then lowercase letters, digits, and `_`.

## Requirements

`requires` says what the templates need, and Sling checks it when the package is installed:

| Field | Holds |
|---|---|
| `requires.extensions` | Extension IDs with a version range, such as `{ "ntfy": "^1.0.0" }` |
| `requires.connectors` | IDs of connectors built into Sling, such as `["discord", "email"]` |

The install dialog lists anything missing. An extension it can find in one of your enabled catalogs gets an **Install** button there. List every extension and built-in connector whose nodes or installations the templates use. `sling-ext check` warns about any you left out.

Sling's own nodes, such as **Task settled**, **If**, and **HTTP request**, need no entry.

## Checking and packing

```sh
sling-ext check
sling-ext pack --sign ~/.sling/signing-key.json
```

`check` reads each template the way Sling does. It refuses JSON that doesn't parse, a `workflow.json` that isn't a valid definition, a `template.json` whose key doesn't match its folder, and permissions on a package without code. It warns about bindings that `workflow.json` doesn't use, placeholders that no binding declares, and nodes from extensions or built-in connectors missing from `requires`.

The Task alerts package also has a test that validates its workflow against the server's real node registry plus the ntfy connector, and evaluates the notification it would send for a finished and a failed task. See `extensions/task-alerts/test/template.test.ts`.

## Export as package

Any workflow can become a package from the workflow editor's menu, with **Export as package**:

- It uses the published version, or the draft if nothing is published yet.
- Every config value that's an installation ID becomes a binding: `$discord`, `$discord_2`, and so on, each labeled with the connector's name.
- Credentials can't be included, since workflows hold only installation IDs.
- `requires` lists the extensions and built-in connectors the workflow's nodes come from.
- The dialog asks for the package's ID and version, and suggests both from the workflow's name.

The download is unsigned. Sign it before you share it:

```sh
sling-ext sign my-workflow-1.0.0.slx --key ~/.sling/signing-key.json
```

A server running with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1` installs it unsigned, which is handy for moving a workflow between your own servers.
