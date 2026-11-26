import Foundation

public enum FileVoiceStoreError: Error, Sendable {
    case invalidSession
}

public final class FileVoiceStore: VoiceStore, @unchecked Sendable {
    public static let framesPerChunk = 300
    public static let shared = FileVoiceStore(directory: defaultDirectory)

    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("VoiceInput", isDirectory: true)
    }

    public let directory: URL
    private let queue = DispatchQueue(label: "voice-input.file-store", qos: .userInitiated)
    private var rootReady = false
    private var checkedJournals: Set<String> = []

    public init(directory: URL) {
        self.directory = directory
    }

    public func append(_ session: String, _ record: JournalRecord) async throws {
        let line = try JSONEncoder().encode(record)
        try await perform { try self.appendLine(session, line) }
    }

    public func read(_ session: String) async throws -> [JournalRecord] {
        try await perform {
            let url = try self.folder(session, create: false).appendingPathComponent("journal.jsonl")
            guard let data = try? Data(contentsOf: url) else { return [] }
            let decoder = JSONDecoder()
            return data.split(separator: 0x0A).compactMap { try? decoder.decode(JournalRecord.self, from: Data($0)) }
        }
    }

    public func sessions() async throws -> [String] {
        try await perform {
            let names = (try? FileManager.default.contentsOfDirectory(atPath: self.directory.path)) ?? []
            return names.filter { name in
                var isDirectory: ObjCBool = false
                return Self.valid(name)
                    && FileManager.default.fileExists(atPath: self.directory.appendingPathComponent(name).path, isDirectory: &isDirectory)
                    && isDirectory.boolValue
            }.sorted()
        }
    }

    public func putFrames(_ session: String, first: Int, _ frames: [Data]) async throws {
        guard !frames.isEmpty else { return }
        try await perform { try self.writeFrames(session, first: first, frames) }
    }

    public func getFrames(_ session: String, from: Int, to: Int) async throws -> [Data] {
        try await perform { try self.readFrames(session, from: from, to: to) }
    }

    public func frameEnd(_ session: String) async throws -> Int {
        try await perform {
            let folder = try self.folder(session, create: false)
            guard let last = self.chunks(in: folder).max() else { return 0 }
            let size = (try? FileManager.default.attributesOfItem(atPath: self.chunkURL(folder, last).path)[.size] as? NSNumber)?.intValue ?? 0
            return last * Self.framesPerChunk + size / VoiceProtocol.frameBytes
        }
    }

    public func dropFrames(_ session: String, below: Int) async throws {
        try await perform {
            let folder = try self.folder(session, create: false)
            let limit = below / Self.framesPerChunk
            for chunk in self.chunks(in: folder) where chunk < limit {
                try? FileManager.default.removeItem(at: self.chunkURL(folder, chunk))
            }
        }
    }

    public func remove(_ session: String) async throws {
        try await perform {
            let folder = try self.folder(session, create: false)
            self.checkedJournals.remove(session)
            if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
        }
    }

    static func valid(_ session: String) -> Bool {
        let scalars = session.unicodeScalars
        guard (8...64).contains(scalars.count) else { return false }
        return scalars.allSatisfy { s in
            switch s {
            case "a"..."z", "A"..."Z", "0"..."9", "-": true
            default: false
            }
        }
    }

    private static var fileAttributes: [FileAttributeKey: Any]? {
        #if os(iOS)
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        nil
        #endif
    }

    private func perform<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try work() }) }
        }
    }

    private func folder(_ session: String, create: Bool) throws -> URL {
        guard Self.valid(session) else { throw FileVoiceStoreError.invalidSession }
        let url = directory.appendingPathComponent(session, isDirectory: true)
        if create {
            try prepareRoot()
            if !FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: Self.fileAttributes)
            }
        }
        return url
    }

    private func prepareRoot() throws {
        guard !rootReady else { return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: Self.fileAttributes)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var root = directory
        try? root.setResourceValues(values)
        rootReady = true
    }

    private func ensureFile(_ url: URL) {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil, attributes: Self.fileAttributes)
        }
    }

    private func appendLine(_ session: String, _ line: Data) throws {
        let url = try folder(session, create: true).appendingPathComponent("journal.jsonl")
        ensureFile(url)
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        var data = line
        data.append(0x0A)
        let end = try handle.seekToEnd()
        if end > 0 && !checkedJournals.contains(session) {
            try handle.seek(toOffset: end - 1)
            if try handle.read(upToCount: 1) != Data([0x0A]) { data.insert(0x0A, at: 0) }
            try handle.seekToEnd()
        }
        checkedJournals.insert(session)
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    private func chunkURL(_ folder: URL, _ chunk: Int) -> URL {
        folder.appendingPathComponent(String(format: "frames-%06d.pcm", chunk))
    }

    private func chunks(in folder: URL) -> [Int] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        return names.compactMap { name in
            guard name.hasPrefix("frames-"), name.hasSuffix(".pcm") else { return nil }
            return Int(name.dropFirst(7).dropLast(4))
        }
    }

    private func writeFrames(_ session: String, first: Int, _ frames: [Data]) throws {
        let folder = try folder(session, create: true)
        let per = Self.framesPerChunk
        let size = VoiceProtocol.frameBytes
        var index = first
        var i = 0
        while i < frames.count {
            let chunk = index / per
            let offset = index % per
            let count = min(per - offset, frames.count - i)
            var blob = Data(capacity: count * size)
            for frame in frames[i..<(i + count)] {
                if frame.count == size {
                    blob.append(frame)
                } else {
                    var fixed = frame.prefix(size)
                    if fixed.count < size { fixed.append(Data(count: size - fixed.count)) }
                    blob.append(fixed)
                }
            }
            let url = chunkURL(folder, chunk)
            ensureFile(url)
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset * size))
            try handle.write(contentsOf: blob)
            try handle.synchronize()
            index += count
            i += count
        }
    }

    private func readFrames(_ session: String, from: Int, to: Int) throws -> [Data] {
        guard to > from else { return [] }
        let folder = try folder(session, create: false)
        let per = Self.framesPerChunk
        let size = VoiceProtocol.frameBytes
        var out: [Data] = []
        var loaded: (chunk: Int, data: Data)?
        var index = max(0, from)
        while index < to {
            let chunk = index / per
            if loaded?.chunk != chunk {
                guard let data = try? Data(contentsOf: chunkURL(folder, chunk)) else { break }
                loaded = (chunk, data)
            }
            guard let data = loaded?.data else { break }
            let start = (index % per) * size
            guard data.count >= start + size else { break }
            out.append(data.subdata(in: (data.startIndex + start)..<(data.startIndex + start + size)))
            index += 1
        }
        return out
    }
}
