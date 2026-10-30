using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// Test-only ConPTY host. No desktop, Scheduled Task or production state changes.
internal static class ConsoleFixture
{
    [StructLayout(LayoutKind.Sequential)] private struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int cb; public string reserved, desktop, title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reservedSize; public IntPtr reservedData, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr security, int size);
    [DllImport("kernel32.dll")] private static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, int flags, out IntPtr console);
    [DllImport("kernel32.dll")] private static extern int ResizePseudoConsole(IntPtr console, Coord size);
    [DllImport("kernel32.dll")] private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr handle, out int code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] private static extern bool SetStdHandle(int kind, IntPtr handle);

    private static string Quoted(string text) { return "\"" + text + "\""; }
    private static void Require(bool ok) { if (!ok) throw new Exception("Native API failure: " + Marshal.GetLastWin32Error()); }
    private static int Main(string[] args)
    {
        IntPtr console = IntPtr.Zero, attributes = IntPtr.Zero;
        ProcessInfo process = new ProcessInfo();
        try
        {
            if (args.Length != 4) return 1;
            IntPtr inputRead, inputWrite, outputRead, outputWrite;
            Require(CreatePipe(out inputRead, out inputWrite, IntPtr.Zero, 0));
            Require(CreatePipe(out outputRead, out outputWrite, IntPtr.Zero, 0));
            Require(CreatePseudoConsole(new Coord { X = short.Parse(args[3]), Y = 24 }, inputRead, outputWrite, 0, out console) == 0);
            CloseHandle(inputRead); CloseHandle(outputWrite);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020016), console, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            StartupInfoEx startup = new StartupInfoEx { attributes = attributes };
            startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            string system = Environment.GetEnvironmentVariable("SystemRoot");
            string shell = args[0] == "cmd" ? Path.Combine(system, "System32", "cmd.exe")
                : Path.Combine(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            string command = args[0] == "cmd"
                ? Quoted(shell) + " /d /s /c \"" + Quoted(args[1]) + " " + Quoted(args[2]) + " async\""
                : Quoted(shell) + " -NoLogo -NoProfile -NonInteractive -Command \"& '" + args[1].Replace("'", "''") + "' '" + args[2].Replace("'", "''") + "' async\"";
            // Do not let a console client inherit this test host's redirected pipes.
            IntPtr stdin = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12);
            try
            {
                SetStdHandle(-10, IntPtr.Zero); SetStdHandle(-11, IntPtr.Zero); SetStdHandle(-12, IntPtr.Zero);
                Require(CreateProcess(shell, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, 0x00080000,
                    IntPtr.Zero, null, ref startup, out process));
            }
            finally { SetStdHandle(-10, stdin); SetStdHandle(-11, stdout); SetStdHandle(-12, stderr); }
            using (FileStream input = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write))
            using (FileStream output = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read))
            {
                Thread reader = new Thread(() => {
                    try { output.CopyTo(Console.OpenStandardOutput()); }
                    catch (IOException) { }
                    catch (ObjectDisposedException) { }
                });
                reader.IsBackground = true; reader.Start();
                Thread writer = new Thread(() => {
                    try
                    {
                        Console.InputEncoding = new UTF8Encoding(false);
                        string line;
                        while ((line = Console.ReadLine()) != null)
                        {
                            if (line.StartsWith("C2C_TEST_RESIZE "))
                                Require(ResizePseudoConsole(console, new Coord { X = short.Parse(line.Substring(16)), Y = 24 }) == 0);
                            else
                            {
                                byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
                                input.Write(bytes, 0, bytes.Length); input.Flush();
                            }
                        }
                    }
                    catch (Exception) { TerminateProcess(process.process, 1); }
                });
                writer.IsBackground = true; writer.Start();
                if (WaitForSingleObject(process.process, 20000) != 0)
                {
                    TerminateProcess(process.process, 1);
                    throw new Exception("Native console deadline exceeded");
                }
                int code; Require(GetExitCodeProcess(process.process, out code));
                ClosePseudoConsole(console); console = IntPtr.Zero;
                Require(reader.Join(5000));
                return code;
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        finally
        {
            if (console != IntPtr.Zero) ClosePseudoConsole(console);
            if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
            if (process.process != IntPtr.Zero) CloseHandle(process.process);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
        }
    }
}
