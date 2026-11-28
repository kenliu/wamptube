//! The user's config file: `$XDG_CONFIG_HOME/wamptube/config.toml`, or
//! `~/.config/wamptube/config.toml` when XDG_CONFIG_HOME is unset.
//!
//! ```toml
//! # Playlists and videos loaded at startup, in this order.
//! sources = [
//!   "https://www.youtube.com/playlist?list=PL...",
//!   "https://www.youtube.com/watch?v=...",
//! ]
//! ```
//!
//! Edited with toml_edit so the user's comments and layout survive when the
//! app appends a source.

use std::path::{Path, PathBuf};

use toml_edit::{value, Array, DocumentMut, Item};

const TEMPLATE: &str = r#"# wamptube config
#
# Playlists and videos loaded at startup, in this order. A playlist must be
# Public or Unlisted (yt-dlp runs signed out). Sources added with the
# playlist's ADD > URL button are appended here.
#
# sources = [
#   "https://www.youtube.com/playlist?list=PL...",
#   "https://www.youtube.com/watch?v=...",
# ]
sources = []
"#;

pub fn path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| {
            // Windows has no HOME by default; USERPROFILE is its equivalent.
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(|h| PathBuf::from(h).join(".config"))
        })?;
    Some(base.join("wamptube").join("config.toml"))
}

fn read_doc(p: &Path) -> Result<DocumentMut, String> {
    let text = match std::fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            std::fs::write(p, TEMPLATE).map_err(|e| format!("{}: {e}", p.display()))?;
            eprintln!("[config] created {}", p.display());
            TEMPLATE.to_string()
        }
        Err(e) => return Err(format!("{}: {e}", p.display())),
    };
    text.parse::<DocumentMut>()
        .map_err(|e| format!("{}: {e}", p.display()))
}

pub fn sources_in(doc: &DocumentMut) -> Result<Vec<String>, String> {
    match doc.get("sources") {
        None => Ok(vec![]),
        Some(item) => {
            let arr = item
                .as_array()
                .ok_or("`sources` must be an array of strings")?;
            arr.iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "`sources` must be an array of strings".to_string())
                })
                .collect()
        }
    }
}

/// The configured sources, creating a commented template file if none exists.
pub fn load(p: &Path) -> Result<Vec<String>, String> {
    sources_in(&read_doc(p)?)
}

/// Append `source` unless it is already listed. Returns whether it was added.
pub fn add_source(p: &Path, source: &str) -> Result<bool, String> {
    let mut doc = read_doc(p)?;
    if sources_in(&doc)?.iter().any(|s| s == source) {
        return Ok(false);
    }
    match doc.get_mut("sources").and_then(Item::as_array_mut) {
        Some(arr) => {
            arr.push(source);
            // one entry per line, like the template's example
            for v in arr.iter_mut() {
                v.decor_mut().set_prefix("\n  ");
            }
            arr.set_trailing("\n");
            arr.set_trailing_comma(true);
        }
        None => {
            let mut arr = Array::new();
            arr.push(source);
            doc["sources"] = value(arr);
        }
    }
    let tmp = p.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, p).map_err(|e| format!("{}: {e}", p.display()))?;
    eprintln!("[config] added {source} to {}", p.display());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_template_then_appends_keeping_comments() {
        let dir = std::env::temp_dir().join(format!("wamptube-cfg-{}", uuid::Uuid::new_v4()));
        let p = dir.join("wamptube").join("config.toml");
        assert_eq!(load(&p).unwrap(), Vec::<String>::new());
        assert!(add_source(&p, "https://www.youtube.com/playlist?list=PLabc").unwrap());
        assert!(!add_source(&p, "https://www.youtube.com/playlist?list=PLabc").unwrap());
        assert!(add_source(&p, "https://www.youtube.com/watch?v=Hf20ZzMRs-I").unwrap());
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.starts_with("# wamptube config"), "{text}");
        assert_eq!(
            load(&p).unwrap(),
            vec![
                "https://www.youtube.com/playlist?list=PLabc".to_string(),
                "https://www.youtube.com/watch?v=Hf20ZzMRs-I".to_string()
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_non_string_sources() {
        let doc: DocumentMut = "sources = [1]".parse().unwrap();
        assert!(sources_in(&doc).is_err());
    }
}
