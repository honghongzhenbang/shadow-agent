import { parentPort, workerData } from 'node:worker_threads';
import { registerShadowTools, readActiveInformationForRuntime, observeNativeSendForRuntime } from './index.js';
import { createShadowContextEngine } from './context-engine.js';

const tools = new Map();
registerShadowTools({ pluginConfig: workerData.config, registerTool: tool => tools.set(tool.name, tool) });
const contextEngine = createShadowContextEngine(workerData.config, () => { throw new Error('Compaction belongs to the Gateway runtime'); });
let queue = Promise.resolve();
parentPort.on('message', message => {
  // One writer/query executor, not another planner. Never replay mutations here.
  queue = queue.then(async () => {
    try {
      let result;
      if (message.operation === 'commitTurn') result = await contextEngine.commitTurn(message.params);
      else if (message.operation === 'readActiveInformation') result = readActiveInformationForRuntime(workerData.config, message.params);
      else if (['nativeSendBefore', 'nativeSendAfter'].includes(message.operation)) result = observeNativeSendForRuntime(workerData.config, message.operation, message.params);
      else {
        const tool = tools.get(message.operation);
        if (!tool) throw new Error(`Unknown database tool: ${message.operation}`);
        result = await tool.execute(`database-worker:${message.id}`, message.params);
      }
      parentPort.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code } });
    }
  });
});
