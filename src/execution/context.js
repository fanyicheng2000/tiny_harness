import { AsyncLocalStorage } from 'node:async_hooks';

const executionContext = new AsyncLocalStorage();

export function runWithExecutionContext(context, fn) {
  return executionContext.run(context, fn);
}

export function getExecutionContext() {
  return executionContext.getStore() || { sessionId: 'default', agentId: 'default' };
}
