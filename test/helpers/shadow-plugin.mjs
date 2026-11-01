import { registerHooks } from 'node:module';

export async function isolatedShadowPlugin() {
  const url = new URL('../../openclaw/shadow-work/src/index.js?voice-delivery-test', import.meta.url).href;
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === url && specifier === 'openclaw/plugin-sdk/tool-plugin') return {
      shortCircuit: true, url: 'data:text/javascript,export function defineToolPlugin(x){return Object.assign(x,{register(api){for(const tool of x.tools(v=>v))api.registerTool(tool);}});}',
    };
    if (context.parentURL === url && specifier === 'openclaw/plugin-sdk/core') return {
      shortCircuit: true, url: "data:text/javascript,export function delegateCompactionToRuntime(){throw new Error('Live runtime forbidden in isolated test');}",
    };
    return next(specifier, context);
  } });
  try { return await import(url); } finally { hook.deregister(); }
}
