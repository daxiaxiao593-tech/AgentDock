using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AgentDockIntegrationCli {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
    static readonly object logLock = new object();
    static string logPath;
    static void Log(string kind, string data) {
        lock (logLock) File.AppendAllText(logPath, kind + " " + data + "\n", Encoding.UTF8);
    }
    public static void Main() {
        var pid = Process.GetCurrentProcess().Id;
        logPath = Path.Combine(Environment.GetEnvironmentVariable("AGENTDOCK_TEST_LOG"), pid + ".log");
        var cwd = Environment.CurrentDirectory;
        Log("START", cwd);
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        uint mode;
        var inputHandle = GetStdHandle(-10);
        if (GetConsoleMode(inputHandle, out mode)) SetConsoleMode(inputHandle, mode & ~7u);
        Console.WriteLine("FIXTURE_READY pid=" + pid + " cwd=" + cwd);
        var input = Console.OpenStandardInput();
        var line = new StringBuilder();
        while (true) {
            var b = input.ReadByte();
            if (b < 0) return;
            if (b == 27) {
                var next = input.ReadByte();
                if (next == 91) { do { next = input.ReadByte(); } while (next >= 0 && !(next >= 64 && next <= 126)); }
                continue;
            }
            if (b == 3) { Log("ETX", "received"); Console.WriteLine("FIXTURE_ETX"); continue; }
            if (b == 10) continue;
            if (b != 13) { line.Append((char)b); continue; }
            var command = line.ToString(); line.Length = 0;
            Log("INPUT", command);
            if (command.StartsWith("PING ")) Console.WriteLine("PONG " + command.Substring(5));
            if (command.StartsWith("LINES ")) {
                int rows = int.Parse(command.Substring(6));
                for (int i = 0; i < rows; i++) Console.WriteLine("SCROLL_" + i.ToString("D4") + "_pid=" + pid);
            }
            if (command.StartsWith("DELAY ")) {
                var marker = command.Substring(6);
                new Thread(() => { Thread.Sleep(400); Console.WriteLine("BACKGROUND_" + marker); Log("BACKGROUND", marker); }).Start();
            }
            if (command == "BURST") {
                new Thread(() => {
                    Thread.Sleep(500);
                    Log("BURST_BEGIN", "2097152+");
                    for (int i = 0; i < 4096; i++) Console.WriteLine("BURST_" + i.ToString("D4") + "_" + new string('B', 512));
                    Console.WriteLine("FIXTURE_BURST_DONE");
                    Log("BURST_DONE", "4096");
                }).Start();
            }
        }
    }
}
