//! Experimental "Sign in with ChatGPT" (OpenAI OAuth) for the desktop app.
//!
//! Pure-std loopback capture of the OAuth redirect (no extra crates). PKCE is
//! computed in the webview (WebCrypto) and the token exchange is proxied by the
//! server (avoids browser CORS on the token endpoint). Tokens are stored in the
//! OS keyring via the existing `secrets_*` commands.
//!
//! OFF-LABEL / EXPERIMENTAL and behind explicit user consent: reusing a consumer
//! ChatGPT subscription for programmatic use is not officially supported and may
//! stop working. Google consumer-Gemini OAuth was retired (2026) — BYO API key
//! only for Google. See the plan file's Phase 6 feasibility notes.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct OauthState {
    pending: Mutex<Option<Receiver<Result<Captured, String>>>>,
}

#[derive(serde::Serialize, Clone)]
pub struct Captured {
    code: String,
    state: String,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query(target: &str) -> (Option<String>, Option<String>) {
    let q = target.split('?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        match k {
            "code" => code = Some(percent_decode(v)),
            "state" => state = Some(percent_decode(v)),
            _ => {}
        }
    }
    (code, state)
}

/// Bind an ephemeral loopback port and start listening for the OAuth redirect.
/// Returns the port so the frontend can build redirect_uri = http://localhost:PORT/callback.
#[tauri::command]
pub fn oauth_start(state: tauri::State<OauthState>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = channel::<Result<Captured, String>>();

    std::thread::spawn(move || {
        match listener.accept() {
            Ok((stream, _)) => {
                let read_stream = match stream.try_clone() {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let mut reader = BufReader::new(read_stream);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
                let (code, st) = parse_query(&target);

                let body = "<html><body style=\"font-family:sans-serif;background:#0a0a0a;color:#e5e5e5;padding:3rem;text-align:center\"><h2>Signed in.</h2><p>You can close this tab and return to InsightLibrary.</p></body></html>";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let mut w = stream;
                let _ = w.write_all(resp.as_bytes());
                let _ = w.flush();

                match (code, st) {
                    (Some(code), Some(state)) => {
                        let _ = tx.send(Ok(Captured { code, state }));
                    }
                    _ => {
                        let _ = tx.send(Err("missing code/state in redirect".into()));
                    }
                }
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        }
    });

    *state.pending.lock().map_err(|e| e.to_string())? = Some(rx);
    Ok(port)
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open the authorize URL in the system browser and block until the loopback
/// captures the redirect (or times out).
#[tauri::command]
pub fn oauth_complete(state: tauri::State<OauthState>, authorize_url: String) -> Result<Captured, String> {
    open_in_browser(&authorize_url)?;
    let rx = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "no pending OAuth flow (call oauth_start first)".to_string())?;
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(res) => res,
        Err(_) => Err("timed out waiting for the OAuth redirect".into()),
    }
}
