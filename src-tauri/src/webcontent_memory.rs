use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WebContentMemorySample {
    pub processes: usize,
    pub selected_pid: i32,
    pub resident_bytes: u64,
    pub physical_footprint_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct WebContentMemoryMonitorState {
    token: Arc<AtomicU64>,
}

impl WebContentMemoryMonitorState {
    pub fn start(&self) -> u64 {
        self.token.fetch_add(1, Ordering::SeqCst).saturating_add(1)
    }

    pub fn is_active(&self, token: u64) -> bool {
        self.token.load(Ordering::SeqCst) == token
    }
}

#[cfg(target_os = "macos")]
pub fn sample_webcontent_memory() -> WebContentMemorySample {
    use std::{ffi::CStr, mem};

    fn all_pids() -> Vec<libc::pid_t> {
        let mut pids = vec![0 as libc::pid_t; 8_192];
        let byte_capacity = pids.len().saturating_mul(mem::size_of::<libc::pid_t>());
        let count = unsafe {
            libc::proc_listallpids(
                pids.as_mut_ptr().cast(),
                i32::try_from(byte_capacity).unwrap_or(i32::MAX),
            )
        };
        if count <= 0 {
            return Vec::new();
        }
        pids.truncate(usize::try_from(count).unwrap_or(0).min(pids.len()));
        pids.retain(|pid| *pid > 0);
        pids
    }

    fn process_name(pid: libc::pid_t) -> Option<String> {
        let mut name = [0 as libc::c_char; 256];
        let length = unsafe {
            libc::proc_name(
                pid,
                name.as_mut_ptr().cast(),
                u32::try_from(name.len()).ok()?,
            )
        };
        if length <= 0 {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(name.as_ptr()) }
                .to_string_lossy()
                .into_owned(),
        )
    }

    fn process_memory(pid: libc::pid_t) -> Option<(u64, u64)> {
        let mut usage = unsafe { mem::zeroed::<libc::rusage_info_v2>() };
        // libproc declares this as `rusage_info_t *`, but writes the selected
        // struct directly into the address. Cast the struct buffer itself;
        // passing the address of a temporary pointer corrupts the caller stack.
        let buffer = (&mut usage as *mut libc::rusage_info_v2).cast::<libc::rusage_info_t>();
        let status = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, buffer) };
        (status == 0).then_some((usage.ri_resident_size, usage.ri_phys_footprint))
    }

    let mut sample = WebContentMemorySample::default();
    for pid in all_pids() {
        let Some(name) = process_name(pid) else {
            continue;
        };
        if !name.contains("WebContent") {
            continue;
        }
        let Some((resident_bytes, physical_footprint_bytes)) = process_memory(pid) else {
            continue;
        };
        sample.processes = sample.processes.saturating_add(1);
        if physical_footprint_bytes > sample.physical_footprint_bytes {
            sample.selected_pid = pid;
            sample.resident_bytes = resident_bytes;
            sample.physical_footprint_bytes = physical_footprint_bytes;
        }
    }
    sample
}

#[cfg(not(target_os = "macos"))]
pub fn sample_webcontent_memory() -> WebContentMemorySample {
    WebContentMemorySample::default()
}

#[cfg(test)]
mod tests {
    use super::WebContentMemoryMonitorState;

    #[test]
    fn starting_a_monitor_supersedes_the_previous_token() {
        let state = WebContentMemoryMonitorState::default();
        let first = state.start();
        assert!(state.is_active(first));
        let second = state.start();
        assert!(!state.is_active(first));
        assert!(state.is_active(second));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sampling_webcontent_processes_is_safe() {
        let _ = super::sample_webcontent_memory();
    }
}
