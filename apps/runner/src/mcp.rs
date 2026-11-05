//! `sling-runner mcp`: a small MCP server on stdin and stdout that gives a
//! chat turn's agent Sling's tools, and nothing else. The agent's CLI starts
//! it with `SLING_TOOLS_URL` and `SLING_TOOLS_TOKEN` set. It lists the tools
//! with `GET {url}` and calls one with `POST {url}/{name}`, sending the token
//! as a bearer token. Messages are JSON-RPC 2.0, one per line.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::connection::VERSION;

pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const URL_ENV: &str = "SLING_TOOLS_URL";
pub const TOKEN_ENV: &str = "SLING_TOOLS_TOKEN";
const TIMEOUT: Duration = Duration::from_secs(60);
/// Longest server message passed on to the agent.
const MAX_MESSAGE: usize = 4000;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

/// Entry point of the subcommand. Nothing but protocol messages may go to
/// stdout, so problems go to stderr, which the agent's CLI keeps in its log.
pub fn main() -> i32 {
    let tools = Arc::new(Tools::from_env());
    serve(tools, std::io::stdin().lock(), std::io::stdout());
    0
}

/// Sling's tools API for one chat turn.
pub struct Tools {
    url: String,
    token: String,
    http: ureq::Agent,
}

impl Tools {
    pub fn from_env() -> Tools {
        Tools::new(
            &std::env::var(URL_ENV).unwrap_or_default(),
            &std::env::var(TOKEN_ENV).unwrap_or_default(),
        )
    }

    pub fn new(url: &str, token: &str) -> Tools {
        Tools {
            url: url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            http: ureq::Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(TIMEOUT))
                .build()
                .new_agent(),
        }
    }

    fn bearer(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// `tools/list`: the tools Sling offers this turn.
    pub fn list(&self) -> Result<Value, String> {
        if self.url.is_empty() {
            return Err(format!("{URL_ENV} is not set"));
        }
        let mut res = self
            .http
            .get(&self.url)
            .header("Authorization", self.bearer())
            .header("Accept", "application/json")
            .call()
            .map_err(|e| format!("Could not reach Sling: {e}"))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(server_message(status, &body));
        }
        let parsed: Value = serde_json::from_str(&body)
            .map_err(|_| "Sling sent a tool list that isn't JSON.".to_string())?;
        let tools = parsed["tools"]
            .as_array()
            .ok_or_else(|| "Sling sent a tool list without tools.".to_string())?
            .iter()
            .filter_map(|t| {
                let name = t["name"].as_str()?;
                let mut tool = json!({
                    "name": name,
                    "description": t["description"].as_str().unwrap_or_default(),
                    "inputSchema": if t["inputSchema"].is_object() {
                        t["inputSchema"].clone()
                    } else {
                        json!({ "type": "object" })
                    },
                });
                if t["annotations"].is_object() {
                    tool["annotations"] = t["annotations"].clone();
                }
                Some(tool)
            })
            .collect::<Vec<_>>();
        Ok(json!({ "tools": tools }))
    }

    /// `tools/call`. Failures become tool errors the agent can read.
    pub fn call(&self, name: &str, arguments: &Value) -> Value {
        if self.url.is_empty() {
            return tool_result(&format!("{URL_ENV} is not set"), true);
        }
        let res = self
            .http
            .post(&format!("{}/{name}", self.url))
            .header("Authorization", self.bearer())
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .send(json!({ "arguments": arguments }).to_string());
        let mut res = match res {
            Ok(r) => r,
            Err(e) => return tool_result(&format!("Could not reach Sling: {e}"), true),
        };
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().unwrap_or_default();
        if !(200..300).contains(&status) {
            return tool_result(&server_message(status, &body), true);
        }
        match serde_json::from_str::<Value>(&body) {
            Ok(v) => tool_result(
                v["content"].as_str().unwrap_or_default(),
                v["isError"].as_bool().unwrap_or(false),
            ),
            Err(_) => tool_result("Sling sent a tool result that isn't JSON.", true),
        }
    }
}

fn tool_result(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// The message in an error reply: its `error` or `message` field, or its
/// text, or failing that the status.
fn server_message(status: u16, body: &str) -> String {
    let from_json = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        ["error", "message"]
            .iter()
            .find_map(|k| v[*k].as_str().map(str::to_string))
            .or_else(|| v["error"]["message"].as_str().map(str::to_string))
    });
    let text = from_json.unwrap_or_else(|| body.trim().to_string());
    if text.trim().is_empty() {
        return format!("Sling answered with HTTP {status}.");
    }
    let mut end = text.len().min(MAX_MESSAGE);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// Tool names end up in the URL path.
fn valid_tool_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Answers one message. `None` for notifications and for replies from the
/// client, which this server never asks for.
pub fn handle(tools: &Tools, msg: &Value) -> Option<Value> {
    if !msg.is_object() {
        return Some(error(&Value::Null, INVALID_REQUEST, "Invalid request"));
    }
    let method = msg["method"].as_str()?;
    let id = msg.get("id").filter(|id| !id.is_null())?;
    let params = &msg["params"];
    Some(match method {
        "initialize" => reply(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "sling", "title": "Sling", "version": VERSION },
            }),
        ),
        "ping" => reply(id, json!({})),
        "tools/list" => match tools.list() {
            Ok(list) => reply(id, list),
            Err(e) => error(id, INTERNAL_ERROR, &e),
        },
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return Some(error(id, INVALID_PARAMS, "tools/call needs a tool name"));
            };
            if !valid_tool_name(name) {
                return Some(error(id, INVALID_PARAMS, &format!("Unknown tool: {name}")));
            }
            let arguments = match &params["arguments"] {
                Value::Null => json!({}),
                a @ Value::Object(_) => a.clone(),
                _ => {
                    return Some(error(
                        id,
                        INVALID_PARAMS,
                        "Tool arguments must be an object",
                    ));
                }
            };
            reply(id, tools.call(name, &arguments))
        }
        _ => error(id, METHOD_NOT_FOUND, &format!("Method not found: {method}")),
    })
}

/// Reads messages until `input` closes, answering each request on its own
/// thread so a slow tool call doesn't hold up the rest, then waits for the
/// answers still being worked on.
pub fn serve<R, W>(tools: Arc<Tools>, input: R, output: W)
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let output = Arc::new(Mutex::new(output));
    let send = |out: &Mutex<W>, v: &Value| {
        let mut out = out.lock().unwrap();
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    };
    let mut workers = Vec::new();
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                send(&output, &error(&Value::Null, PARSE_ERROR, "Parse error"));
                continue;
            }
        };
        let tools = tools.clone();
        let output = output.clone();
        workers.push(std::thread::spawn(move || {
            if let Some(answer) = handle(&tools, &msg) {
                send(&output, &answer);
            }
        }));
        workers.retain(|w| !w.is_finished());
    }
    for w in workers {
        let _ = w.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::Stub;

    fn stub() -> Stub {
        Stub::start(|req| match (req.method.as_str(), req.path.as_str()) {
            _ if req.auth.as_deref() != Some("Bearer tok-123") => (
                401,
                r#"{"error":"This chat turn's token has expired."}"#.into(),
            ),
            ("GET", "/tools") => (
                200,
                json!({"tools": [
                    {"name": "list_machines", "description": "Lists machines.",
                     "inputSchema": {"type": "object", "properties": {}}},
                    {"name": "start_task", "description": "Starts a task.",
                     "inputSchema": {"type": "object", "properties": {"repo": {"type": "string"}}},
                     "annotations": {"readOnlyHint": false}, "internal": "dropped"},
                    {"description": "no name, so it's left out"}
                ]})
                .to_string(),
            ),
            ("POST", "/tools/list_machines") => (
                200,
                json!({"content": format!("2 machines. You sent {}", req.body), "isError": false})
                    .to_string(),
            ),
            ("POST", "/tools/start_task") => (
                200,
                json!({"content": "No repo named nope.", "isError": true}).to_string(),
            ),
            ("POST", "/tools/cancel_task") => (500, "database is down".into()),
            _ => (404, r#"{"message":"No such tool."}"#.into()),
        })
    }

    fn text(result: &Value) -> &str {
        result["content"][0]["text"].as_str().unwrap()
    }

    #[test]
    fn lists_the_tools_sling_offers() {
        let s = stub();
        let tools = Tools::new(&format!("{}/tools/", s.url), "tok-123");
        let list = tools.list().unwrap();
        let names: Vec<&str> = list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["list_machines", "start_task"]);
        assert_eq!(list["tools"][1]["annotations"]["readOnlyHint"], false);
        assert!(list["tools"][1].get("internal").is_none());
        assert_eq!(
            list["tools"][0]["inputSchema"],
            json!({"type": "object", "properties": {}})
        );
        let req = &s.requests()[0];
        assert_eq!((req.method.as_str(), req.path.as_str()), ("GET", "/tools"));
        assert_eq!(req.auth.as_deref(), Some("Bearer tok-123"));
    }

    #[test]
    fn calls_a_tool_with_its_arguments() {
        let s = stub();
        let tools = Tools::new(&format!("{}/tools", s.url), "tok-123");
        let r = tools.call("list_machines", &json!({"online": true}));
        assert_eq!(r["isError"], false);
        assert_eq!(
            text(&r),
            r#"2 machines. You sent {"arguments":{"online":true}}"#
        );
        assert_eq!(r["content"][0]["type"], "text");

        let r = tools.call("start_task", &json!({}));
        assert_eq!(r["isError"], true, "Sling's own tool errors pass through");
        assert_eq!(text(&r), "No repo named nope.");
    }

    #[test]
    fn http_errors_become_tool_errors_with_the_servers_message() {
        let s = stub();
        let tools = Tools::new(&format!("{}/tools", s.url), "tok-123");
        let r = tools.call("cancel_task", &json!({}));
        assert_eq!(r["isError"], true);
        assert_eq!(text(&r), "database is down");
        let r = tools.call("nope", &json!({}));
        assert_eq!(text(&r), "No such tool.");

        let expired = Tools::new(&format!("{}/tools", s.url), "old");
        let r = expired.call("list_machines", &json!({}));
        assert_eq!(text(&r), "This chat turn's token has expired.");
        assert_eq!(
            expired.list().unwrap_err(),
            "This chat turn's token has expired."
        );

        let gone = Tools::new("http://127.0.0.1:9/tools", "tok-123");
        let r = gone.call("list_machines", &json!({}));
        assert_eq!(r["isError"], true);
        assert!(text(&r).starts_with("Could not reach Sling"), "{r}");
        assert_eq!(server_message(502, ""), "Sling answered with HTTP 502.");
    }

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Runs `lines` through the server and returns its answers by id.
    fn session(url: &str, lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect::<String>() + "{oops\n";
        let out = Shared::default();
        serve(
            Arc::new(Tools::new(url, "tok-123")),
            std::io::Cursor::new(input),
            out.clone(),
        );
        let text = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let mut answers: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        answers.sort_by_key(|a| a["id"].as_i64().unwrap_or(-1));
        answers
    }

    #[test]
    fn speaks_json_rpc_over_lines() {
        let s = stub();
        let answers = session(
            &format!("{}/tools", s.url),
            &[
                json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                    "protocolVersion": "2099-01-01", "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"}}}),
                json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
                json!({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}}),
                json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                       "params": {"name": "list_machines"}}),
                json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                       "params": {"name": "../admin", "arguments": {}}}),
                json!({"jsonrpc": "2.0", "id": 6, "method": "resources/list"}),
                json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                       "params": {"name": "list_machines", "arguments": [1]}}),
            ],
        );
        let ids: Vec<Value> = answers.iter().map(|a| a["id"].clone()).collect();
        assert_eq!(
            ids,
            [
                Value::Null,
                json!(1),
                json!(2),
                json!(3),
                json!(4),
                json!(5),
                json!(6),
                json!(7)
            ],
            "one answer per request, none for the notification"
        );
        assert_eq!(answers[0]["error"]["code"], PARSE_ERROR);
        let init = &answers[1]["result"];
        assert_eq!(init["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(init["serverInfo"]["name"], "sling");
        assert!(init["capabilities"]["tools"].is_object());
        assert_eq!(answers[2]["result"], json!({}));
        assert_eq!(answers[3]["result"]["tools"].as_array().unwrap().len(), 2);
        assert_eq!(
            text(&answers[4]["result"]),
            r#"2 machines. You sent {"arguments":{}}"#
        );
        assert_eq!(answers[5]["error"]["code"], INVALID_PARAMS);
        assert_eq!(answers[6]["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(answers[7]["error"]["code"], INVALID_PARAMS);
        assert!(
            s.requests().iter().all(|r| !r.path.contains("admin")),
            "bad names never reach Sling"
        );
    }

    #[test]
    fn a_failed_listing_is_a_json_rpc_error() {
        let answers = session(
            "http://127.0.0.1:9/tools",
            &[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})],
        );
        assert_eq!(answers[1]["error"]["code"], INTERNAL_ERROR);
        assert!(
            answers[1]["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("Could not reach Sling")
        );
        let unset = Tools::new("", "");
        assert_eq!(unset.list().unwrap_err(), "SLING_TOOLS_URL is not set");
    }
}
