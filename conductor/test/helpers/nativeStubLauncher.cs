// Test-only Windows executable: run the adjacent .cjs fixture with the Node
// executable recorded by writeStubCli. No shell or installed model CLI is used.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

class NativeStubLauncher {
    // Windows command-line quoting, including empty arguments, embedded quotes
    // and trailing backslashes. ProcessStartInfo on .NET Framework takes a string.
    static string Quote(string value) {
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            output.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            output.Append(c);
            slashes = 0;
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }

    static int Main(string[] args) {
        try {
            string executable = Assembly.GetExecutingAssembly().Location;
            string node = File.ReadAllText(executable + ".node");
            var arguments = new StringBuilder(Quote(executable + ".cjs"));
            foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
            var start = new ProcessStartInfo(node, arguments.ToString());
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            // Forward bytes explicitly: a no-console .NET child does not reliably
            // inherit its parent's pipe handles. Cwd and environment are inherited.
            using (Process child = Process.Start(start)) {
                Task stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                Task stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                Task input = Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream);
                input.ContinueWith(delegate {
                    try { child.StandardInput.Close(); } catch (InvalidOperationException) { }
                });
                child.WaitForExit();
                Task.WaitAll(stdout, stderr);
                return child.ExitCode;
            }
        } catch (Exception error) {
            Console.Error.WriteLine("Synthetic CLI launcher failed: " + error.Message);
            return 127;
        }
    }
}
