export class MemoryVoiceStore {
    journals = new Map();
    frames = new Map();
    async append(session, record) {
        const list = this.journals.get(session) ?? [];
        list.push(structuredClone(record));
        this.journals.set(session, list);
    }
    async read(session) {
        return structuredClone(this.journals.get(session) ?? []);
    }
    async sessions() {
        return [...this.journals.keys()];
    }
    async putFrames(session, first, frames) {
        const map = this.frames.get(session) ?? new Map();
        frames.forEach((f, i) => map.set(first + i, f.slice()));
        this.frames.set(session, map);
    }
    async getFrames(session, from, to) {
        const map = this.frames.get(session);
        const out = [];
        for (let i = from; i < to; i++) {
            const f = map?.get(i);
            if (!f)
                break;
            out.push(f.slice());
        }
        return out;
    }
    async frameEnd(session) {
        const map = this.frames.get(session);
        if (!map?.size)
            return 0;
        return Math.max(...map.keys()) + 1;
    }
    async dropFrames(session, below) {
        const map = this.frames.get(session);
        if (!map)
            return;
        for (const k of [...map.keys()])
            if (k < below)
                map.delete(k);
    }
    async remove(session) {
        this.journals.delete(session);
        this.frames.delete(session);
    }
}
