const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OutputFlowController } = require('../app/runtime/output-flow-controller.cjs');

function setup(options = {}) {
  const packets = [];
  const controlWrites = [];
  const controller = new OutputFlowController({
    sessionId: 'session-a',
    runId: 'run-a1',
    highWatermark: 8,
    lowWatermark: 3,
    send: packet => packets.push(packet),
    writeControl: data => controlWrites.push(data),
    ...options
  });
  return { controller, packets, controlWrites };
}

test('输出用递增 seq 发送，达到高水位后暂停生产', () => {
  const { controller, packets, controlWrites } = setup();

  controller.onData('1234');
  controller.onData('5678');

  assert.deepEqual(packets.map(packet => [packet.runId, packet.seq, packet.data]), [
    ['run-a1', 1, '1234'],
    ['run-a1', 2, '5678']
  ]);
  assert.deepEqual(controlWrites, ['\x13']);
  assert.equal(controller.snapshot().paused, true);
  assert.equal(controller.snapshot().outstandingBytes, 8);
});

test('只接受当前 run 的累计 ACK，降到低水位后恢复生产', () => {
  const { controller, controlWrites } = setup();
  controller.onData('1234');
  controller.onData('5678');

  assert.equal(controller.ack('run-old', 2), false);
  assert.equal(controller.ack('run-a1', 3), false);
  assert.equal(controller.ack('run-a1', 1), true);
  assert.equal(controller.snapshot().outstandingBytes, 4);
  assert.equal(controller.snapshot().paused, true);
  assert.equal(controller.ack('run-a1', 2), true);
  assert.equal(controller.snapshot().outstandingBytes, 0);
  assert.equal(controller.snapshot().paused, false);
  assert.deepEqual(controlWrites, ['\x13', '\x11']);
});

test('重复或倒退 ACK 不改变未确认字节计数', () => {
  const { controller } = setup();
  controller.onData('hello');
  controller.onData('world');

  assert.equal(controller.ack('run-a1', 1), true);
  assert.equal(controller.ack('run-a1', 1), false);
  assert.equal(controller.ack('run-a1', 0), false);
  assert.equal(controller.snapshot().outstandingBytes, 5);
});

test('关闭后忽略迟到输出与 ACK', () => {
  const { controller, packets, controlWrites } = setup();
  controller.onData('12345678');
  controller.close();
  controller.onData('late');

  assert.equal(controller.ack('run-a1', 1), false);
  assert.equal(packets.length, 1);
  assert.deepEqual(controlWrites, ['\x13']);
});
