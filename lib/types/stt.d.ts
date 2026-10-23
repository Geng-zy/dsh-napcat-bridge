import type { Component } from './components.js';
export interface SttSettings {
    mode: 'off' | 'command' | 'openai';
    command: string;
    apiUrl: string;
    apiKey: string;
    model: string;
}
type CallAction = (action: string, params: Record<string, unknown>) => Promise<any>;
/** 把一段语音转成文字；失败抛错。 */
export declare function transcribe(comp: Component, s: SttSettings, callAction: CallAction): Promise<string>;
export {};
