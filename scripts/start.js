// Starts the mock CRM and the integration service together.   npm start
// Ctrl+C stops both.

import { spawn } from 'node:child_process';

const processes = [
  ['crm', ['--env-file-if-exists=.env', 'mock-crm/server.js']],
  ['app', ['--env-file-if-exists=.env', '--watch', 'src/server.js']],
].map(([name, args]) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (stream, target) =>
    stream.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) if (line) target.write(`[${name}] ${line}\n`);
    });
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (code) console.error(`[${name}] exited with code ${code}`);
  });
  return child;
});

const stopAll = () => {
  for (const child of processes) child.kill();
  process.exit(0);
};
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
