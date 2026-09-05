use super::{
    run_process, spawn_output_reader, OutputReaderEvent, ProcessError, ProcessPipe, ProcessRequest,
    ProcessStream,
};
use fs2::FileExt;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

const FIXTURE_MODE_ENV: &str = "SKILL_EXPERT_PROCESS_FIXTURE_MODE";
const INHERITED_ENV_SENTINEL: &str = "SKILL_EXPERT_PROCESS_INHERITED_SENTINEL";
const DESCENDANT_READY_PATH_ENV: &str = "SKILL_EXPERT_PROCESS_DESCENDANT_READY_PATH";
const LEADER_LOCK_PATH_ENV: &str = "SKILL_EXPERT_PROCESS_LEADER_LOCK_PATH";
const FIXTURE_TEST_NAME: &str = "core::process_runner::tests::controlled_process_fixture";

#[test]
fn controlled_process_fixture() {
    match std::env::var(FIXTURE_MODE_ENV).as_deref() {
        Ok("success") => {
            std::io::stdout().write_all(b"fixture-stdout").unwrap();
            std::io::stderr().write_all(b"fixture-stderr").unwrap();
        }
        Ok("sleep") => std::thread::sleep(Duration::from_secs(10)),
        Ok("short-sleep") => std::thread::sleep(Duration::from_millis(800)),
        Ok("descendant-pipe-holder") => {
            let leader_lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(std::env::var_os(LEADER_LOCK_PATH_ENV).unwrap())
                .unwrap();
            leader_lock.lock_exclusive().unwrap();
            spawn_descendant_pipe_holder();
            std::process::exit(0);
        }
        Ok("detached-short-sleep") => {
            #[cfg(unix)]
            nix::unistd::setsid().unwrap();
            std::fs::write(
                std::env::var_os(DESCENDANT_READY_PATH_ENV).unwrap(),
                b"ready",
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(800));
        }
        Ok("dual-output") => {
            let stdout_writer = std::thread::spawn(|| {
                let mut stdout = std::io::stdout().lock();
                let chunk = vec![b'o'; 16 * 1024];
                for _ in 0..32 {
                    stdout.write_all(&chunk).unwrap();
                }
                stdout.write_all(b"stdout-complete").unwrap();
            });
            let mut stderr = std::io::stderr().lock();
            let chunk = vec![b'e'; 16 * 1024];
            for _ in 0..32 {
                stderr.write_all(&chunk).unwrap();
            }
            stderr.write_all(b"stderr-complete").unwrap();
            drop(stderr);
            stdout_writer.join().unwrap();
        }
        Ok("stdout-overflow") => {
            std::io::stdout()
                .write_all(&vec![b'x'; 128 * 1024])
                .unwrap();
            std::thread::sleep(Duration::from_secs(10));
        }
        Ok("stderr-overflow") => {
            std::io::stderr()
                .write_all(&vec![b'y'; 128 * 1024])
                .unwrap();
            std::thread::sleep(Duration::from_secs(10));
        }
        Ok("nonzero") => {
            std::io::stderr().write_all(b"fixture-failure").unwrap();
            std::process::exit(23);
        }
        Ok("invalid-utf8") => {
            std::io::stdout()
                .write_all(&[b'b', b'e', b'f', b'o', b'r', b'e', 0xff, 0xfe, 0x80])
                .unwrap();
        }
        Ok("environment-parent") => {
            std::env::set_var(INHERITED_ENV_SENTINEL, "不得继承");
            let output = run_process(&fixture_request("environment-probe"), None).unwrap();
            std::io::stdout().write_all(&output.stdout).unwrap();
        }
        Ok("environment-probe") => {
            let observation = if std::env::var_os(INHERITED_ENV_SENTINEL).is_none() {
                b"sentinel-absent".as_slice()
            } else {
                b"sentinel-present".as_slice()
            };
            std::io::stdout().write_all(observation).unwrap();
        }
        Ok("arguments") => {
            let arguments: Vec<_> = std::env::args_os().collect();
            let argument = arguments
                .windows(2)
                .find(|pair| pair[0] == "--skip")
                .map(|pair| pair[1].to_string_lossy().into_owned())
                .unwrap_or_default();
            std::io::stdout().write_all(argument.as_bytes()).unwrap();
        }
        #[cfg(target_os = "windows")]
        Ok("windows-console-parent") => {
            windows_console_fixture::allocate();
            let output = run_process(&fixture_request("windows-console-probe"), None).unwrap();
            std::io::stdout().write_all(&output.stdout).unwrap();
            windows_console_fixture::release();
        }
        #[cfg(target_os = "windows")]
        Ok("windows-console-probe") => {
            let observation = if windows_console_fixture::is_attached() {
                b"console-present".as_slice()
            } else {
                b"console-absent".as_slice()
            };
            std::io::stdout().write_all(observation).unwrap();
        }
        _ => {}
    }
}

fn fixture_request(mode: &str) -> ProcessRequest {
    ProcessRequest::new(
        std::env::current_exe().unwrap(),
        vec![
            OsString::from("--exact"),
            OsString::from(FIXTURE_TEST_NAME),
            OsString::from("--nocapture"),
        ],
        vec![(OsString::from(FIXTURE_MODE_ENV), OsString::from(mode))],
    )
}

/// 后代故意脱离 Unix 进程组并继续持有管道，用于验证读取线程可独立停止。
#[allow(clippy::zombie_processes)]
fn spawn_descendant_pipe_holder() {
    let _descendant = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FIXTURE_TEST_NAME, "--nocapture"])
        .env(FIXTURE_MODE_ENV, "detached-short-sleep")
        .spawn()
        .unwrap();
}

struct FailingReader;

impl Read for FailingReader {
    fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("注入读取失败"))
    }
}

struct PanickingReader;

impl Read for PanickingReader {
    fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
        panic!("注入读取线程 panic")
    }
}

#[test]
fn output_read_failure_is_reported_without_waiting_for_process_timeout() {
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = spawn_output_reader(
        ProcessPipe::Fixture(Box::new(FailingReader)),
        ProcessStream::Stdout,
        "失败读取 fixture",
        1024,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        sender,
    )
    .unwrap();

    let event = receiver.recv_timeout(Duration::from_millis(200)).unwrap();
    reader.join().unwrap();

    assert!(matches!(
        event,
        OutputReaderEvent::ReadFailed(ProcessStream::Stdout, _)
    ));
}

#[test]
fn output_reader_panic_is_reported_without_waiting_for_process_timeout() {
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = spawn_output_reader(
        ProcessPipe::Fixture(Box::new(PanickingReader)),
        ProcessStream::Stderr,
        "panic 读取 fixture",
        1024,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        sender,
    )
    .unwrap();

    let event = receiver.recv_timeout(Duration::from_millis(200)).unwrap();
    reader.join().unwrap();

    assert!(matches!(
        event,
        OutputReaderEvent::Panicked(ProcessStream::Stderr)
    ));
}

#[test]
fn successful_process_preserves_status_and_separate_raw_outputs() {
    let output = run_process(&fixture_request("success"), None).unwrap();

    assert!(output.status.success());
    assert!(output
        .stdout
        .windows(b"fixture-stdout".len())
        .any(|bytes| bytes == b"fixture-stdout"));
    assert!(output
        .stderr
        .windows(b"fixture-stderr".len())
        .any(|bytes| bytes == b"fixture-stderr"));
}

#[test]
fn debug_output_reports_sizes_without_exposing_command_output() {
    let output = run_process(&fixture_request("success"), None).unwrap();

    let debug = format!("{output:?}");

    assert!(debug.contains("stdout_bytes"));
    assert!(debug.contains("stderr_bytes"));
    assert!(!debug.contains("stdout: ["));
    assert!(!debug.contains("stderr: ["));
}

#[test]
fn timed_out_process_is_terminated_and_reaped_before_returning() {
    let started = Instant::now();
    let error = run_process(
        &fixture_request("sleep").with_timeout(Duration::from_millis(80)),
        None,
    )
    .unwrap_err();

    assert!(matches!(
        error,
        ProcessError::TimedOut { timeout } if timeout == Duration::from_millis(80)
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "超时后必须及时终止并回收子进程"
    );
}

#[test]
fn cancelled_process_stops_readers_when_confirmed_descendant_escapes_group() {
    let temp = tempfile::tempdir().unwrap();
    let ready_path = temp.path().join("descendant-ready");
    let leader_lock_path = temp.path().join("leader.lock");
    let request = ProcessRequest::new(
        std::env::current_exe().unwrap(),
        vec![
            OsString::from("--exact"),
            OsString::from(FIXTURE_TEST_NAME),
            OsString::from("--nocapture"),
        ],
        vec![
            (
                OsString::from(FIXTURE_MODE_ENV),
                OsString::from("descendant-pipe-holder"),
            ),
            (
                OsString::from(DESCENDANT_READY_PATH_ENV),
                ready_path.as_os_str().to_owned(),
            ),
            (
                OsString::from(LEADER_LOCK_PATH_ENV),
                leader_lock_path.as_os_str().to_owned(),
            ),
        ],
    )
    .with_timeout(Duration::from_secs(5));
    let cancellation = super::ProcessCancellation::new();
    let cancellation_for_runner = cancellation.clone();
    let runner = std::thread::spawn(move || run_process(&request, Some(&cancellation_for_runner)));
    let ready_deadline = Instant::now() + Duration::from_secs(2);
    while !ready_path.is_file() && Instant::now() < ready_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready_path.is_file() {
        cancellation.cancel();
        let _ = runner.join();
        panic!("后代 fixture 未在期限内报告已成功派生");
    }

    let mut leader_exited = false;
    while Instant::now() < ready_deadline {
        if let Ok(lock) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&leader_lock_path)
        {
            match lock.try_lock_exclusive() {
                Ok(()) => {
                    FileExt::unlock(&lock).unwrap();
                    leader_exited = true;
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("无法检查 leader 进程锁：{error}"),
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !leader_exited {
        cancellation.cancel();
        let _ = runner.join();
        panic!("后代 fixture 的 leader 未在期限内退出");
    }

    let started = Instant::now();
    cancellation.cancel();
    let error = runner.join().unwrap().unwrap_err();

    assert!(matches!(error, ProcessError::Cancelled));
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "取消不得被已脱组后代持有的输出管道阻塞"
    );
}

#[test]
fn cancelled_process_is_terminated_and_reaped_before_returning() {
    let cancellation = super::ProcessCancellation::new();
    let cancellation_for_trigger = cancellation.clone();
    let trigger = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        cancellation_for_trigger.cancel();
    });

    let started = Instant::now();
    let error = run_process(&fixture_request("sleep"), Some(&cancellation)).unwrap_err();
    trigger.join().unwrap();

    assert!(matches!(error, ProcessError::Cancelled));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "取消后必须及时终止并回收子进程"
    );
}

#[test]
fn pre_cancelled_request_does_not_spawn_the_executable() {
    let cancellation = super::ProcessCancellation::new();
    cancellation.cancel();
    let request = ProcessRequest::new(
        "definitely-missing-skill-expert-process-fixture",
        Vec::new(),
        Vec::new(),
    );

    let error = run_process(&request, Some(&cancellation)).unwrap_err();

    assert!(matches!(error, ProcessError::Cancelled));
}

#[test]
fn large_stdout_and_stderr_are_drained_concurrently_without_deadlock() {
    let output = run_process(
        &fixture_request("dual-output").with_timeout(Duration::from_secs(1)),
        None,
    )
    .unwrap();

    assert!(output.status.success());
    assert!(output
        .stdout
        .windows(b"stdout-complete".len())
        .any(|bytes| bytes == b"stdout-complete"));
    assert!(output
        .stderr
        .windows(b"stderr-complete".len())
        .any(|bytes| bytes == b"stderr-complete"));
}

#[test]
fn stdout_limit_excess_returns_named_error_and_reaps_process() {
    let started = Instant::now();
    let error = run_process(
        &fixture_request("stdout-overflow").with_stdout_limit(32 * 1024),
        None,
    )
    .unwrap_err();

    assert!(matches!(
        error,
        ProcessError::OutputLimitExceeded {
            stream: super::ProcessStream::Stdout,
            limit_bytes,
        } if limit_bytes == 32 * 1024
    ));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "stdout 超限后必须及时终止并回收子进程"
    );
}

#[test]
fn stderr_has_an_independent_named_limit() {
    let error = run_process(
        &fixture_request("stderr-overflow").with_stderr_limit(16 * 1024),
        None,
    )
    .unwrap_err();

    assert!(matches!(
        error,
        ProcessError::OutputLimitExceeded {
            stream: super::ProcessStream::Stderr,
            limit_bytes,
        } if limit_bytes == 16 * 1024
    ));
}

#[test]
fn nonzero_exit_remains_a_completed_result_with_raw_stderr() {
    let output = run_process(&fixture_request("nonzero"), None).unwrap();

    assert_eq!(output.status.code(), Some(23));
    assert!(output
        .stderr
        .windows(b"fixture-failure".len())
        .any(|bytes| bytes == b"fixture-failure"));
}

#[test]
fn invalid_utf8_is_preserved_as_original_bytes() {
    let output = run_process(&fixture_request("invalid-utf8"), None).unwrap();

    assert!(output
        .stdout
        .windows(3)
        .any(|bytes| bytes == [0xff, 0xfe, 0x80]));
}

#[test]
fn unrelated_parent_environment_is_not_inherited() {
    let output = run_process(&fixture_request("environment-parent"), None).unwrap();

    assert!(output
        .stdout
        .windows(b"sentinel-absent".len())
        .any(|bytes| bytes == b"sentinel-absent"));
    assert!(!output
        .stdout
        .windows(b"sentinel-present".len())
        .any(|bytes| bytes == b"sentinel-present"));
}

#[test]
fn arguments_are_passed_literally_without_shell_interpretation() {
    const LITERAL_ARGUMENT: &str = "literal;echo-not-executed-$(pwd)";
    let request = ProcessRequest::new(
        std::env::current_exe().unwrap(),
        vec![
            OsString::from("--exact"),
            OsString::from(FIXTURE_TEST_NAME),
            OsString::from("--skip"),
            OsString::from(LITERAL_ARGUMENT),
            OsString::from("--nocapture"),
        ],
        vec![(
            OsString::from(FIXTURE_MODE_ENV),
            OsString::from("arguments"),
        )],
    );

    let output = run_process(&request, None).unwrap();

    assert!(output
        .stdout
        .windows(LITERAL_ARGUMENT.len())
        .any(|bytes| bytes == LITERAL_ARGUMENT.as_bytes()));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_process_does_not_inherit_or_create_a_console_window() {
    let output = run_process(&fixture_request("windows-console-parent"), None).unwrap();

    assert!(output
        .stdout
        .windows(b"console-absent".len())
        .any(|bytes| bytes == b"console-absent"));
    assert!(!output
        .stdout
        .windows(b"console-present".len())
        .any(|bytes| bytes == b"console-present"));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_assignment_failure_terminates_and_waits_suspended_child() {
    let mut command = windows_suspended_fixture_command();

    let (result, cleaned) = super::windows_job::spawn_with_injected_failure(
        &mut command,
        super::windows_job::InjectedFailureStage::Assignment,
    );

    assert!(result.is_err());
    assert!(
        cleaned,
        "Job Object 分配失败后必须终止并等待 suspended 子进程"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_resume_failure_terminates_and_waits_assigned_job() {
    let mut command = windows_suspended_fixture_command();

    let (result, cleaned) = super::windows_job::spawn_with_injected_failure(
        &mut command,
        super::windows_job::InjectedFailureStage::Resume,
    );

    assert!(result.is_err());
    assert!(cleaned, "子进程恢复失败后必须终止 Job Object 并等待子进程");
}

#[cfg(target_os = "windows")]
fn windows_suspended_fixture_command() -> std::process::Command {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", FIXTURE_TEST_NAME, "--nocapture"])
        .env_clear()
        .env(FIXTURE_MODE_ENV, "sleep")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

#[cfg(target_os = "windows")]
mod windows_console_fixture {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn AllocConsole() -> i32;
        fn FreeConsole() -> i32;
        fn GetConsoleWindow() -> *mut c_void;
    }

    pub fn allocate() {
        unsafe {
            AllocConsole();
        }
    }

    pub fn release() {
        unsafe {
            FreeConsole();
        }
    }

    pub fn is_attached() -> bool {
        unsafe { !GetConsoleWindow().is_null() }
    }
}
