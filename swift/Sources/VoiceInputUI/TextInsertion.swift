#if canImport(UIKit)
import UIKit
import VoiceInputCore

extension UITextView {
    public func insertVoiceText(_ text: String) {
        guard !text.isEmpty else { return }
        if markedTextRange != nil { unmarkText() }
        let range = selectedRange
        let parts = VoiceText.insertion(self.text ?? "", selectionStart: range.location, selectionEnd: NSMaxRange(range), text: text)
        insertText(parts.replacement)
        selectedRange = NSRange(location: range.location + parts.replacementCaret, length: 0)
        scrollRangeToVisible(selectedRange)
    }
}

extension UITextField {
    public func insertVoiceText(_ text: String) {
        guard !text.isEmpty else { return }
        if markedTextRange != nil { unmarkText() }
        let base = self.text ?? ""
        var start = (base as NSString).length
        var end = start
        if let selection = selectedTextRange {
            start = offset(from: beginningOfDocument, to: selection.start)
            end = offset(from: beginningOfDocument, to: selection.end)
        }
        let parts = VoiceText.insertion(base, selectionStart: start, selectionEnd: end, text: text)
        insertText(parts.replacement)
        if let caret = position(from: beginningOfDocument, offset: start + parts.replacementCaret) {
            selectedTextRange = textRange(from: caret, to: caret)
        }
    }
}
#endif
