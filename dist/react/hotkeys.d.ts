import { type CSSProperties, type RefObject } from 'react';
import type { VoiceStrings } from './strings.js';
export interface VoiceHotkeysOptions {
    enabled: boolean;
    press: () => void;
    release: () => void;
    interrupt?: () => void;
    focus?: () => void;
    scope?: RefObject<HTMLElement | null>;
}
export declare function trackPointerFocus(): () => void;
export declare function focusTakesKeys(element: Element | null): boolean;
export declare function voiceKeysBlockedByDialog(scope?: HTMLElement | null): boolean;
export declare function useVoiceHotkeys(options: VoiceHotkeysOptions): void;
export declare function useKeyboardDevice(): boolean;
export declare function voiceKeyHintText(strings: VoiceStrings): string;
export interface VoiceKeyHintProps {
    strings: VoiceStrings;
    className?: string;
    keyClassName?: string;
    style?: CSSProperties;
    keyStyle?: CSSProperties;
}
export declare function VoiceKeyHint({ strings, className, keyClassName, style, keyStyle }: VoiceKeyHintProps): import("react").JSX.Element;
