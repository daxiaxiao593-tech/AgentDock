class OutputFlowController {
  constructor({
    sessionId,
    runId,
    highWatermark,
    lowWatermark,
    send,
    writeControl,
    nextSeq,
    pauseMessage = '\x13',
    resumeMessage = '\x11'
  }) {
    this.sessionId = sessionId;
    this.runId = runId;
    this.highWatermark = highWatermark;
    this.lowWatermark = lowWatermark;
    this.send = send;
    this.writeControl = writeControl;
    this.nextSeq = nextSeq;
    this.pauseMessage = pauseMessage;
    this.resumeMessage = resumeMessage;
    this.outputSeq = 0;
    this.lastAckSeq = 0;
    this.unacknowledged = new Map();
    this.outstandingBytes = 0;
    this.paused = false;
    this.closed = false;
  }

  onData(data) {
    if (this.closed) return false;
    const seq = this.nextSeq ? this.nextSeq() : this.outputSeq + 1;
    this.outputSeq = seq;
    const bytes = Buffer.byteLength(data, 'utf8');
    this.unacknowledged.set(seq, bytes);
    this.outstandingBytes += bytes;
    this.send({
      type: 'output',
      sessionId: this.sessionId,
      runId: this.runId,
      seq,
      data
    });
    if (!this.paused && this.outstandingBytes >= this.highWatermark) {
      this.writeControl(this.pauseMessage);
      this.paused = true;
    }
    return seq;
  }

  ack(runId, seq) {
    if (this.closed || runId !== this.runId || !Number.isSafeInteger(seq)) return false;
    if (seq <= this.lastAckSeq || seq > this.outputSeq) return false;
    for (const [acknowledgedSeq, bytes] of this.unacknowledged) {
      if (acknowledgedSeq <= seq) {
        this.outstandingBytes -= bytes;
        this.unacknowledged.delete(acknowledgedSeq);
      }
    }
    this.lastAckSeq = seq;
    if (this.paused && this.outstandingBytes <= this.lowWatermark) {
      this.writeControl(this.resumeMessage);
      this.paused = false;
    }
    return true;
  }

  close() {
    this.closed = true;
    this.unacknowledged.clear();
    this.outstandingBytes = 0;
  }

  snapshot() {
    return {
      runId: this.runId,
      outputSeq: this.outputSeq,
      lastAckSeq: this.lastAckSeq,
      outstandingBytes: this.outstandingBytes,
      paused: this.paused,
      closed: this.closed
    };
  }
}

module.exports = { OutputFlowController };
