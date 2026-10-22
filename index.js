import { createMiddleware, createState } from './core.js';
import { checkCompatibility } from './compatibility.js';

export const inject = ['connection'];
const KEY = Symbol.for('@local/dsh-startup-skip/state/v1');

export async function apply(ctx) {
  const logger = ctx.logger('startup-skip');
  let state = globalThis[KEY];
  if (!state) {
    state = createState();
    Object.defineProperty(globalThis, KEY, { value: state, configurable: false });
  }
  // Unloading permanently disarms this Host process; re-enabling requires a full
  // application restart rather than re-arming on the next business request.
  if (state.phase === 'disabled' || state.phase === 'consumed') {
    logger.info('启动跳过：本进程已结束适配；完整重启 DSH 后重新检查。');
    return;
  }
  const compatibility = await checkCompatibility();
  if (!compatibility.ok) {
    state.phase = 'disabled';
    state.reason = compatibility.reason;
    logger.warn(`启动跳过未启用：${compatibility.reason}；保留官方启动行为。`);
    return;
  }
  state.active = true;
  ctx.effect(() => () => {
    state.active = false;
    state.phase = 'disabled';
    state.reason = 'plugin-unloaded';
    state.busy = null;
  });
  ctx.on('connection/request', createMiddleware({
    state,
    log(event, reason) {
      // Fixed classifications only: never log headers, payloads, refs or tokens.
      if (event === 'consumed') logger.info(`启动跳过：${reason}；后续凭据查询保持真实。`);
      else logger.warn(`启动跳过停止适配：${reason}；保留官方响应。`);
    },
  }));
  logger.info('启动跳过已加载：等待桌面冷启动序列；运行中安装需完整退出后重启。');
}
