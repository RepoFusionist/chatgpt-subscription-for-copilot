import * as vscode from 'vscode';
import { AppError, record } from './core';
import { type ChatModel, type Effort } from './chat/models';
import { inputBudget, modelOverride } from './modelSettings';

// Compatibility metadata consumed by Copilot, not a public VS Code API contract.
// Keep the stable provider registration and do not enable proposed APIs.
export interface PickerProperty {
  type: 'string' | 'number'; title: string; enum: (string | number)[];
  enumItemLabels: string[]; enumDescriptions: string[]; default: string | number;
  group: 'navigation' | 'tokens';
}
export interface NativeModelInformation extends vscode.LanguageModelChatInformation {
  configurationSchema: { properties: Record<string, PickerProperty> };
}
export type NativeResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Readonly<Record<string, unknown>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
};
export const EFFORT_LABELS: Record<Effort | 'default', string> = {
  default: '默认', none: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: '极致'
};
const compact = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const MAX_PICKER_CONTEXT = 1_000_000;

export function contextBudgets(model: ChatModel, override = modelOverride(model.id)) {
  const max = Math.min(inputBudget(model, override), MAX_PICKER_CONTEXT);
  const preset = /^gpt-6\.1(?:-|$)/i.test(model.id) ? 500_000
    : /^gpt-5\.6(?:-|$)/i.test(model.id) ? 272_000 : undefined;
  const defaultBudget = Math.min(max, override.contextWindow ?? model.defaultInputTokens ?? preset ?? max);
  return { max, defaultBudget };
}

export function pickerSchema(model: ChatModel, globalEffort: Effort | undefined): NativeModelInformation['configurationSchema'] {
  const override = modelOverride(model.id);
  const effort = override.reasoningEffort ?? globalEffort ?? 'default';
  const requested: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const levels = model.efforts.length ? requested.filter(value => model.efforts.includes(value)) : requested;
  const values = ['default', ...levels];
  const properties: Record<string, PickerProperty> = {
    reasoningEffort: {
      type: 'string', title: '思考强度', enum: values,
      enumItemLabels: ['默认', ...levels.map(value => EFFORT_LABELS[value])],
      enumDescriptions: ['由模型选择思考强度。',
        ...levels.map(() => model.efforts.length ? '账户目录显示此模型支持该档位。' : '目录未声明支持的档位，服务端可能拒绝此设置。')],
      default: values.includes(effort) ? effort : 'default', group: 'navigation'
    }
  };
  const { max, defaultBudget } = contextBudgets(model, override);
  if (defaultBudget >= 1024) {
    const sizes = defaultBudget === max ? [defaultBudget] : [defaultBudget, max];
    properties.contextSize = {
      type: 'number', title: '上下文窗口', enum: sizes,
      enumItemLabels: sizes.map((value, index) => `${index === 0 ? '默认' : '最大'} ${compact(value)}`),
      enumDescriptions: sizes.map(value => `${value.toLocaleString('en-US')} 个输入 token。${model.estimatedInputLimit ? '此额度是估算或用户设定值。' : ''}`),
      default: defaultBudget, group: 'tokens'
    };
  }
  return { properties };
}

export function pickerOption(options: NativeResponseOptions, key: 'reasoningEffort' | 'contextSize'): unknown {
  for (const carrier of [options.modelOptions, options.modelConfiguration, options.configuration]) {
    if (carrier === undefined || carrier === null) continue;
    const values = record(carrier);
    if (!values) throw new AppError('Invalid model configuration.');
    if (Object.hasOwn(values, key) && values[key] !== undefined) return values[key];
  }
  return undefined;
}
export function pickerEffort(options: NativeResponseOptions): unknown {
  const value = pickerOption(options, 'reasoningEffort');
  return value === 'inherit' ? undefined : value;
}
export function pickerInputBudget(model: ChatModel, options: NativeResponseOptions): number {
  const { max, defaultBudget } = contextBudgets(model);
  const value = pickerOption(options, 'contextSize');
  if (value === undefined) return defaultBudget;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1024 || value > max) {
    throw new AppError('The selected context budget is invalid or exceeds the current model input limit. Re-select a context size in the model menu.');
  }
  return value;
}

// Observe activation passively; do not activate Copilot, open a browser, or poll.
export function refreshNativePicker(refresh: () => void, signal: AbortSignal): vscode.Disposable {
  let done = false; let pending: ReturnType<typeof setImmediate> | undefined;
  const check = () => {
    if (!done && !signal.aborted && vscode.extensions.getExtension('github.copilot-chat')?.isActive) {
      done = true; refresh();
    }
  };
  const changed = () => {
    check();
    // Model registration can fire just before VS Code marks activation complete.
    // One deferred check per event handles that race without a polling loop.
    if (!done && !signal.aborted && pending === undefined) pending = setImmediate(() => { pending = undefined; check(); });
  };
  const subscription = vscode.lm.onDidChangeChatModels(changed);
  queueMicrotask(changed);
  return { dispose() { done = true; if (pending !== undefined) clearImmediate(pending); subscription.dispose(); } };
}
