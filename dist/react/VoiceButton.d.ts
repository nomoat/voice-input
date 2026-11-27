import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { type LivePanelProps } from './LivePanel.js';
import { type VoiceStrings } from './strings.js';
import { useVoiceInput, type VoiceInputConfig } from './useVoiceInput.js';
export interface VoiceButtonProps {
    config: VoiceInputConfig;
    strings?: VoiceStrings;
    anchor?: RefObject<HTMLElement | null>;
    className?: string;
    activeClassName?: string;
    style?: CSSProperties;
    disabled?: boolean;
    icon?: ReactNode;
    stopIcon?: ReactNode;
    size?: number;
    hotkeys?: VoiceButtonHotkeys;
}
export interface VoiceButtonHotkeys {
    focus?: () => void;
    scope?: RefObject<HTMLElement | null>;
}
export declare function MicIcon({ size }: {
    size?: number;
}): import("react").JSX.Element;
export declare function StopIcon({ size }: {
    size?: number;
}): import("react").JSX.Element;
export interface VoiceButtonHandlers {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
    onKeyUp: (e: ReactKeyboardEvent<HTMLElement>) => void;
    onContextMenu: (e: {
        preventDefault(): void;
    }) => void;
}
export declare function useVoiceButton(config: VoiceInputConfig, disabled?: boolean, hotkeys?: VoiceButtonHotkeys): {
    voice: {
        view: import("./useVoiceInput.js").VoiceInputView;
        active: boolean;
        begin: (mode: import("../client/session.js").VoiceMode) => import("../client/session.js").VoiceSession;
        finish: () => void | undefined;
        cancel: () => void;
        setMode: (mode: import("../client/session.js").VoiceMode) => void | undefined;
        armCancel: (armed: boolean) => void;
        close: () => void;
        session: RefObject<import("../client/session.js").VoiceSession | null>;
    };
    view: import("./useVoiceInput.js").VoiceInputView;
    active: boolean;
    handlers: VoiceButtonHandlers;
};
export interface VoicePanelPortalProps {
    voice: ReturnType<typeof useVoiceInput>;
    strings: VoiceStrings;
    anchor: RefObject<HTMLElement | null>;
    Button?: LivePanelProps['Button'];
}
export declare function VoicePanelPortal({ voice, strings, anchor, Button }: VoicePanelPortalProps): import("react").ReactPortal | null;
export declare function VoiceButton({ config, strings, anchor, className, activeClassName, style, disabled, icon, stopIcon, size, hotkeys }: VoiceButtonProps): import("react").JSX.Element;
