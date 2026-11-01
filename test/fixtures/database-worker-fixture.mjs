import { parentPort } from 'node:worker_threads';
parentPort.on('message', message => {
  if (message.operation === 'exit') process.exit(1);
  if (message.operation === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  parentPort.postMessage({ id: message.id, result: message.params });
});
