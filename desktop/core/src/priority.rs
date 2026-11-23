//! Background work (AI separation) runs at low priority, so the interface,
//! its animations and the music get the processor first whenever they need it.

/// From now on, run the calling thread at low priority.
pub fn lower_current_thread() {
    // Linux: the nice value belongs to each thread; 10 is the usual "background" level.
    #[cfg(target_os = "linux")]
    // SAFETY: plain system calls on the calling thread's own id.
    unsafe {
        let _ = libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, 10);
    }
    // macOS: the "utility" quality of service, meant for long jobs the user started.
    #[cfg(target_os = "macos")]
    // SAFETY: only changes the calling thread's own scheduling class.
    unsafe {
        let _ = libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(windows)]
    // SAFETY: GetCurrentThread returns a pseudo-handle for the calling thread.
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn lowers_only_the_calling_thread() {
        // SAFETY: reads the calling thread's own nice value.
        let nice = || unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t) };
        let before = nice();
        let inside = std::thread::spawn(move || {
            super::lower_current_thread();
            nice()
        })
        .join()
        .unwrap();
        assert_eq!(inside, before.max(10));
        assert_eq!(nice(), before, "other threads keep their priority");
    }
}
