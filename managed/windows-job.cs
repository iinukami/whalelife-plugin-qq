/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Only processes CREATED by this supervisor enter this unnamed Job. Never attach
// an existing QQ, enumerate/kill by image name, or persist a PID for later killing.
public static class WhaleLifeOwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
    public int cb; public string reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public short show, reserved2; public IntPtr data, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC {
    public long processTime, jobTime; public uint flags; public UIntPtr min, max;
    public uint active; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr pMem,jMem,pPeak,jPeak; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref EXT limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA sa, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SA sa, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI startup, out PI process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new InvalidOperationException("Owned process creation failed: " + Marshal.GetLastWin32Error()); }
  public static void Run(string exe, string command, string cwd) {
    IntPtr job=IntPtr.Zero, read=IntPtr.Zero, write=IntPtr.Zero, nul=IntPtr.Zero;
    PI child=new PI();
    var stop=new ManualResetEvent(false);
    // EOF is the lifetime lease: plugin crash/kill closes its pipe too.
    var reader=new Thread(()=> { try { Console.ReadLine(); } finally { stop.Set(); } });
    reader.IsBackground=true; reader.Start();
    try {
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
      var limits=new EXT(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(EXT))));
      var sa=new SA { length=Marshal.SizeOf(typeof(SA)), inherit=1 };
      Check(CreatePipe(out read,out write,ref sa,0));
      Check(SetHandleInformation(write,1,0));
      foreach(int kind in new[]{-10,-11,-12}) SetHandleInformation(GetStdHandle(kind),1,0);
      nul=CreateFile("NUL",0x40000000,3,ref sa,3,0,IntPtr.Zero); Check(nul!=new IntPtr(-1));
      if(stop.WaitOne(0)) return;
      var si=new SI { cb=Marshal.SizeOf(typeof(SI)), flags=0x100, input=read, output=nul, error=nul };
      Check(CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out child));
      if(!AssignProcessToJobObject(job,child.process)) { TerminateProcess(child.process,1); Check(false); }
      if(!stop.WaitOne(0)) ResumeThread(child.thread);
      Console.WriteLine("{\"event\":\"started\",\"pid\":"+child.pid+"}");
      while(!stop.WaitOne(20) && WaitForSingleObject(child.process,0)!=0) {}
      if(stop.WaitOne(0) && WaitForSingleObject(child.process,0)!=0) {
        try {
          using(var stream=new FileStream(new SafeFileHandle(write,false),FileAccess.Write)) {
            byte[] bytes=Encoding.UTF8.GetBytes("stop\n"); stream.Write(bytes,0,bytes.Length); stream.Flush();
          }
        } catch {}
        WaitForSingleObject(child.process,400);
      }
      uint code=0; GetExitCodeProcess(child.process,out code);
      Console.WriteLine("{\"event\":\"exited\",\"code\":"+code+"}");
    } finally {
      if(job!=IntPtr.Zero) { TerminateJobObject(job,0); CloseHandle(job); }
      foreach(IntPtr h in new[]{child.process,child.thread,read,write,nul}) if(h!=IntPtr.Zero && h!=new IntPtr(-1)) CloseHandle(h);
    }
  }
}
