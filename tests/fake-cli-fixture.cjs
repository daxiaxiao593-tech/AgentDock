process.stdout.write('FAKE CLI READY\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  process.stdout.write(`INPUT:${data.trim()}\n`);
});
