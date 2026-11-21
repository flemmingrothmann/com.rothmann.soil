'use strict';

// Run locally after deployment. Compare the complete tracked dashboard build context.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const host = process.argv[2] || 'fro@192.168.100.67';
const sshOptions = ['-o', 'ConnectTimeout=15'];
if (host.split('@').pop() === '192.168.100.67') {
  sshOptions.push('-o', 'HostKeyAlias=192.168.100.66');
}
const files = execFileSync('git', ['ls-files', 'dashboard/Dockerfile', 'dashboard/server.js', 'dashboard/public'], { cwd: root, encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(Boolean);
const mismatches = [];
for (const filename of files) {
  const relative = filename.slice('dashboard/'.length);
  const expected = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, filename))).digest('hex');
  const source = execFileSync('ssh', [...sshOptions, host, 'sha256sum', `/opt/soil/${filename}`], { encoding: 'utf8', timeout: 30000 }).trim().split(/\s+/)[0];
  if (source !== expected) mismatches.push(`build context: ${filename}`);
  if (relative === 'Dockerfile') continue;
  const runtimeOutput = execFileSync(
    'ssh', [...sshOptions, host, 'docker', 'exec', 'soil-dashboard', 'sha256sum', `/app/${relative}`],
    { encoding: 'utf8', timeout: 30000 },
  );
  const runtime = runtimeOutput.trim().split(/\s+/)[0];
  if (runtime !== expected) mismatches.push(`runtime: ${filename}`);
}
if (mismatches.length) {
  // This script communicates verification failures directly to the release terminal.
  // eslint-disable-next-line no-console
  console.error(
    `Dashboard artifacts differ from the repository:\n${mismatches.join('\n')}`,
  );
  process.exitCode = 1;
} else {
  // eslint-disable-next-line no-console
  console.log(
    `Verified ${files.length} dashboard build-context files and ${files.length - 1} running files against the repository.`,
  );
}
