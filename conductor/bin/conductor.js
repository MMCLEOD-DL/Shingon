#!/usr/bin/env node
// bin/conductor.js
import { main } from '../src/cli/main.js';

process.exit(await main(process.argv.slice(2)));
