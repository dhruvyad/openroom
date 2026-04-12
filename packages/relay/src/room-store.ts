// Typed wrapper around Cloudflare Durable Object storage for the openroom
// relay. See HIBERNATION.md for the overall architecture.
//
// Keys:
//   topic:<name>     -> TopicRecord
//   resource:<name>  -> ResourceRecord
//   msg:<ts>:<id>    -> MessageRecord
//
// Every stored value carries a `v` field so schema drift is detectable.
// If you add a new field, bump the version and handle the old version
// explicitly in `decodeTopic` / `decodeResource`.

const SCHEMA_VERSION = 1;
const TOPIC_KEY_PREFIX = 'topic:';
const RESOURCE_KEY_PREFIX = 'resource:';
const MESSAGE_KEY_PREFIX = 'msg:';
const MESSAGE_MAX_COUNT = 1000;

export interface TopicRecord {
    v: number;
    name: string;
    subscribeCap: string | null;
    postCap: string | null;
}

export interface ResourceRecord {
    v: number;
    name: string;
    cid: string;
    kind: string;
    mime: string;
    size: number;
    createdBy: string;
    createdAt: number;
    validationHook: string | null;
    content: Uint8Array;
}

export interface MessageRecord {
    v: number;
    type: 'message' | 'direct_message';
    envelope: unknown;
    at: number;
}

export interface RoomSnapshot {
    topics: TopicRecord[];
    resources: ResourceRecord[];
    messages: MessageRecord[];
}

export interface Logger {
    warn(event: string, fields: Record<string, unknown>): void;
    error(event: string, fields: Record<string, unknown>): void;
}

const noopLogger: Logger = {
    warn: () => {},
    error: () => {},
};

export class RoomStore {
    constructor(
        private storage: DurableObjectStorage,
        private logger: Logger = noopLogger
    ) {}

    /** Load every topic and resource in a single batch. Called from the DO
     *  constructor's async initialize() path on every wake. */
    async loadSnapshot(): Promise<RoomSnapshot> {
        const [topicEntries, resourceEntries, messageEntries] =
            await Promise.all([
                this.storage.list({ prefix: TOPIC_KEY_PREFIX }),
                this.storage.list({ prefix: RESOURCE_KEY_PREFIX }),
                this.storage.list({ prefix: MESSAGE_KEY_PREFIX }),
            ]);

        const topics: TopicRecord[] = [];
        for (const [key, raw] of topicEntries) {
            const decoded = this.decodeTopic(key, raw);
            if (decoded) topics.push(decoded);
        }

        const resources: ResourceRecord[] = [];
        for (const [key, raw] of resourceEntries) {
            const decoded = this.decodeResource(key, raw);
            if (decoded) resources.push(decoded);
        }

        const messages: MessageRecord[] = [];
        const badKeys: string[] = [];
        for (const [key, raw] of messageEntries) {
            const record = raw as Partial<MessageRecord>;
            if (!record || record.v !== SCHEMA_VERSION || typeof record.at !== 'number') {
                badKeys.push(key);
                continue;
            }
            messages.push(record as MessageRecord);
        }
        if (badKeys.length > 0) {
            this.storage.delete(badKeys).catch(() => {});
        }
        // Sort oldest-first and trim to cap
        messages.sort((a, b) => a.at - b.at);
        if (messages.length > MESSAGE_MAX_COUNT) {
            const excess = messages.splice(0, messages.length - MESSAGE_MAX_COUNT);
            const excessKeys = excess.map(
                (m) => `${MESSAGE_KEY_PREFIX}${m.at}:${(m.envelope as { id?: string })?.id ?? ''}`
            );
            this.storage.delete(excessKeys).catch(() => {});
        }

        return { topics, resources, messages };
    }

    async putTopic(record: Omit<TopicRecord, 'v'>): Promise<void> {
        const stored: TopicRecord = { v: SCHEMA_VERSION, ...record };
        await this.storage.put(TOPIC_KEY_PREFIX + record.name, stored);
    }

    async deleteTopic(name: string): Promise<void> {
        await this.storage.delete(TOPIC_KEY_PREFIX + name);
    }

    async putResource(record: Omit<ResourceRecord, 'v'>): Promise<void> {
        const stored: ResourceRecord = { v: SCHEMA_VERSION, ...record };
        await this.storage.put(RESOURCE_KEY_PREFIX + record.name, stored);
    }

    async deleteResource(name: string): Promise<void> {
        await this.storage.delete(RESOURCE_KEY_PREFIX + name);
    }

    async putMessage(record: Omit<MessageRecord, 'v'>): Promise<void> {
        const stored: MessageRecord = { v: SCHEMA_VERSION, ...record };
        const id = (record.envelope as { id?: string })?.id ?? '';
        await this.storage.put(
            `${MESSAGE_KEY_PREFIX}${record.at}:${id}`,
            stored
        );
    }

    /** For diagnostics / observability: total bytes currently stored across
     *  all resources. Used by the DO to emit `storage_bytes_used`. */
    storageBytesFrom(snapshot: RoomSnapshot): number {
        let total = 0;
        for (const r of snapshot.resources) total += r.size;
        return total;
    }

    private decodeTopic(key: string, raw: unknown): TopicRecord | null {
        if (!raw || typeof raw !== 'object') {
            this.logger.error('openroom.storage_decode_failed', {
                key,
                reason: 'not an object',
            });
            return null;
        }
        const record = raw as Partial<TopicRecord>;
        if (record.v !== SCHEMA_VERSION) {
            this.logger.error('openroom.schema_version_unknown', {
                key,
                type: 'topic',
                version: record.v,
            });
            return null;
        }
        if (
            typeof record.name !== 'string' ||
            (record.subscribeCap !== null &&
                typeof record.subscribeCap !== 'string') ||
            (record.postCap !== null && typeof record.postCap !== 'string')
        ) {
            this.logger.error('openroom.storage_decode_failed', {
                key,
                reason: 'topic shape mismatch',
            });
            return null;
        }
        return record as TopicRecord;
    }

    private decodeResource(
        key: string,
        raw: unknown
    ): ResourceRecord | null {
        if (!raw || typeof raw !== 'object') {
            this.logger.error('openroom.storage_decode_failed', {
                key,
                reason: 'not an object',
            });
            return null;
        }
        const record = raw as Partial<ResourceRecord>;
        if (record.v !== SCHEMA_VERSION) {
            this.logger.error('openroom.schema_version_unknown', {
                key,
                type: 'resource',
                version: record.v,
            });
            return null;
        }
        if (
            typeof record.name !== 'string' ||
            typeof record.cid !== 'string' ||
            typeof record.kind !== 'string' ||
            typeof record.mime !== 'string' ||
            typeof record.size !== 'number' ||
            typeof record.createdBy !== 'string' ||
            typeof record.createdAt !== 'number' ||
            !(record.content instanceof Uint8Array)
        ) {
            this.logger.error('openroom.storage_decode_failed', {
                key,
                reason: 'resource shape mismatch',
            });
            return null;
        }
        return record as ResourceRecord;
    }
}

export const STORAGE_SCHEMA_VERSION = SCHEMA_VERSION;
