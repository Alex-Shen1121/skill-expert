//! 受控的外部进程执行接缝。

use std::error::Error;
use std::ffi::OsString;
use std::fmt;
use std::io::{self, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// 未由调用方覆盖时的有限进程超时。
pub const DEFAULT_PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
/// 默认 stdout 上限；足以容纳 Codex 插件目录快照，同时约束异常输出。
pub const DEFAULT_STDOUT_LIMIT_BYTES: usize = 4 * 1024 * 1024;
/// 默认 stderr 上限；错误诊断无需复制完整命令输出。
pub const DEFAULT_STDERR_LIMIT_BYTES: usize = 1024 * 1024;

const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const OUTPUT_READ_BUFFER_BYTES: usize = 8 * 1024;

/// 调用方能够触发、克隆并跨线程传递的进程取消信号。
#[derive(Clone, Default)]
pub struct ProcessCancellation {
    cancelled: Arc<AtomicBool>,
}

impl ProcessCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// 一次受控进程调用的全部输入。
#[derive(Clone)]
pub struct ProcessRequest {
    executable: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    timeout: Duration,
    stdout_limit_bytes: usize,
    stderr_limit_bytes: usize,
}

impl ProcessRequest {
    pub fn new(
        executable: impl Into<PathBuf>,
        arguments: Vec<OsString>,
        environment: Vec<(OsString, OsString)>,
    ) -> Self {
        Self {
            executable: executable.into(),
            arguments,
            environment,
            timeout: DEFAULT_PROCESS_TIMEOUT,
            stdout_limit_bytes: DEFAULT_STDOUT_LIMIT_BYTES,
            stderr_limit_bytes: DEFAULT_STDERR_LIMIT_BYTES,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout.min(DEFAULT_PROCESS_TIMEOUT);
        self
    }

    pub fn with_stdout_limit(mut self, limit_bytes: usize) -> Self {
        self.stdout_limit_bytes = limit_bytes.min(DEFAULT_STDOUT_LIMIT_BYTES);
        self
    }

    pub fn with_stderr_limit(mut self, limit_bytes: usize) -> Self {
        self.stderr_limit_bytes = limit_bytes.min(DEFAULT_STDERR_LIMIT_BYTES);
        self
    }
}

/// 进程正常完成后的原始结果；非零退出也属于正常完成。
pub struct ProcessOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl fmt::Debug for ProcessOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProcessOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

/// 进程输出管道的稳定名称，用于结构化错误归属。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

/// 启动或监管进程时的结构化失败。
#[derive(Debug)]
pub enum ProcessError {
    SpawnFailed(io::Error),
    WaitFailed(io::Error),
    OutputReadFailed {
        stream: ProcessStream,
        source: io::Error,
    },
    OutputReaderPanicked {
        stream: ProcessStream,
    },
    OutputReaderSpawnFailed {
        stream: ProcessStream,
        source: io::Error,
    },
    OutputLimitExceeded {
        stream: ProcessStream,
        limit_bytes: usize,
    },
    Cancelled,
    TimedOut {
        timeout: Duration,
    },
}

impl fmt::Display for ProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SpawnFailed(error) => write!(formatter, "无法启动外部进程：{error}"),
            Self::WaitFailed(error) => write!(formatter, "无法等待外部进程：{error}"),
            Self::OutputReadFailed { stream, source } => {
                write!(formatter, "读取 {} 失败：{source}", stream.name())
            }
            Self::OutputReaderPanicked { stream } => {
                write!(formatter, "读取 {} 的线程异常退出", stream.name())
            }
            Self::OutputReaderSpawnFailed { stream, source } => {
                write!(formatter, "无法启动 {} 读取线程：{source}", stream.name())
            }
            Self::OutputLimitExceeded {
                stream,
                limit_bytes,
            } => write!(
                formatter,
                "{} 输出超过 {} 字节上限",
                stream.name(),
                limit_bytes
            ),
            Self::Cancelled => formatter.write_str("外部进程已取消"),
            Self::TimedOut { timeout } => {
                write!(formatter, "外部进程在 {} 毫秒后超时", timeout.as_millis())
            }
        }
    }
}

impl Error for ProcessError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::SpawnFailed(error) | Self::WaitFailed(error) => Some(error),
            Self::OutputReadFailed { source, .. }
            | Self::OutputReaderSpawnFailed { source, .. } => Some(source),
            Self::OutputReaderPanicked { .. }
            | Self::OutputLimitExceeded { .. }
            | Self::Cancelled
            | Self::TimedOut { .. } => None,
        }
    }
}

impl ProcessStream {
    fn name(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

/// 运行明确的可执行文件和参数数组，不经过 Shell，并只传入显式环境变量。
pub fn run_process(
    request: &ProcessRequest,
    cancellation: Option<&ProcessCancellation>,
) -> Result<ProcessOutput, ProcessError> {
    if cancellation.is_some_and(ProcessCancellation::is_cancelled) {
        return Err(ProcessError::Cancelled);
    }

    let mut command = Command::new(&request.executable);
    command
        .args(&request.arguments)
        .env_clear()
        .envs(request.environment.iter().cloned())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = ManagedChild::spawn(&mut command).map_err(ProcessError::SpawnFailed)?;
    let (event_sender, event_receiver) = mpsc::channel();
    let output_reader_stop = Arc::new(AtomicBool::new(false));
    let stdout_reader = match spawn_output_reader(
        ProcessPipe::Stdout(child.take_stdout().expect("已配置 stdout 管道")),
        ProcessStream::Stdout,
        "受控进程 stdout",
        request.stdout_limit_bytes,
        output_reader_stop.clone(),
        event_sender.clone(),
    ) {
        Ok(reader) => reader,
        Err(source) => {
            terminate_and_reap(&mut child)?;
            return Err(ProcessError::OutputReaderSpawnFailed {
                stream: ProcessStream::Stdout,
                source,
            });
        }
    };
    let stderr_reader = match spawn_output_reader(
        ProcessPipe::Stderr(child.take_stderr().expect("已配置 stderr 管道")),
        ProcessStream::Stderr,
        "受控进程 stderr",
        request.stderr_limit_bytes,
        output_reader_stop.clone(),
        event_sender.clone(),
    ) {
        Ok(reader) => reader,
        Err(source) => {
            output_reader_stop.store(true, Ordering::SeqCst);
            let termination = terminate_and_reap(&mut child);
            let _ = stdout_reader.join();
            termination?;
            return Err(ProcessError::OutputReaderSpawnFailed {
                stream: ProcessStream::Stderr,
                source,
            });
        }
    };
    drop(event_sender);
    let started = Instant::now();
    let mut process_status = None;
    let mut stdout = None;
    let mut stderr = None;
    let status = loop {
        if cancellation.is_some_and(ProcessCancellation::is_cancelled) {
            terminate_and_join_readers(
                &mut child,
                &output_reader_stop,
                stdout_reader,
                stderr_reader,
            )?;
            return Err(ProcessError::Cancelled);
        }

        while let Ok(event) = event_receiver.try_recv() {
            match event {
                OutputReaderEvent::Complete(ProcessStream::Stdout, output) => {
                    stdout = Some(output);
                }
                OutputReaderEvent::Complete(ProcessStream::Stderr, output) => {
                    stderr = Some(output);
                }
                OutputReaderEvent::LimitExceeded(stream) => {
                    terminate_and_join_readers(
                        &mut child,
                        &output_reader_stop,
                        stdout_reader,
                        stderr_reader,
                    )?;
                    return Err(ProcessError::OutputLimitExceeded {
                        stream,
                        limit_bytes: request.limit_for(stream),
                    });
                }
                OutputReaderEvent::ReadFailed(stream, source) => {
                    terminate_and_join_readers(
                        &mut child,
                        &output_reader_stop,
                        stdout_reader,
                        stderr_reader,
                    )?;
                    return Err(ProcessError::OutputReadFailed { stream, source });
                }
                OutputReaderEvent::Panicked(stream) => {
                    terminate_and_join_readers(
                        &mut child,
                        &output_reader_stop,
                        stdout_reader,
                        stderr_reader,
                    )?;
                    return Err(ProcessError::OutputReaderPanicked { stream });
                }
            }
        }

        if started.elapsed() >= request.timeout {
            terminate_and_join_readers(
                &mut child,
                &output_reader_stop,
                stdout_reader,
                stderr_reader,
            )?;
            return Err(ProcessError::TimedOut {
                timeout: request.timeout,
            });
        }
        if process_status.is_none() {
            match child.try_wait() {
                Ok(Some(status)) => process_status = Some(status),
                Ok(None) => {}
                Err(error) => {
                    let _ = terminate_and_join_readers(
                        &mut child,
                        &output_reader_stop,
                        stdout_reader,
                        stderr_reader,
                    );
                    return Err(ProcessError::WaitFailed(error));
                }
            }
        }
        if let Some(status) = process_status {
            if stdout.is_some() && stderr.is_some() {
                break status;
            }
        }
        let remaining = request
            .timeout
            .checked_sub(started.elapsed())
            .unwrap_or_default();
        thread::sleep(PROCESS_POLL_INTERVAL.min(remaining));
    };
    join_output_readers(stdout_reader, stderr_reader)?;
    Ok(ProcessOutput {
        status,
        stdout: stdout.expect("stdout 完成事件已收到"),
        stderr: stderr.expect("stderr 完成事件已收到"),
    })
}

impl ProcessRequest {
    fn limit_for(&self, stream: ProcessStream) -> usize {
        match stream {
            ProcessStream::Stdout => self.stdout_limit_bytes,
            ProcessStream::Stderr => self.stderr_limit_bytes,
        }
    }
}

enum ProcessPipe {
    Stdout(std::process::ChildStdout),
    Stderr(std::process::ChildStderr),
    #[cfg(test)]
    Fixture(Box<dyn Read + Send>),
}

impl ProcessPipe {
    fn read_direct(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Stdout(pipe) => pipe.read(buffer),
            Self::Stderr(pipe) => pipe.read(buffer),
            #[cfg(test)]
            Self::Fixture(pipe) => pipe.read(buffer),
        }
    }

    #[cfg(unix)]
    fn prepare_interruptible(&self) -> io::Result<()> {
        use nix::fcntl::{fcntl, FcntlArg, OFlag};
        use std::os::fd::AsRawFd;

        let descriptor = match self {
            Self::Stdout(pipe) => pipe.as_raw_fd(),
            Self::Stderr(pipe) => pipe.as_raw_fd(),
            #[cfg(test)]
            Self::Fixture(_) => return Ok(()),
        };
        let flags = OFlag::from_bits_truncate(fcntl(descriptor, FcntlArg::F_GETFL)?);
        fcntl(descriptor, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
        Ok(())
    }

    #[cfg(windows)]
    fn prepare_interruptible(&self) -> io::Result<()> {
        Ok(())
    }

    #[cfg(unix)]
    fn read_interruptible(&mut self, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        match self.read_direct(buffer) {
            Ok(read) => Ok(Some(read)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }

    #[cfg(windows)]
    fn read_interruptible(&mut self, buffer: &mut [u8]) -> io::Result<Option<usize>> {
        use std::os::windows::io::AsRawHandle;
        use std::ptr;
        use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, HANDLE};
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;

        #[cfg(test)]
        if matches!(self, Self::Fixture(_)) {
            return self.read_direct(buffer).map(Some);
        }

        let handle = match self {
            Self::Stdout(pipe) => pipe.as_raw_handle() as HANDLE,
            Self::Stderr(pipe) => pipe.as_raw_handle() as HANDLE,
            #[cfg(test)]
            Self::Fixture(_) => unreachable!("fixture 已在上方处理"),
        };
        let mut available = 0_u32;
        if unsafe {
            PeekNamedPipe(
                handle,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut available,
                ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                return Ok(Some(0));
            }
            return Err(error);
        }
        if available == 0 {
            return Ok(None);
        }
        let readable = buffer.len().min(available as usize);
        self.read_direct(&mut buffer[..readable]).map(Some)
    }
}

fn spawn_output_reader(
    mut pipe: ProcessPipe,
    stream: ProcessStream,
    thread_name: &str,
    limit_bytes: usize,
    stop: Arc<AtomicBool>,
    event_sender: mpsc::Sender<OutputReaderEvent>,
) -> io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let event = match catch_unwind(AssertUnwindSafe(|| {
                if let Err(source) = pipe.prepare_interruptible() {
                    return Some(OutputReaderEvent::ReadFailed(stream, source));
                }
                let mut output = Vec::with_capacity(limit_bytes.min(OUTPUT_READ_BUFFER_BYTES));
                let mut buffer = [0_u8; OUTPUT_READ_BUFFER_BYTES];
                loop {
                    if stop.load(Ordering::SeqCst) {
                        return None;
                    }
                    let read = match pipe.read_interruptible(&mut buffer) {
                        Ok(Some(read)) => read,
                        Ok(None) => {
                            thread::sleep(PROCESS_POLL_INTERVAL);
                            continue;
                        }
                        Err(source) => return Some(OutputReaderEvent::ReadFailed(stream, source)),
                    };
                    if read == 0 {
                        return Some(OutputReaderEvent::Complete(stream, output));
                    }
                    if read > limit_bytes.saturating_sub(output.len()) {
                        return Some(OutputReaderEvent::LimitExceeded(stream));
                    }
                    output.extend_from_slice(&buffer[..read]);
                }
            })) {
                Ok(event) => event,
                Err(_) => Some(OutputReaderEvent::Panicked(stream)),
            };
            if let Some(event) = event {
                let _ = event_sender.send(event);
            }
        })
}

enum OutputReaderEvent {
    Complete(ProcessStream, Vec<u8>),
    LimitExceeded(ProcessStream),
    ReadFailed(ProcessStream, io::Error),
    Panicked(ProcessStream),
}

fn join_output_readers(stdout: JoinHandle<()>, stderr: JoinHandle<()>) -> Result<(), ProcessError> {
    let stdout_result = stdout.join();
    let stderr_result = stderr.join();
    stdout_result.map_err(|_| ProcessError::OutputReaderPanicked {
        stream: ProcessStream::Stdout,
    })?;
    stderr_result.map_err(|_| ProcessError::OutputReaderPanicked {
        stream: ProcessStream::Stderr,
    })
}

fn terminate_and_join_readers(
    child: &mut ManagedChild,
    reader_stop: &AtomicBool,
    stdout: JoinHandle<()>,
    stderr: JoinHandle<()>,
) -> Result<(), ProcessError> {
    reader_stop.store(true, Ordering::SeqCst);
    let termination = terminate_and_reap(child);
    let _ = join_output_readers(stdout, stderr);
    termination
}

fn terminate_and_reap(child: &mut ManagedChild) -> Result<(), ProcessError> {
    child.terminate_and_wait().map_err(ProcessError::WaitFailed)
}

#[cfg(unix)]
struct ManagedChild {
    inner: std::process::Child,
    process_group_id: i32,
    leader_status: Option<ExitStatus>,
}

#[cfg(unix)]
impl ManagedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        use std::os::unix::process::CommandExt;

        let mut inner = command.process_group(0).spawn()?;
        let process_group_id = match i32::try_from(inner.id()) {
            Ok(id) => id,
            Err(_) => {
                let _ = inner.kill();
                let _ = inner.wait();
                return Err(io::Error::other("子进程组标识超出平台范围"));
            }
        };
        Ok(Self {
            inner,
            process_group_id,
            leader_status: None,
        })
    }

    fn take_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.inner.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.inner.stderr.take()
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.leader_status.is_none() {
            self.leader_status = self.inner.try_wait()?;
        }
        let Some(status) = self.leader_status else {
            return Ok(None);
        };

        match nix::sys::signal::killpg(nix::unistd::Pid::from_raw(self.process_group_id), None) {
            Ok(()) | Err(nix::errno::Errno::EPERM) => Ok(None),
            Err(nix::errno::Errno::ESRCH) => Ok(Some(status)),
            Err(error) => Err(io::Error::from_raw_os_error(error as i32)),
        }
    }

    fn terminate_and_wait(&mut self) -> io::Result<()> {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.process_group_id),
            nix::sys::signal::Signal::SIGKILL,
        );
        self.inner.wait()?;
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(self.process_group_id),
            nix::sys::signal::Signal::SIGKILL,
        );
        let _ = self.inner.wait();
    }
}

#[cfg(windows)]
use windows_job::ManagedChild;

#[cfg(windows)]
#[path = "process_runner/windows_job.rs"]
mod windows_job;

#[cfg(test)]
#[path = "process_runner/tests.rs"]
mod tests;
