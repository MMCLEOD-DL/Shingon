// Test commands are explicitly configured by the operator, not browser-provided
// shell fragments. Native Windows uses cmd.exe and does not require WSL/sh.
export function testShell(command, { platform = process.platform, env = process.env } = {}) {
  return platform === 'win32'
    // cmd's /s /c strips the outer quotes and interprets its own inner quotes.
    // CRT argument escaping adds backslashes that cmd treats literally, which
    // can turn a failing quoted Node program into a successful string literal.
    ? { cmd: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true }
    : { cmd: 'sh', args: ['-c', command] };
}
