import Foundation

public enum VoiceGesture {
    public static let tapMs: Double = 350
    public static let slop: Double = 12
    public static let cancelDistance: Double = 65
}

public enum VoiceRelease: String, Sendable {
    case handsFree, finish, cancel
}

public struct PressTrack: Sendable, Equatable {
    public var downAt: Double
    public var x: Double
    public var y: Double
    public var moved: Bool
    public var cancelArmed: Bool

    public init(at: Double, x: Double, y: Double) {
        downAt = at
        self.x = x
        self.y = y
        moved = false
        cancelArmed = false
    }

    public func moved(x: Double, y: Double) -> PressTrack {
        var next = self
        next.moved = moved || hypot(x - self.x, y - self.y) > VoiceGesture.slop
        next.cancelArmed = self.y - y > VoiceGesture.cancelDistance
        return next
    }

    public func isHold(at: Double) -> Bool {
        at - downAt >= VoiceGesture.tapMs || moved
    }

    public func release(at: Double) -> VoiceRelease {
        if cancelArmed { return .cancel }
        if !isHold(at: at) { return .handsFree }
        return .finish
    }
}
