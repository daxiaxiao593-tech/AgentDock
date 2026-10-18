const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

process.stdout.write(`AGENTDOCK_CWD:${process.cwd()}\r\nAGENTDOCK_READY\r\n`);

input.on('line', line => {
  process.stdout.write(`AGENTDOCK_INPUT:${line}\r\n`);
  if (line === 'exit') process.exit(0);
});
