import { FRAME_MS } from '../protocol.js';
import { expired, summarize } from './journal.js';
export async function listDictations(store, options = {}) {
    const now = options.now ?? Date.now();
    const out = [];
    for (const session of await store.sessions()) {
        let summary;
        try {
            summary = summarize(await store.read(session));
        }
        catch {
            continue;
        }
        if (!summary) {
            await store.remove(session).catch(() => undefined);
            continue;
        }
        if (expired(summary, now)) {
            await store.remove(session).catch(() => undefined);
            continue;
        }
        if (summary.completedAt !== undefined && summary.insertedAt === undefined && summary.discardedAt === undefined && !summary.text.trim() && !summary.tidy?.trim()) {
            await store.remove(session).catch(() => undefined);
            continue;
        }
        if (options.target !== undefined && summary.target !== options.target)
            continue;
        const frames = await store.frameEnd(session).catch(() => 0);
        const durationMs = Math.max(summary.finishEndMs ?? 0, summary.contiguousEndMs, frames * FRAME_MS);
        const status = summary.insertedAt !== undefined ? 'inserted' : summary.discardedAt !== undefined ? 'discarded' : summary.completedAt !== undefined ? 'complete' : 'unfinished';
        const at = summary.insertedAt ?? summary.discardedAt ?? summary.completedAt ?? summary.finishedAt ?? summary.startedAt;
        const item = { session, target: summary.target, startedAt: summary.startedAt, durationMs, text: summary.text, status, at };
        if (summary.surface)
            item.surface = summary.surface;
        if (summary.tidy)
            item.tidy = summary.tidy;
        out.push(item);
    }
    return out.sort((a, b) => b.at - a.at);
}
export async function markDiscarded(store, session, now = Date.now()) {
    await store.append(session, { t: 'discarded', at: now });
    await store.dropFrames(session, Number.MAX_SAFE_INTEGER);
}
export async function markInserted(store, session, now = Date.now()) {
    await store.append(session, { t: 'inserted', at: now });
    await store.dropFrames(session, Number.MAX_SAFE_INTEGER);
}
