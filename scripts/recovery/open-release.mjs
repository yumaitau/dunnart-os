#!/usr/bin/env node
import { runCli } from './release-escrow.mjs';

try {
  await runCli('open-release', process.argv.slice(2));
  console.log('Release escrow verified and extracted.');
} catch {
  console.error('Release recovery failed. Check artifact integrity, matching recovery kit, and new output directory.');
  process.exitCode = 1;
}
