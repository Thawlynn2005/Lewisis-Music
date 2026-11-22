//! The separation queue: songs waiting to be split into vocals / instrumental.
//!
//! A port of the Python version's `Separator` class. There are two queues,
//! served by one worker thread:
//!
//! * urgent     – the listener pressed Acapella / Karaoke / Separate Audio and is waiting.
//! * background – songs being prepared ahead of time, so those buttons are instant.
//!
//! An urgent request interrupts a background job (which is put back and
//! restarted afterwards), so pressing a button never waits behind background work.
//! Results are cached as `stems/<id>/vocals.flac` and `instrumental.flac`.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use serde::Serialize;

use crate::Result;

pub const STEMS: [&str; 2] = ["vocals", "instrumental"];

/// How one song's separation is going, as the interface sees it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    /// "none", "queued", "running", "done" or "error".
    pub state: &'static str,
    pub progress: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Status {
    fn new(state: &'static str) -> Self {
        Self { state, progress: if state == "done" { 1.0 } else { 0.0 }, stage: None, error: None }
    }
}

/// Does the actual splitting: (song file, output folder, report a stage,
/// report progress → keep going?) → finished (`false` = stopped).
pub type Runner = dyn Fn(&Path, &Path, &mut dyn FnMut(&str), &mut dyn FnMut(f32) -> bool) -> Result<bool> + Send + Sync;

#[derive(Clone, Copy, PartialEq)]
enum Preempt {
    Requeue,
    Drop,
}

#[derive(Default)]
struct State {
    jobs: HashMap<String, Status>,
    sources: HashMap<String, PathBuf>,
    urgent: VecDeque<String>,
    background: VecDeque<String>,
    running: Option<String>,
    running_in_background: bool,
    preempt: Option<Preempt>,
    worker_started: bool,
}

/// Cheap to clone; all clones share one queue and one worker.
#[derive(Clone)]
pub struct Queue {
    shared: Arc<(Mutex<State>, Condvar)>,
    stems_dir: PathBuf,
    runner: Arc<Runner>,
}

impl Queue {
    pub fn new(stems_dir: impl Into<PathBuf>, runner: Arc<Runner>) -> Self {
        Self { shared: Arc::new((Mutex::new(State::default()), Condvar::new())), stems_dir: stems_dir.into(), runner }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn stem_path(&self, track_id: &str, stem: &str) -> PathBuf {
        self.stems_dir.join(track_id).join(format!("{stem}.flac"))
    }

    pub fn has_stems(&self, track_id: &str) -> bool {
        STEMS.iter().all(|stem| self.stem_path(track_id, stem).is_file())
    }

    pub fn status(&self, track_id: &str) -> Status {
        if self.has_stems(track_id) {
            return Status::new("done");
        }
        self.state().jobs.get(track_id).cloned().unwrap_or_else(|| Status::new("none"))
    }

    /// Queue a song. `urgent` means someone is waiting for it right now.
    pub fn request(&self, track_id: &str, source: &Path, urgent: bool) -> Status {
        if self.has_stems(track_id) {
            return self.status(track_id);
        }
        let mut state = self.state();
        state.sources.insert(track_id.to_string(), source.to_path_buf());
        if state.running.as_deref() == Some(track_id) {
            if urgent {
                state.running_in_background = false; // now protected from being interrupted
                if state.preempt == Some(Preempt::Requeue) {
                    state.preempt = None;
                }
            }
            return state.jobs[track_id].clone();
        }
        if urgent {
            state.background.retain(|t| t != track_id);
            if !state.urgent.iter().any(|t| t == track_id) {
                state.urgent.push_front(track_id.to_string());
            }
            if state.running.is_some() && state.running_in_background && state.preempt.is_none() {
                state.preempt = Some(Preempt::Requeue);
            }
        } else if !state.urgent.iter().any(|t| t == track_id) && !state.background.iter().any(|t| t == track_id) {
            state.background.push_back(track_id.to_string());
        }
        if state.jobs.get(track_id).is_none_or(|job| job.state != "queued") {
            state.jobs.insert(track_id.to_string(), Status::new("queued"));
        }
        let status = state.jobs[track_id].clone();
        self.start_worker(&mut state);
        self.shared.1.notify_all();
        status
    }

    /// Stop preparing songs ahead of time (urgent requests are kept).
    pub fn cancel_background(&self) {
        let mut state = self.state();
        let waiting: Vec<String> = state.background.drain(..).collect();
        for track_id in waiting {
            state.jobs.remove(&track_id);
        }
        if state.running.is_some() && state.running_in_background {
            state.preempt = Some(Preempt::Drop);
        }
    }

    /// Drop a song's job and its saved stems (the song was deleted).
    pub fn forget(&self, track_id: &str) {
        {
            let mut state = self.state();
            state.urgent.retain(|t| t != track_id);
            state.background.retain(|t| t != track_id);
            if state.running.as_deref() == Some(track_id) {
                state.preempt = Some(Preempt::Drop);
            } else {
                state.jobs.remove(track_id);
            }
            state.sources.remove(track_id);
        }
        let _ = std::fs::remove_dir_all(self.stems_dir.join(track_id));
    }

    /// True while anything is waiting or being worked on.
    pub fn busy(&self) -> bool {
        let state = self.state();
        state.running.is_some() || !state.urgent.is_empty() || !state.background.is_empty()
    }

    fn start_worker(&self, state: &mut State) {
        if !state.worker_started {
            state.worker_started = true;
            let queue = self.clone();
            thread::Builder::new().name("separator".into()).spawn(move || queue.work()).expect("worker thread");
        }
    }

    fn update(&self, track_id: &str, change: impl FnOnce(&mut Status)) {
        if let Some(job) = self.state().jobs.get_mut(track_id) {
            change(job);
        }
    }

    fn work(&self) {
        loop {
            let (track_id, source) = {
                let mut state = self.state();
                while state.urgent.is_empty() && state.background.is_empty() {
                    state = self.shared.1.wait(state).unwrap_or_else(|p| p.into_inner());
                }
                let in_background = state.urgent.is_empty();
                let next = if in_background { state.background.pop_front() } else { state.urgent.pop_front() };
                let Some(track_id) = next else { continue };
                let Some(source) = state.sources.get(&track_id).cloned() else { continue };
                if !state.jobs.contains_key(&track_id) {
                    continue;
                }
                let mut job = Status::new("running");
                job.stage = Some("loading".into());
                state.jobs.insert(track_id.clone(), job);
                state.running = Some(track_id.clone());
                state.running_in_background = in_background;
                state.preempt = None;
                (track_id, source)
            };

            let out_dir = self.stems_dir.join(&track_id);
            let result = {
                let mut stage = |name: &str| self.update(&track_id, |job| job.stage = Some(name.to_string()));
                let mut progress = |fraction: f32| {
                    if self.state().preempt.is_some() {
                        return false;
                    }
                    self.update(&track_id, |job| job.progress = (fraction * 10_000.0).round() / 10_000.0);
                    true
                };
                (self.runner)(&source, &out_dir, &mut stage, &mut progress)
            };

            let mut state = self.state();
            match result {
                Ok(true) => {
                    if let Some(job) = state.jobs.get_mut(&track_id) {
                        *job = Status::new("done");
                        job.stage = Some("done".into());
                    }
                }
                Ok(false) => {
                    let _ = std::fs::remove_dir_all(&out_dir);
                    if state.preempt == Some(Preempt::Requeue) && state.sources.contains_key(&track_id) {
                        state.jobs.insert(track_id.clone(), Status::new("queued"));
                        state.background.push_front(track_id.clone());
                    } else {
                        state.jobs.remove(&track_id);
                    }
                }
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&out_dir);
                    if let Some(job) = state.jobs.get_mut(&track_id) {
                        job.state = "error";
                        job.error = Some(error.to_string());
                    }
                }
            }
            if !state.sources.contains_key(&track_id) {
                // Deleted while we worked.
                let _ = std::fs::remove_dir_all(&out_dir);
                state.jobs.remove(&track_id);
            }
            state.running = None;
            state.preempt = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    /// A pretend separator: 20 small steps, then writes two empty stems.
    fn fake(log: Arc<Mutex<Vec<String>>>) -> Arc<Runner> {
        Arc::new(move |source: &Path, out: &Path, _stage: &mut dyn FnMut(&str), progress: &mut dyn FnMut(f32) -> bool| {
            let name = source.file_name().unwrap().to_string_lossy().to_string();
            log.lock().unwrap().push(format!("start {name}"));
            for step in 1..=20 {
                thread::sleep(Duration::from_millis(10));
                if !progress(step as f32 / 20.0) {
                    log.lock().unwrap().push(format!("stopped {name}"));
                    return Ok(false);
                }
            }
            std::fs::create_dir_all(out)?;
            for stem in STEMS {
                std::fs::write(out.join(format!("{stem}.flac")), b"")?;
            }
            log.lock().unwrap().push(format!("done {name}"));
            Ok(true)
        })
    }

    fn wait_until(what: impl Fn() -> bool) {
        let started = Instant::now();
        while !what() {
            assert!(started.elapsed() < Duration::from_secs(10), "timed out");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn urgent_requests_jump_ahead_of_background_work() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(Mutex::new(vec![]));
        let queue = Queue::new(dir.path(), fake(log.clone()));
        queue.request("a", Path::new("a.mp3"), false);
        queue.request("b", Path::new("b.mp3"), false);
        wait_until(|| queue.status("a").state == "running");
        queue.request("c", Path::new("c.mp3"), true);
        wait_until(|| ["a", "b", "c"].iter().all(|t| queue.status(t).state == "done"));
        let log = log.lock().unwrap().clone();
        // "a" was interrupted for "c", then started again.
        assert_eq!(log[..4], ["start a.mp3", "stopped a.mp3", "start c.mp3", "done c.mp3"]);
        assert!(log.contains(&"done a.mp3".to_string()) && log.contains(&"done b.mp3".to_string()));
        assert_eq!(queue.status("a"), Status::new("done"));
    }

    #[test]
    fn forgetting_or_cancelling_stops_work() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(Mutex::new(vec![]));
        let queue = Queue::new(dir.path(), fake(log.clone()));
        queue.request("a", Path::new("a.mp3"), false);
        queue.request("b", Path::new("b.mp3"), false);
        wait_until(|| queue.status("a").state == "running");
        queue.cancel_background();
        wait_until(|| !queue.busy());
        assert_eq!(queue.status("a").state, "none");
        assert_eq!(queue.status("b").state, "none");

        queue.request("c", Path::new("c.mp3"), true);
        wait_until(|| queue.status("c").state == "done");
        queue.forget("c");
        assert_eq!(queue.status("c").state, "none");
        assert!(!dir.path().join("c").exists());
    }

    #[test]
    fn errors_are_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let runner: Arc<Runner> = Arc::new(move |_: &Path, _: &Path, _: &mut dyn FnMut(&str), _: &mut dyn FnMut(f32) -> bool| {
            counter.fetch_add(1, Ordering::SeqCst);
            Err(crate::Error::invalid("The audio file is empty."))
        });
        let queue = Queue::new(dir.path(), runner);
        queue.request("x", Path::new("x.mp3"), true);
        wait_until(|| queue.status("x").state == "error");
        assert_eq!(queue.status("x").error.as_deref(), Some("The audio file is empty."));
        queue.request("y", Path::new("y.mp3"), true); // the worker is still alive
        wait_until(|| calls.load(Ordering::SeqCst) == 2);
    }
}
