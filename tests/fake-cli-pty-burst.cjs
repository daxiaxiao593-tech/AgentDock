const totalRows = Number(process.argv[2]);
const rowSize = 256;
const characters = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let writtenRows = 0;

function writeBurst() {
  while (writtenRows < totalRows) {
    const rowsInChunk = Math.min(rowSize, totalRows - writtenRows);
    let output = '';
    for (let rowOffset = 0; rowOffset < rowsInChunk; rowOffset += 1) {
      const rowNumber = writtenRows + rowOffset;
      let payload = '';
      for (let characterOffset = 0; characterOffset < 56; characterOffset += 1) {
        payload += characters[(rowNumber + characterOffset) % characters.length];
      }
      output += `${String(rowNumber).padStart(6, '0')}:${payload}\n`;
    }
    writtenRows += rowsInChunk;
    if (!process.stdout.write(output)) {
      process.stdout.once('drain', writeBurst);
      return;
    }
  }
  process.stdout.write('\nAGENTDOCK_BURST_DONE\n');
}

writeBurst();
