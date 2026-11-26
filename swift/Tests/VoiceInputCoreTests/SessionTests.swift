import Foundation
import Testing
@testable import VoiceInputCore

@Suite("session")
@MainActor
struct SessionTests {
    @Test func stopsAtTheLengthLimitAndKeepsTheText() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options(maxMs: 1500))
        await session.start(mode: .handsFree)
        await rig.settle(session)
        rig.socket.onOpen?()
        rig.socket.server(.ready(maxMs: 1500))
        rig.frames(30)
        #expect(session.state.stoppedBy == .limit)
        #expect(session.state.phase == .finishing)
        #expect(rig.socket.frames.count == 15)
        #expect(rig.socket.json.last?["endMs"] as? Int == 1500)
        rig.socket.server(.commit(seg: 0, text: "fifteen frames", startMs: 0, endMs: 1500))
        rig.socket.server(.done(nextSeg: 1))
        #expect(await session.result?.text == "fifteen frames")
    }

    @Test func finishesHandsFreeAfterLongSilence() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options(silenceFinishMs: 500))
        await session.start(mode: .handsFree)
        rig.frames(3)
        rig.frames(17, amplitude: 0)
        #expect(session.state.stoppedBy == .silence)
        #expect(session.state.elapsedMs == 800)
    }

    @Test func holdIgnoresSilence() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options(silenceFinishMs: 500))
        await session.start(mode: .hold)
        rig.frames(20, amplitude: 0)
        #expect(session.state.phase == .recording)
        #expect(session.state.silenceMs == 2000)
    }

    @Test func partialFramesArePaddedOnFinish() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .hold)
        rig.sink?.samples(Array(repeating: 3000, count: 2000))
        #expect(session.state.elapsedMs == 100)
        session.finish()
        #expect(session.state.elapsedMs == 200)
        await rig.settle(session)
        let frames = await rig.store.getFrames(session.id, from: 0, to: 10)
        #expect(frames.count == 2)
        #expect(frames.allSatisfy { $0.count == VoiceProtocol.frameBytes })
        let tail = frames[1].withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        #expect(tail[399] == 3000)
        #expect(tail[400] == 0)
    }

    @Test func microphoneFailureLeavesNothingBehind() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options(capture: { _ in throw VoiceCaptureError.permissionDenied }))
        await session.start(mode: .hold)
        #expect(session.state.phase == .failed)
        #expect(session.state.failure == .microphone)
        await rig.settle(session)
        #expect(await rig.store.sessions().isEmpty)
        #expect(await session.result == nil)
    }

    @Test func releaseBeforeTheMicrophoneStartsEndsEmpty() async throws {
        let rig = Rig()
        let gate = Gate()
        let capture = FakeCapture()
        let session = VoiceSession(options: rig.options(capture: { _ in
            await gate.wait()
            return capture
        }))
        let started = Task { await session.start(mode: .hold) }
        await Task.yield()
        session.finish()
        gate.open()
        await started.value
        #expect(await session.result?.text == "")
        #expect(capture.stopped)
    }

    @Test func threeRefusedTicketsFailAsUnauthorized() async throws {
        let rig = Rig()
        rig.endpointError = VoiceEndpointError.unauthorized
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .handsFree)
        await rig.settle(session)
        #expect(session.state.connection == .offline)
        rig.clock.advance(by: 10_000)
        await rig.settle(session)
        rig.clock.advance(by: 10_000)
        await rig.settle(session)
        #expect(session.state.phase == .failed)
        #expect(session.state.failure == .unauthorized)
        #expect(rig.sockets.isEmpty)
    }

    @Test func refusedTicketFailsAtOnceAndKeepsTheDictation() async throws {
        let rig = Rig()
        rig.endpointError = VoiceEndpointError.refused
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .handsFree)
        rig.frames(3)
        await rig.settle(session)
        #expect(session.state.phase == .failed)
        #expect(session.state.failure == .rejected)
        #expect(rig.sockets.isEmpty)
        rig.clock.advance(by: 20_000)
        await rig.settle(session)
        #expect(rig.sockets.isEmpty)
        let summary = VoiceJournal.summarize(await rig.store.journal(session.id))
        #expect(summary != nil)
        #expect(summary?.discardedAt == nil)
    }

    @Test func reconnectBacksOff() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .handsFree)
        await rig.settle(session)
        var delays: [Int] = []
        for _ in 0..<7 {
            let before = rig.sockets.count
            rig.socket.onClose?()
            let start = rig.clock.time
            var waited = 0
            while rig.sockets.count == before && waited <= 10_000 {
                rig.clock.advance(by: 100)
                waited += 100
                await rig.settle(session)
            }
            delays.append(rig.clock.time - start)
        }
        #expect(delays == [500, 1000, 2000, 4000, 8000, 10_000, 10_000])
        session.abandon()
    }

    @Test func connectTimeoutDrops() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .handsFree)
        await rig.settle(session)
        rig.socket.onOpen?()
        rig.clock.advance(by: 10_000)
        #expect(session.state.connection == .offline)
        #expect(rig.sockets[0].closed)
        session.abandon()
    }

    @Test func restoresAnAbandonedSessionFromTheJournalAndSpool() async throws {
        let rig = Rig()
        let first = VoiceSession(options: rig.options())
        await first.start(mode: .handsFree)
        await rig.settle(first)
        rig.socket.onOpen?()
        rig.socket.server(.ready(maxMs: 1_200_000))
        rig.frames(25)
        rig.socket.server(.commit(seg: 0, text: "one", startMs: 0, endMs: 1000))
        rig.socket.server(.commit(seg: 2, text: "three", startMs: 2000, endMs: 2500))
        rig.frames(8)
        first.abandon()
        await first.flushed()

        let pending = await listDictations(rig.store, target: "t", now: rig.clock.now())
        #expect(pending.map(\.status) == [.unfinished])
        #expect(pending.first?.durationMs == 3300)
        #expect(pending.first?.text == "one")

        let restored = try #require(await VoiceSession.restore(first.id, options: rig.options()))
        #expect(restored.state.mode == .restore)
        #expect(restored.state.phase == .pending)
        await rig.settle(restored)
        rig.socket.onOpen?()
        let start = try #require(rig.socket.json.first)
        #expect(start["type"] as? String == "start")
        #expect(start["fromMs"] as? Int == 1000)
        #expect(start["nextSeg"] as? Int == 1)
        #expect(start["token"] as? String == "t")
        rig.socket.server(.ready(maxMs: 1_200_000))
        #expect(restored.state.phase == .finishing)
        #expect(rig.socket.frames.count == 23)
        #expect(rig.socket.json.last?["type"] as? String == "finish")
        #expect(rig.socket.json.last?["endMs"] as? Int == 3300)
        rig.socket.server(.commit(seg: 1, text: "two three four", startMs: 1000, endMs: 3300))
        rig.socket.server(.done(nextSeg: 2))
        #expect(await restored.result?.text == "one two three four")
        let kinds = await rig.store.journal(first.id).map(\.kind)
        #expect(kinds == ["start", "commit", "commit", "finish", "rewind", "commit", "complete"])
    }

    @Test func restoreOfACompleteSessionNeedsNoServer() async throws {
        let rig = Rig()
        let id = "abcdef12-0000-4000-8000-000000000001"
        await rig.store.append(id, .start(session: id, target: "t", surface: nil, languages: ["en"], at: 1))
        await rig.store.append(id, .commit(CommittedSegment(seg: 0, text: "hello", startMs: 0, endMs: 500)))
        await rig.store.append(id, .finish(endMs: 500, at: 2))
        await rig.store.append(id, .complete(at: 3))
        let restored = try #require(await VoiceSession.restore(id, options: rig.options()))
        #expect(await restored.result?.text == "hello")
        #expect(rig.sockets.isEmpty)
    }

    @Test func markInsertedDropsFramesAndKeepsTheRecord() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .hold)
        await rig.settle(session)
        rig.socket.onOpen?()
        rig.socket.server(.ready(maxMs: 1_200_000))
        rig.frames(7)
        session.finish()
        rig.socket.server(.commit(seg: 0, text: "hi", startMs: 0, endMs: 700))
        rig.socket.server(.done(nextSeg: 1))
        #expect(await session.result?.text == "hi")
        await session.markInserted()
        #expect(await rig.store.frameCount(session.id) == 0)
        let all = await listDictations(rig.store, now: rig.clock.now())
        #expect(all.first?.status == .inserted)
        let later = await listDictations(rig.store, now: rig.clock.now() + VoiceJournal.insertedKeepMs + 1)
        #expect(later.isEmpty)
        #expect(await rig.store.sessions().isEmpty)
    }

    @Test func cancelKeepsADiscardedRecordForADay() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .hold)
        rig.frames(5)
        session.cancel()
        #expect(await session.result == nil)
        await session.flushed()
        #expect(await listDictations(rig.store, now: rig.clock.now()).first?.status == .discarded)
        #expect(await listDictations(rig.store, now: rig.clock.now() + VoiceJournal.discardedKeepMs + 1).isEmpty)
    }

    @Test func interruptionPausesAndResumes() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        await session.start(mode: .handsFree)
        rig.frames(2)
        rig.sink?.interrupted()
        #expect(session.state.phase == .paused)
        rig.frames(3)
        #expect(session.state.elapsedMs == 200)
        rig.sink?.resumed()
        #expect(session.state.phase == .recording)
        rig.frames(1)
        #expect(session.state.elapsedMs == 300)
        session.finish()
        #expect(session.state.phase == .pending)
        session.abandon()
    }

    @Test func subscribersSeeEachChangeOnce() async throws {
        let rig = Rig()
        let session = VoiceSession(options: rig.options())
        var phases: [VoicePhase] = []
        let subscription = session.subscribe { phases.append($0.phase) }
        await session.start(mode: .hold)
        rig.frames(2)
        session.cancel()
        subscription.cancel()
        #expect(phases.reduce(into: [VoicePhase]()) { if $0.last != $1 { $0.append($1) } } == [.starting, .recording, .cancelled])
        #expect(VoiceSession.running(session.id) == nil)
    }
}

@MainActor
final class Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters = []
        for waiter in pending { waiter.resume() }
    }
}
