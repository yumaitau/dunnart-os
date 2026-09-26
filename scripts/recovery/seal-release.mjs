#!/usr/bin/env node
import { runCli } from './release-escrow.mjs';

try {
  await runCli('seal-release', process.argv.slice(2));
  console.log('Release escrow sealed.');
} catch {
  console.error('Release escrow failed. Check input manifest, recovery kit, source files, and new output directory.');
  process.exitCode = 1;
}
