//! A tiny HTTP/1.1 server for tests, standing in for Sling's tools API. It
//! records every request and answers with whatever the handler returns.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub auth: Option<String>,
    pub body: String,
}

type Handler = dyn Fn(&Request) -> (u16, String) + Send + Sync;

pub struct Stub {
    /// `http://127.0.0.1:<port>`, without a trailing slash.
    pub url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Stub {
    pub fn start(handler: impl Fn(&Request) -> (u16, String) + Send + Sync + 'static) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let handler = handler.clone();
                let seen = seen.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let Some(req) = read_request(&mut reader) else {
                        return;
                    };
                    seen.lock().unwrap().push(req.clone());
                    let (status, body) = handler(&req);
                    let mut stream = stream;
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                });
            }
        });
        Stub { url, requests }
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

fn read_request(reader: &mut impl BufRead) -> Option<Request> {
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut auth = None;
    let mut length = 0;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            match name.to_ascii_lowercase().as_str() {
                "authorization" => auth = Some(value.trim().to_string()),
                "content-length" => length = value.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        auth,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}
