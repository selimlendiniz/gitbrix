//! Updates: a release manifest (`latest.json`, as written by
//! `scripts/release.sh`) at an address set in Settings. The download is
//! checked against the public key in tauri.conf.json before anything is
//! installed. AppImage, RPM and DEB installs update themselves (a package
//! asks for the system password through polkit); Flatpak and development
//! builds don't.
//!
//! The plugin's `dangerousInsecureTransportProtocol` is on so that a
//! release can be tried from this machine over http; `manifest_url` allows
//! http only for loopback addresses, and the signature check doesn't
//! depend on the transport.

use serde::Serialize;
use tauri::AppHandle;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri_plugin_updater::UpdaterExt;
use tauri::Url;

use crate::error::{Error, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    /// The newer version on offer, if any.
    pub version: Option<String>,
    pub notes: Option<String>,
    /// When it was published, as the manifest says.
    pub date: Option<String>,
    /// How this copy was installed: `appimage`, `rpm`, `deb`, `flatpak`,
    /// or `dev` (a plain binary, e.g. from `cargo build`).
    pub kind: String,
    /// It can install the update itself.
    pub can_install: bool,
}

/// How this copy was installed.
pub fn kind() -> &'static str {
    if std::env::var_os("FLATPAK_ID").is_some() || std::path::Path::new("/.flatpak-info").exists() {
        return "flatpak";
    }
    match bundle_type() {
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Rpm) => "rpm",
        Some(BundleType::Deb) => "deb",
        _ => "dev",
    }
}

/// The manifest's address: https, or http on this machine (for trying a
/// release out before it's uploaded).
pub fn manifest_url(address: &str) -> Result<Url> {
    let url = Url::parse(address.trim()).map_err(|_| Error::msg(format!("Not an address: {address}")))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => Ok(url),
        "http" if local => Ok(url),
        _ => Err(Error::msg("The update address must use https")),
    }
}

async fn find(app: &AppHandle, address: &str) -> Result<Option<tauri_plugin_updater::Update>> {
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest_url(address)?])
        .map_err(|e| Error::msg(e.to_string()))?
        .build()
        .map_err(|e| Error::msg(e.to_string()))?;
    updater.check().await.map_err(|e| Error::msg(format!("Couldn't check for updates: {e}")))
}

pub async fn check(app: &AppHandle, address: &str) -> Result<UpdateInfo> {
    let kind = kind();
    let update = find(app, address).await?;
    Ok(UpdateInfo {
        current: app.package_info().version.to_string(),
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()),
        date: update.as_ref().and_then(|u| u.date).map(|d| d.to_string()),
        kind: kind.to_owned(),
        can_install: matches!(kind, "appimage" | "rpm" | "deb"),
    })
}

/// Download, verify, install, restart.
pub async fn install(app: &AppHandle, address: &str) -> Result<()> {
    if !matches!(kind(), "appimage" | "rpm" | "deb") {
        return Err(Error::msg(match kind() {
            "flatpak" => "Flatpak installs update with `flatpak update`",
            _ => "This copy wasn't installed from a package; build or install a newer one",
        }));
    }
    let update = find(app, address).await?.ok_or_else(|| Error::msg("No newer version"))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| Error::msg(format!("The update failed: {e}")))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_addresses() {
        assert!(manifest_url("https://example.com/gitbrix/latest.json").is_ok());
        assert!(manifest_url("http://127.0.0.1:8000/latest.json").is_ok());
        assert!(manifest_url("http://localhost/latest.json").is_ok());
        assert!(manifest_url("http://example.com/latest.json").is_err());
        assert!(manifest_url("file:///tmp/latest.json").is_err());
        assert!(manifest_url("latest.json").is_err());
    }
}
