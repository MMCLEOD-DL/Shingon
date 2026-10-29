// Test commands are explicitly configured by the operator, not browser-provided
// shell fragments. Native Windows uses cmd.exe and does not require WSL/sh.
export function testShell(command, { platform = process.platform, env = process.env } = {}) {
  return platform === 'win32'
    ? { cmd: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { cmd: 'sh', args: ['-c', command] };
}
