//! Creating commits and tags, signed when the user's config asks for it
//! (`commit.gpgsign`, `tag.gpgsign`). libgit2 can store a signature but
//! not make one, so this runs the same programs git would: `gpg` (or
//! `gpg.program`), `gpgsm` for x509, `ssh-keygen -Y sign` for ssh keys.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use git2::{Commit, Config, Object, ObjectType, Oid, Repository, Signature, Tree};

use crate::error::{Error, Result};

pub fn commit(
    r: &Repository,
    author: &Signature,
    committer: &Signature,
    message: &str,
    tree: &Tree,
    parents: &[&Commit],
) -> Result<Oid> {
    let cfg = r.config()?;
    if !cfg.get_bool("commit.gpgsign").unwrap_or(false) {
        return Ok(r.commit(None, author, committer, message, tree, parents)?);
    }
    let buf = r.commit_create_buffer(author, committer, message, tree, parents)?;
    let content = buf.as_str().map_err(|_| Error::msg("The commit isn't valid UTF-8; can't sign it"))?;
    let signature = sign(&cfg, content.as_bytes(), committer)?;
    Ok(r.commit_signed(content, &signature, Some("gpgsig"))?)
}

/// An annotated tag, signed if `tag.gpgsign` is set.
pub fn tag(r: &Repository, name: &str, target: &Object, tagger: &Signature, message: &str) -> Result<Oid> {
    let cfg = r.config()?;
    if !cfg.get_bool("tag.gpgsign").unwrap_or(false) {
        return Ok(r.tag(name, target, tagger, message, false)?);
    }
    let refname = format!("refs/tags/{name}");
    if r.find_reference(&refname).is_ok() {
        return Err(Error::msg(format!("Tag '{name}' already exists")));
    }
    let kind = target.kind().unwrap_or(ObjectType::Commit).str();
    let mut body = format!("object {}\ntype {kind}\ntag {name}\ntagger {}\n\n{message}", target.id(), ident(tagger));
    if !body.ends_with('\n') {
        body.push('\n');
    }
    let signature = sign(&cfg, body.as_bytes(), tagger)?;
    body.push_str(&signature);
    let oid = r.odb()?.write(ObjectType::Tag, body.as_bytes())?;
    r.reference(&refname, oid, false, "tag")?;
    Ok(oid)
}

/// `Name <email> 1767225600 +0300`, as in a commit or tag header.
fn ident(s: &Signature) -> String {
    let when = s.when();
    let off = when.offset_minutes();
    let sign = if off < 0 { '-' } else { '+' };
    let off = off.abs();
    format!(
        "{} <{}> {} {sign}{:02}{:02}",
        String::from_utf8_lossy(s.name_bytes()),
        String::from_utf8_lossy(s.email_bytes()),
        when.seconds(),
        off / 60,
        off % 60
    )
}

fn sign(cfg: &Config, data: &[u8], signer: &Signature) -> Result<String> {
    let format = cfg.get_string("gpg.format").unwrap_or_else(|_| "openpgp".into());
    let key = cfg.get_string("user.signingkey").ok().filter(|k| !k.trim().is_empty());
    match format.as_str() {
        "ssh" => sign_ssh(cfg, data, key.as_deref()),
        "openpgp" | "x509" => {
            let default = if format == "x509" { "gpgsm" } else { "gpg" };
            let program = cfg
                .get_string(&format!("gpg.{format}.program"))
                .or_else(|_| cfg.get_string("gpg.program"))
                .unwrap_or_else(|_| default.into());
            // Like git: without a configured key, sign as the committer.
            let key = key.unwrap_or_else(|| {
                format!("{} <{}>", String::from_utf8_lossy(signer.name_bytes()), String::from_utf8_lossy(signer.email_bytes()))
            });
            sign_gpg(&program, data, &key)
        }
        other => Err(Error::msg(format!("Unknown gpg.format {other:?}"))),
    }
}

fn sign_gpg(program: &str, data: &[u8], key: &str) -> Result<String> {
    let mut child = crate::host::command(program, &[])
        .args(["--status-fd=2", "-bsau", key])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::msg(format!("Couldn't run {program} to sign: {e}")))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let data = data.to_vec();
    // Feed it from another thread so gpg's output can't fill a pipe and
    // deadlock us.
    let writer = std::thread::spawn(move || stdin.write_all(&data));
    let out = child.wait_with_output()?;
    let _ = writer.join();
    let status = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || !status.contains("SIG_CREATED") {
        return Err(Error::msg(format!("Signing failed:\n{}", status.trim())));
    }
    String::from_utf8(out.stdout).map_err(|_| Error::msg("The signature isn't text"))
}

/// A private scratch directory (mode 0700), removed on drop. ssh-keygen
/// writes `<file>.sig` next to its input, so the input can't sit in the
/// shared temp directory.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        // ssh-keygen may run on the host (Flatpak): a folder both sides see.
        let path = crate::host::shared_temp_dir().join(format!("gitbrix-sign-{}-{nanos}", std::process::id()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        Ok(Scratch(path))
    }

    fn file(&self, name: &str, content: &[u8]) -> Result<PathBuf> {
        let path = self.0.join(name);
        std::fs::write(&path, content)?;
        Ok(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sign_ssh(cfg: &Config, data: &[u8], key: Option<&str>) -> Result<String> {
    let program = cfg.get_string("gpg.ssh.program").unwrap_or_else(|_| "ssh-keygen".into());
    let key = key.ok_or_else(|| Error::msg("Set user.signingkey to sign commits with an ssh key"))?;
    // The key is either a file or, like git allows, the public key itself.
    let literal = key.strip_prefix("key::").or_else(|| key.starts_with("ssh-").then_some(key));
    let scratch = Scratch::new()?;
    let key_path: PathBuf = match literal {
        Some(k) => scratch.file("key.pub", format!("{k}\n").as_bytes())?,
        None => super::repo::expand_home(Path::new(key)),
    };
    let input = scratch.file("data", data)?;
    let out = crate::host::command(&program, &[])
        .args(["-Y", "sign", "-n", "git", "-f"])
        .arg(&key_path)
        .arg(&input)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::msg(format!("Couldn't run {program} to sign: {e}")))?;
    let sig = std::fs::read_to_string(scratch.0.join("data.sig"));
    match sig {
        Ok(s) if out.status.success() => Ok(s),
        _ => Err(Error::msg(format!("Signing failed:\n{}", String::from_utf8_lossy(&out.stderr).trim()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idents_carry_the_timezone() {
        let s = Signature::new("Ada", "ada@x", &git2::Time::new(100, -330)).unwrap();
        assert_eq!(ident(&s), "Ada <ada@x> 100 -0530");
        let s = Signature::new("Ada", "ada@x", &git2::Time::new(100, 180)).unwrap();
        assert_eq!(ident(&s), "Ada <ada@x> 100 +0300");
    }
}
