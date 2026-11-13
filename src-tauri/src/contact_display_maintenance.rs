//! Coalesce cache maintenance independently of foreground tile reads/writes.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};

use crate::contact_display_cache;

const QUIET_PERIOD: Duration = Duration::from_secs(2);
const MIN_INTERVAL: Duration = Duration::from_secs(30);
const MAX_WAIT: Duration = Duration::from_secs(30);

pub(crate) struct PruneRequest {
    pub root: PathBuf,
    pub max_bytes: u64,
    pub max_entries: usize,
}

#[derive(Default)]
struct Schedule {
    requests: HashMap<PathBuf, PruneRequest>,
    first_pending: Option<Instant>,
    last_write: Option<Instant>,
    last_finished: Option<Instant>,
}

impl Schedule {
    fn enqueue(&mut self, requests: impl IntoIterator<Item = PruneRequest>, now: Instant) {
        for request in requests {
            self.requests.insert(request.root.clone(), request);
        }
        if !self.requests.is_empty() {
            self.first_pending.get_or_insert(now);
            self.last_write = Some(now);
        }
    }

    fn delay(&self, now: Instant) -> Option<Duration> {
        let first = self.first_pending?;
        // Quiet bursts merge; continuous writes cannot postpone cleanup forever.
        let mut due = (self.last_write? + QUIET_PERIOD).min(first + MAX_WAIT);
        if let Some(last) = self.last_finished {
            due = due.max(last + MIN_INTERVAL);
        }
        Some(due.saturating_duration_since(now))
    }

    fn take_ready(&mut self, now: Instant) -> Option<Vec<PruneRequest>> {
        if self.delay(now)? != Duration::ZERO {
            return None;
        }
        self.first_pending = None;
        self.last_write = None;
        let mut requests: Vec<_> = self.requests.drain().map(|(_, request)| request).collect();
        // Enforce dataset limits before the shared global limit.
        requests.sort_by_key(|request| std::cmp::Reverse(request.root.components().count()));
        Some(requests)
    }
}

#[derive(Default)]
struct Worker {
    schedule: Mutex<Schedule>,
    wake: Condvar,
}

static WORKER: OnceLock<Arc<Worker>> = OnceLock::new();

pub(crate) fn schedule_prune(requests: impl IntoIterator<Item = PruneRequest>) {
    let worker = WORKER.get_or_init(|| {
        let worker = Arc::new(Worker::default());
        let background = Arc::clone(&worker);
        // One sleeping maintenance thread per process; never occupy Tokio's
        // blocking pool while waiting for the next quiet period.
        std::thread::spawn(move || background.run());
        worker
    });
    worker
        .schedule
        .lock()
        .unwrap()
        .enqueue(requests, Instant::now());
    worker.wake.notify_one();
}

impl Worker {
    fn run(&self) {
        loop {
            let requests = {
                let mut schedule = self.schedule.lock().unwrap();
                loop {
                    let now = Instant::now();
                    if let Some(requests) = schedule.take_ready(now) {
                        break requests;
                    }
                    schedule = match schedule.delay(now) {
                        Some(delay) => self.wake.wait_timeout(schedule, delay).unwrap().0,
                        None => self.wake.wait(schedule).unwrap(),
                    };
                }
            };
            // Release the scheduling mutex during I/O. Writers continue and
            // enqueue the next batch; this sole worker serializes all scans.
            for request in requests {
                let started = Instant::now();
                let result = contact_display_cache::prune_tree(
                    &request.root,
                    request.max_bytes,
                    request.max_entries,
                );
                if std::env::var("CSTUDIO_PERF_LOG").as_deref() == Ok("1") {
                    match result {
                        Ok(stats) => eprintln!(
                            "CSTUDIO_PERF event=contact_display_cache status=pruned removed_entries={} removed_bytes={} elapsed_us={}",
                            stats.removed_entries, stats.removed_bytes, started.elapsed().as_micros(),
                        ),
                        Err(error) => eprintln!(
                            "CSTUDIO_PERF event=contact_display_cache status=prune_failed error={error}",
                        ),
                    }
                }
            }
            self.schedule.lock().unwrap().last_finished = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(root: &str) -> PruneRequest {
        PruneRequest {
            root: root.into(),
            max_bytes: 1024,
            max_entries: 10,
        }
    }

    #[test]
    fn coalesces_tile_bursts_and_checks_datasets_before_global_cache() {
        let mut schedule = Schedule::default();
        let start = Instant::now();
        for i in 0..100 {
            schedule.enqueue(
                [request("cache/dataset"), request("cache")],
                start + Duration::from_millis(i),
            );
        }
        assert!(schedule.take_ready(start + QUIET_PERIOD).is_none());
        let jobs = schedule.take_ready(start + Duration::from_secs(3)).unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].root, PathBuf::from("cache/dataset"));
        assert_eq!(jobs[1].root, PathBuf::from("cache"));
        assert_eq!(schedule.delay(start + Duration::from_secs(3)), None);
    }

    #[test]
    fn preserves_writes_during_scan_and_enforces_minimum_interval() {
        let mut schedule = Schedule::default();
        let start = Instant::now();
        schedule.enqueue([request("cache/a")], start);
        assert!(schedule.take_ready(start + QUIET_PERIOD).is_some());
        schedule.enqueue([request("cache/b")], start + Duration::from_secs(3));
        schedule.last_finished = Some(start + Duration::from_secs(4));
        assert!(schedule
            .take_ready(start + Duration::from_secs(33))
            .is_none());
        let jobs = schedule
            .take_ready(start + Duration::from_secs(34))
            .unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].root, PathBuf::from("cache/b"));
    }

    #[test]
    fn sustained_dragging_cannot_starve_cache_limits() {
        let mut schedule = Schedule::default();
        let start = Instant::now();
        for i in 0..30 {
            let now = start + Duration::from_secs(i);
            schedule.enqueue([request("cache")], now);
            assert!(schedule.take_ready(now).is_none());
        }
        assert_eq!(schedule.take_ready(start + MAX_WAIT).unwrap().len(), 1);
    }
}
