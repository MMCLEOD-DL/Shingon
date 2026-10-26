import { realIo, runInit, USAGE } from './init-cli.js';

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') process.exitCode = runInit(rest, realIo);
else {
  console.error(command === undefined ? USAGE : `"${command}" is not an ops command yet.\n\n${USAGE}`);
  process.exitCode = 2;
}
