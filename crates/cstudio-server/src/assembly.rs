//! Read-only companion AGP snapshots. No client-supplied filesystem paths.
use super::*;
use std::io::Read;

const MAX_AGP_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub(super) struct RemoteAssembly {
    pub name: String,
    pub text: String,
}

pub(super) fn discover(contact: &Path) -> Result<Option<RemoteAssembly>, Box<dyn std::error::Error>> {
    let directory = contact.parent().ok_or("dataset has no parent directory")?;
    let matching = contact.with_extension("agp");
    let mut candidates = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        // Do not expose symlinks or files outside the dataset directory.
        if entry.file_type()?.is_file()
            && entry.path().extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("agp"))
        {
            candidates.push(entry.path());
        }
    }
    let selected = if candidates.contains(&matching) { Some(matching) }
        else if candidates.len() == 1 { candidates.pop() } else { None };
    let Some(path) = selected else { return Ok(None) };
    let mut bytes = Vec::new();
    fs::File::open(&path)?.take(MAX_AGP_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_AGP_BYTES { return Err("companion AGP exceeds 32 MiB".into()); }
    Ok(Some(RemoteAssembly {
        name: path.file_name().unwrap().to_string_lossy().into_owned(),
        text: String::from_utf8(bytes)?,
    }))
}

pub(super) async fn handler(
    State(state): State<AppState>, AxumPath(id): AxumPath<String>, headers: HeaderMap,
) -> Result<Response, ApiError> {
    authorize(&headers, &state)?;
    let assembly = dataset(&state, &id)?.assembly.as_ref()
        .ok_or_else(|| ApiError::not_found("No unambiguous companion AGP; place a matching .agp or a single AGP beside the contact map and restart the service"))?;
    let mut response = Json(assembly).into_response();
    response.headers_mut().insert("cache-control", HeaderValue::from_static("private, no-store"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_handles_absent_unique_ambiguous_and_matching_files() {
        let dir = std::env::temp_dir().join(format!("cstudio-agp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let contact = dir.join("input.mcool");
        assert!(discover(&contact).unwrap().is_none());
        fs::write(dir.join("groups.agp"), "groups").unwrap();
        assert_eq!(discover(&contact).unwrap().unwrap().name, "groups.agp");
        fs::write(dir.join("other.agp"), "other").unwrap();
        assert!(discover(&contact).unwrap().is_none());
        fs::write(dir.join("input.agp"), "matching").unwrap();
        assert_eq!(discover(&contact).unwrap().unwrap().text, "matching");
        fs::remove_dir_all(dir).unwrap();
    }
}
