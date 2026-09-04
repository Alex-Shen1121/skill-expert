use std::ffi::c_void;
use std::io;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus};
use std::ptr;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetProcessId, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    THREAD_SUSPEND_RESUME,
};

struct OwnedWindowsHandle(HANDLE);

impl OwnedWindowsHandle {
    fn from_nullable(handle: HANDLE) -> io::Result<Self> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn from_snapshot(handle: HANDLE) -> io::Result<Self> {
        if handle == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedWindowsHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) struct ManagedChild {
    child: Child,
    job: Option<OwnedWindowsHandle>,
    leader_status: Option<ExitStatus>,
}

impl ManagedChild {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        spawn_inner(command, None)
    }

    pub(super) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub(super) fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.leader_status.is_none() {
            self.leader_status = self.child.try_wait()?;
        }
        let Some(status) = self.leader_status else {
            return Ok(None);
        };
        if active_process_count(self.job.as_ref().expect("持有 Job Object"))? == 0 {
            Ok(Some(status))
        } else {
            Ok(None)
        }
    }

    pub(super) fn terminate_and_wait(&mut self) -> io::Result<()> {
        let job = self.job.take().expect("持有 Job Object");
        let termination = bool_result(unsafe { TerminateJobObject(job.raw(), 1) });
        drop(job);
        let _ = self.child.kill();
        let wait = self.child.wait();
        wait?;
        termination
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            drop(job);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct WindowsSpawnGuard {
    child: Option<Child>,
    job: Option<OwnedWindowsHandle>,
}

impl WindowsSpawnGuard {
    fn new(child: Child, job: OwnedWindowsHandle) -> Self {
        Self {
            child: Some(child),
            job: Some(job),
        }
    }

    fn process_handle(&self) -> HANDLE {
        self.child
            .as_ref()
            .expect("guard 持有子进程")
            .as_raw_handle() as HANDLE
    }

    fn into_managed(mut self) -> ManagedChild {
        ManagedChild {
            child: self.child.take().expect("guard 持有子进程"),
            job: Some(self.job.take().expect("guard 持有 Job Object")),
            leader_status: None,
        }
    }
}

impl Drop for WindowsSpawnGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Some(job) = &self.job {
            unsafe {
                TerminateJobObject(job.raw(), 1);
            }
        }
        let _ = child.kill();
        let cleaned = child.wait().is_ok();
        #[cfg(test)]
        WINDOWS_FAILURE_CLEANUP_OBSERVED.with(|observed| observed.set(cleaned));
    }
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum InjectedFailureStage {
    Assignment,
    Resume,
}

#[cfg(test)]
thread_local! {
    static WINDOWS_FAILURE_CLEANUP_OBSERVED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(super) fn spawn_with_injected_failure(
    command: &mut Command,
    stage: InjectedFailureStage,
) -> (io::Result<ManagedChild>, bool) {
    WINDOWS_FAILURE_CLEANUP_OBSERVED.with(|observed| observed.set(false));
    let result = spawn_inner(command, Some(stage));
    let cleaned = WINDOWS_FAILURE_CLEANUP_OBSERVED.with(std::cell::Cell::get);
    (result, cleaned)
}

fn spawn_inner(
    command: &mut Command,
    #[cfg_attr(not(test), allow(unused_variables))] failure_stage: Option<InjectedFailureStage>,
) -> io::Result<ManagedChild> {
    let job = create_job()?;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let child = command.spawn()?;
    let guard = WindowsSpawnGuard::new(child, job);

    #[cfg(test)]
    if failure_stage == Some(InjectedFailureStage::Assignment) {
        return Err(io::Error::other("注入 Job Object 分配失败"));
    }
    bool_result(unsafe {
        AssignProcessToJobObject(
            guard.job.as_ref().expect("guard 持有 Job Object").raw(),
            guard.process_handle(),
        )
    })?;

    #[cfg(test)]
    if failure_stage == Some(InjectedFailureStage::Resume) {
        return Err(io::Error::other("注入子进程恢复失败"));
    }
    resume_process_threads(guard.process_handle())?;

    Ok(guard.into_managed())
}

#[cfg(not(test))]
enum InjectedFailureStage {}

fn create_job() -> io::Result<OwnedWindowsHandle> {
    let job =
        OwnedWindowsHandle::from_nullable(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    bool_result(unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    })?;
    Ok(job)
}

fn active_process_count(job: &OwnedWindowsHandle) -> io::Result<u32> {
    let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    bool_result(unsafe {
        QueryInformationJobObject(
            job.raw(),
            JobObjectBasicAccountingInformation,
            &mut accounting as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            ptr::null_mut(),
        )
    })?;
    Ok(accounting.ActiveProcesses)
}

fn resume_process_threads(process: HANDLE) -> io::Result<()> {
    let process_id = unsafe { GetProcessId(process) };
    if process_id == 0 {
        return Err(io::Error::last_os_error());
    }
    let snapshot = OwnedWindowsHandle::from_snapshot(unsafe {
        CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    })?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    if unsafe { Thread32First(snapshot.raw(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }

    let mut resumed = 0_u32;
    loop {
        if entry.th32OwnerProcessID == process_id {
            let thread = OwnedWindowsHandle::from_nullable(unsafe {
                OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID)
            })?;
            if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            resumed += 1;
        }

        if unsafe { Thread32Next(snapshot.raw(), &mut entry) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                break;
            }
            return Err(error);
        }
    }

    if resumed == 0 {
        return Err(io::Error::other("没有找到可恢复的子进程线程"));
    }
    Ok(())
}

fn bool_result(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
