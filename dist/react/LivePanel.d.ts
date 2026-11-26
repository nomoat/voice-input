import { type ReactElement, type RefObject } from 'react';
import type { VoiceInputView } from './useVoiceInput.js';
import { type VoiceStrings } from './strings.js';
export interface LivePanelProps {
    view: VoiceInputView;
    strings: VoiceStrings;
    anchor: RefObject<HTMLElement | null>;
    onDone: () => void;
    onCancel: () => void;
    onClose: () => void;
    Button?: (props: {
        onClick: () => void;
        primary: boolean;
        children: string;
    }) => ReactElement;
}
export declare function LivePanel({ view, strings, anchor, onDone, onCancel, onClose, Button }: LivePanelProps): import("react").JSX.Element | null;
