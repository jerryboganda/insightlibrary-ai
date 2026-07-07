//! insight-authtest — end-to-end acceptance test for the Phase 7 identity +
//! settings surface against a LIVE insight-api. Prints one `PASS <name>` /
//! `FAIL <name>` line per step; exits non-zero on any failure.
//! Config: `API_BASE` (default `http://insight-api:8080`).
//!
//! Test-binary conventions: `unwrap`/`expect`/`?` are acceptable here.

use std::time::Duration;

use anyhow::Context;
use serde_json::{json, Value};

fn report(name: &str, result: anyhow::Result<()>, failures: &mut u32) {
    match result {
        Ok(()) => println!("PASS {name}"),
        Err(e) => {
            println!("FAIL {name}: {e:#}");
            *failures += 1;
        }
    }
}

fn rand_suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

async fn sign_up(
    http: &reqwest::Client,
    base: &str,
    email: &str,
    password: &str,
    name: &str,
) -> anyhow::Result<Value> {
    let resp = http
        .post(format!("{base}/api/auth/sign-up"))
        .json(&json!({ "email": email, "password": password, "name": name }))
        .send()
        .await?;
    anyhow::ensure!(resp.status() == 200, "sign-up status {}", resp.status());
    Ok(resp.json().await?)
}

#[tokio::main]
async fn main() {
    match run_all().await {
        Ok(0) => println!("authtest: all checks passed"),
        Ok(n) => {
            println!("authtest: {n} check(s) failed");
            std::process::exit(1);
        }
        Err(e) => {
            println!("FAIL authtest: {e:#}");
            std::process::exit(1);
        }
    }
}

async fn run_all() -> anyhow::Result<u32> {
    let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://insight-api:8080".into());
    let base = base.trim_end_matches('/').to_string();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("building http client")?;
    let mut failures = 0u32;

    // 1. Owner sign-up.
    let owner_email = format!("owner-{}@example.com", rand_suffix());
    let owner = sign_up(&http, &base, &owner_email, "owner-password-123", "Owner").await?;
    let owner_access = owner["accessToken"]
        .as_str()
        .context("no accessToken")?
        .to_string();
    let owner_org = owner["user"]["orgId"]
        .as_str()
        .context("no orgId")?
        .to_string();
    anyhow::ensure!(owner["user"]["role"] == "owner", "owner role: {owner}");
    println!("PASS owner_sign_up");

    // 2. Session probe carries sessionToken + normalized role.
    let session = async {
        let body: Value = http
            .get(format!("{base}/api/session"))
            .bearer_auth(&owner_access)
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(body["authenticated"] == true, "session: {body}");
        anyhow::ensure!(body["user"]["role"] == "owner", "role: {body}");
        anyhow::ensure!(body["sessionToken"].is_string(), "no sessionToken: {body}");
        Ok(())
    }
    .await;
    report("session_shape", session, &mut failures);

    // 3. Org settings: defaults present, then override wins and is listed.
    let org_settings = async {
        let body: Value = http
            .get(format!("{base}/api/org/settings"))
            .bearer_auth(&owner_access)
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(body["settings"]["dedupCosine"] == 0.9, "defaults: {body}");
        anyhow::ensure!(body["defaults"]["searchTopK"] == 20, "defaults: {body}");

        let put: Value = http
            .put(format!("{base}/api/org/settings"))
            .bearer_auth(&owner_access)
            .json(&json!({ "settings": { "searchTopK": 50 } }))
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(put["settings"]["searchTopK"] == 50, "put: {put}");
        anyhow::ensure!(
            put["overridden"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "searchTopK")),
            "overridden: {put}"
        );

        // Clamp: an out-of-range value is bounded on write.
        let put2: Value = http
            .put(format!("{base}/api/org/settings"))
            .bearer_auth(&owner_access)
            .json(&json!({ "settings": { "searchTopK": 9999 } }))
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(put2["settings"]["searchTopK"] == 200, "clamp: {put2}");
        Ok(())
    }
    .await;
    report(
        "org_settings_override_and_clamp",
        org_settings,
        &mut failures,
    );

    // 4. Preferences: empty, then raw round-trip.
    let prefs = async {
        let empty: Value = http
            .get(format!("{base}/api/preferences"))
            .bearer_auth(&owner_access)
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(empty["prefs"].is_object(), "prefs: {empty}");
        http.patch(format!("{base}/api/preferences"))
            .bearer_auth(&owner_access)
            .json(&json!({ "theme": "dark", "locale": "en" }))
            .send()
            .await?;
        let got: Value = http
            .get(format!("{base}/api/preferences"))
            .bearer_auth(&owner_access)
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(got["prefs"]["theme"] == "dark", "prefs round-trip: {got}");
        Ok(())
    }
    .await;
    report("preferences_roundtrip", prefs, &mut failures);

    // 5. Sessions list has a current device.
    let sessions = async {
        let body: Value = http
            .get(format!("{base}/api/auth/sessions"))
            .bearer_auth(&owner_access)
            .send()
            .await?
            .json()
            .await?;
        let items = body["items"].as_array().context("no items")?;
        anyhow::ensure!(!items.is_empty(), "no sessions");
        anyhow::ensure!(
            items.iter().any(|s| s["current"] == true),
            "no current session"
        );
        Ok(())
    }
    .await;
    report("sessions_list", sessions, &mut failures);

    // 6. Invite → the invited user signs up and JOINS the owner's org.
    let invite_email = format!("invitee-{}@example.com", rand_suffix());
    let mut editor_access = String::new();
    let invite = async {
        let inv: Value = http
            .post(format!("{base}/api/users"))
            .bearer_auth(&owner_access)
            .json(&json!({ "action": "invite", "email": invite_email, "role": "editor" }))
            .send()
            .await?
            .json()
            .await?;
        anyhow::ensure!(inv["role"] == "editor", "invite: {inv}");
        anyhow::ensure!(
            inv["inviteUrl"]
                .as_str()
                .is_some_and(|u| u.contains("/login?email=")),
            "invite url: {inv}"
        );

        let joined = sign_up(&http, &base, &invite_email, "invitee-password-1", "Invitee").await?;
        editor_access = joined["accessToken"]
            .as_str()
            .context("no token")?
            .to_string();
        anyhow::ensure!(joined["user"]["role"] == "editor", "joined role: {joined}");
        anyhow::ensure!(
            joined["user"]["orgId"].as_str() == Some(owner_org.as_str()),
            "invitee did not join owner org: {joined}"
        );
        Ok(())
    }
    .await;
    report("invite_join_org", invite, &mut failures);

    // 7. RBAC: an editor cannot write org settings.
    let rbac = async {
        let resp = http
            .put(format!("{base}/api/org/settings"))
            .bearer_auth(&editor_access)
            .json(&json!({ "settings": { "searchTopK": 10 } }))
            .send()
            .await?;
        anyhow::ensure!(resp.status() == 403, "expected 403, got {}", resp.status());
        Ok(())
    }
    .await;
    report("rbac_editor_forbidden", rbac, &mut failures);

    // 8. Directory lists both members (invite consumed → no longer pending).
    let directory = async {
        let body: Value = http
            .get(format!("{base}/api/users"))
            .bearer_auth(&owner_access)
            .send()
            .await?
            .json()
            .await?;
        let items = body["items"].as_array().context("no items")?;
        anyhow::ensure!(items.len() >= 2, "expected >=2 users: {}", items.len());
        anyhow::ensure!(
            items
                .iter()
                .any(|u| u["email"] == invite_email.as_str() && u["role"] == "editor"),
            "invitee missing from directory"
        );
        Ok(())
    }
    .await;
    report("directory_lists_members", directory, &mut failures);

    // 9. Super-admin gate: a normal owner is NOT a super admin.
    let su_gate = async {
        let resp = http
            .get(format!("{base}/api/admin/system-settings"))
            .bearer_auth(&owner_access)
            .send()
            .await?;
        anyhow::ensure!(resp.status() == 403, "expected 403, got {}", resp.status());
        Ok(())
    }
    .await;
    report("super_admin_gate", su_gate, &mut failures);

    Ok(failures)
}
