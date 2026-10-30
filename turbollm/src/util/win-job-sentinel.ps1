# TurboLLM's Windows job sentinel (util/win-job-sentinel.ts starts it, util/tether.ts talks to it).
#
# libuv puts every non-detached child of the daemon in a kill-on-close job whose only handle the daemon holds, so
# the direct children die with the daemon however it dies. That job allows breakaway, and Git for Windows' runtime
# breaks every child it creates away from a job that allows it (msys2-runtime winsup/cygwin/spawn.cc), so a Git Bash
# command's children, a build's compiler tree and a Code terminal's programs (ConPTY shells are in no job at all)
# outlived a killed daemon. This script puts each tethered child, and what it has started so far, in a kill-on-close
# job of its own that allows no breakaway, and hands the job's only lasting handle to the daemon: the job closes,
# killing its whole tree, exactly when the daemon dies, however it dies, and this script dying alone changes nothing.
#
# One command per line on stdin, one reply per line on stdout (ASCII):
#   add <id> <pid> <spawnStartMs> <spawnEndMs>  ->  ok <id> <handle> <live members> | gone <id> | refused <id> <why>
#   idle <id> <handle>                          ->  closed <id> (no live member: the handle is closed) | held <id> <n>
#   end <handle>                                ->  (no reply) the job's tree is killed and the handle closed
# A failure answers `error <id> <message>`, or `error end <handle> <message>` for an `end`, which has no id (its
# handle, read as one, would answer an unrelated request). `ready` is printed once the C# below has compiled; stdin's
# end (the daemon is gone) ends the script.
param([int]$DaemonPid)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace TurboLLM {
  public static class JobSentinel {
    const uint PROCESS_TERMINATE = 0x0001, PROCESS_DUP_HANDLE = 0x0040, PROCESS_SET_QUOTA = 0x0100;
    const uint PROCESS_QUERY_INFORMATION = 0x0400, SYNCHRONIZE = 0x00100000;
    const uint DUPLICATE_CLOSE_SOURCE = 0x1, DUPLICATE_SAME_ACCESS = 0x2;
    const int JobObjectBasicAccountingInformation = 1, JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint TH32CS_SNAPPROCESS = 0x2;
    const long UNIX_EPOCH_FILETIME = 116444736000000000L;
    // Process creation times are stamped at the system timer's tick (15.6 ms by default), so a child created
    // inside the daemon's spawn window can read up to a tick before it: the guard allows a little more than that.
    const long TOLERANCE_MS = 100;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
      public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
      public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses;
      public uint ActiveProcesses; public uint TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION {
      public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask; public IntPtr BasePriority;
      public UIntPtr UniqueProcessId; public UIntPtr InheritedFromUniqueProcessId;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W {
      public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
      public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
      public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    static uint daemonPid;
    static IntPtr daemon = IntPtr.Zero;

    public static void Init(int pid) {
      daemonPid = (uint)pid;
      daemon = OpenProcess(PROCESS_DUP_HANDLE, false, daemonPid);
      if (daemon == IntPtr.Zero) throw new Exception("cannot open the daemon (pid " + pid + "), error " + Marshal.GetLastWin32Error());
    }

    /** One command line in, one reply line out (null: no reply). */
    public static string Handle(string line) {
      string[] f = line.Trim().Split(' ');
      string id = f[0] == "end" ? "end " + (f.Length > 1 ? f[1] : "?") : f.Length > 1 ? f[1] : "0";
      try {
        if (f[0] == "add" && f.Length == 5) return Add(f[1], uint.Parse(f[2]), long.Parse(f[3]), long.Parse(f[4]));
        if (f[0] == "idle" && f.Length == 3) return Idle(f[1], new IntPtr(long.Parse(f[2])));
        if (f[0] == "end" && f.Length == 2) { End(new IntPtr(long.Parse(f[1]))); return null; }
        return "error " + id + " unknown command";
      } catch (Exception e) {
        return "error " + id + " " + e.Message.Replace('\r', ' ').Replace('\n', ' ');
      }
    }

    static long CreatedMs(IntPtr process) {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return -1;
      return (creation - UNIX_EPOCH_FILETIME) / 10000;
    }

    static long ParentPid(IntPtr process) {
      PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
      int returned;
      if (NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returned) != 0) return -1;
      return (long)info.InheritedFromUniqueProcessId.ToUInt64();
    }

    static uint ActiveMembers(IntPtr job) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) {
        throw new Exception("not a job handle, error " + Marshal.GetLastWin32Error());
      }
      return info.ActiveProcesses;
    }

    static string Add(string id, uint pid, long startMs, long endMs) {
      const uint access = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE;
      IntPtr root = OpenProcess(access, false, pid);
      if (root == IntPtr.Zero) return "gone " + id; // no process object with that pid is left
      List<IntPtr> held = new List<IntPtr>();
      held.Add(root);
      IntPtr job = IntPtr.Zero;
      try {
        // The pid-reuse guard, read from the handle (which answers even once the process has exited): the daemon's
        // own child, created within the window around its spawn() call.
        long parent = ParentPid(root);
        long created = CreatedMs(root);
        if (parent != daemonPid) return "refused " + id + " its parent is " + parent + ", not the daemon";
        if (created < startMs - TOLERANCE_MS || created > endMs + TOLERANCE_MS) return "refused " + id + " created at " + created + ", outside " + startMs + ".." + endMs;
        job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return "error " + id + " CreateJobObject failed, error " + Marshal.GetLastWin32Error();
        // Kill on close, and no breakaway flag at all: Git for Windows breaks away from any job that allows it.
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
          return "error " + id + " SetInformationJobObject failed, error " + Marshal.GetLastWin32Error();
        }
        // The job is empty, so it nests under libuv's. A root that has already exited cannot be assigned: what it
        // started is still swept in below.
        AssignProcessToJobObject(job, root);
        Sweep(job, pid, created, held, access);
        IntPtr forDaemon;
        if (!DuplicateHandle(GetCurrentProcess(), job, daemon, out forDaemon, 0, false, DUPLICATE_SAME_ACCESS)) {
          return "error " + id + " DuplicateHandle failed, error " + Marshal.GetLastWin32Error();
        }
        uint members = ActiveMembers(job);
        return "ok " + id + " " + forDaemon.ToInt64() + " " + members;
      } finally {
        if (job != IntPtr.Zero) CloseHandle(job); // the daemon holds the only lasting handle now
        foreach (IntPtr h in held) CloseHandle(h);
      }
    }

    /** Every descendant of the root that exists now: a process whose parent is the root or one already taken, and
     *  that was created after that parent, is opened and assigned. A handle to every parent taken is held, so none
     *  of their pids can be reused meanwhile. Snapshots repeat until a pass adds nothing, at most 5. */
    static void Sweep(IntPtr job, uint rootPid, long rootCreated, List<IntPtr> held, uint access) {
      Dictionary<uint, long> taken = new Dictionary<uint, long>();
      taken[rootPid] = rootCreated;
      for (int pass = 0; pass < 5; pass++) {
        bool added = false;
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) return;
        try {
          PROCESSENTRY32W entry = new PROCESSENTRY32W();
          entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
          for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) {
            uint pid = entry.th32ProcessID;
            long parentCreated;
            if (taken.ContainsKey(pid) || !taken.TryGetValue(entry.th32ParentProcessID, out parentCreated)) continue;
            IntPtr p = OpenProcess(access, false, pid);
            if (p == IntPtr.Zero) continue;
            long created = CreatedMs(p);
            if (created < parentCreated) { CloseHandle(p); continue; } // an older process that got a reused parent pid
            held.Add(p);
            taken[pid] = created;
            AssignProcessToJobObject(job, p);
            added = true;
          }
        } finally {
          CloseHandle(snapshot);
        }
        if (!added) return;
      }
    }

    /** The daemon's handle `h`, duplicated here without closing it, once it is shown to be a job. */
    static IntPtr Borrow(IntPtr h) {
      IntPtr local;
      if (!DuplicateHandle(daemon, h, GetCurrentProcess(), out local, 0, false, DUPLICATE_SAME_ACCESS)) {
        throw new Exception("cannot reach handle " + h.ToInt64() + ", error " + Marshal.GetLastWin32Error());
      }
      try {
        ActiveMembers(local); // throws for anything that is not a job
      } catch {
        CloseHandle(local);
        throw;
      }
      return local;
    }

    /** Close the daemon's handle `h` (DUPLICATE_CLOSE_SOURCE, with no target). */
    static void CloseInDaemon(IntPtr h) {
      IntPtr unused;
      DuplicateHandle(daemon, h, IntPtr.Zero, out unused, 0, false, DUPLICATE_CLOSE_SOURCE);
    }

    static void End(IntPtr h) {
      IntPtr local = Borrow(h);
      try {
        TerminateJobObject(local, 1);
        CloseInDaemon(h);
      } finally {
        CloseHandle(local);
      }
    }

    static string Idle(string id, IntPtr h) {
      IntPtr local = Borrow(h);
      try {
        uint members = ActiveMembers(local);
        if (members > 0) return "held " + id + " " + members;
        CloseInDaemon(h);
        return "closed " + id;
      } finally {
        CloseHandle(local);
      }
    }
  }
}
'@

function Say([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

try {
  Add-Type -TypeDefinition $source -Language CSharp
  [TurboLLM.JobSentinel]::Init($DaemonPid)
} catch {
  Say ('error 0 ' + ($_.Exception.Message -replace '\s+', ' '))
  exit 2
}
Say 'ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $reply = [TurboLLM.JobSentinel]::Handle($line)
  if ($null -ne $reply) { Say $reply }
}
