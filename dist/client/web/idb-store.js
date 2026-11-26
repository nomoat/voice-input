const DB_NAME = 'voice-input';
const MAX = Number.MAX_SAFE_INTEGER;
function promised(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function done(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}
export class IndexedDbVoiceStore {
    name;
    factory;
    db;
    constructor(name = DB_NAME, factory = indexedDB) {
        this.name = name;
        this.factory = factory;
    }
    static available() {
        return typeof indexedDB !== 'undefined';
    }
    open() {
        this.db ??= new Promise((resolve, reject) => {
            const request = this.factory.open(this.name, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                db.createObjectStore('sessions');
                const journal = db.createObjectStore('journal', { autoIncrement: true });
                journal.createIndex('session', 'session');
                db.createObjectStore('frames');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return this.db;
    }
    async tx(stores, mode, work) {
        const db = await this.open();
        const tx = db.transaction(stores, mode, { durability: 'strict' });
        work(tx);
        await done(tx);
    }
    async append(session, record) {
        await this.tx(['sessions', 'journal'], 'readwrite', (tx) => {
            if (record.t === 'start')
                tx.objectStore('sessions').put({ at: record.at }, session);
            tx.objectStore('journal').add({ session, record });
        });
    }
    async read(session) {
        const db = await this.open();
        const rows = await promised(db.transaction('journal').objectStore('journal').index('session').getAll(session));
        return rows.map((r) => r.record);
    }
    async sessions() {
        const db = await this.open();
        const keys = await promised(db.transaction('sessions').objectStore('sessions').getAllKeys());
        return keys.map(String);
    }
    async putFrames(session, first, frames) {
        await this.tx(['frames'], 'readwrite', (tx) => {
            const store = tx.objectStore('frames');
            frames.forEach((frame, i) => store.put(frame.slice().buffer, [session, first + i]));
        });
    }
    async getFrames(session, from, to) {
        if (to <= from)
            return [];
        const db = await this.open();
        const store = db.transaction('frames').objectStore('frames');
        const keys = await promised(store.getAllKeys(IDBKeyRange.bound([session, from], [session, to - 1])));
        const values = await promised(store.getAll(IDBKeyRange.bound([session, from], [session, to - 1])));
        const out = [];
        for (let i = 0; i < keys.length; i++) {
            if (keys[i][1] !== from + i)
                break;
            out.push(new Uint8Array(values[i]));
        }
        return out;
    }
    async frameEnd(session) {
        const db = await this.open();
        const store = db.transaction('frames').objectStore('frames');
        const cursor = await promised(store.openKeyCursor(IDBKeyRange.bound([session, 0], [session, MAX]), 'prev'));
        if (!cursor)
            return 0;
        return cursor.key[1] + 1;
    }
    async dropFrames(session, below) {
        if (below <= 0)
            return;
        await this.tx(['frames'], 'readwrite', (tx) => {
            tx.objectStore('frames').delete(IDBKeyRange.bound([session, 0], [session, Math.min(MAX, below - 1)]));
        });
    }
    async remove(session) {
        await this.tx(['sessions', 'journal', 'frames'], 'readwrite', (tx) => {
            tx.objectStore('sessions').delete(session);
            tx.objectStore('frames').delete(IDBKeyRange.bound([session, 0], [session, MAX]));
            const index = tx.objectStore('journal').index('session');
            const request = index.openKeyCursor(IDBKeyRange.only(session));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor)
                    return;
                tx.objectStore('journal').delete(cursor.primaryKey);
                cursor.continue();
            };
        });
    }
}
