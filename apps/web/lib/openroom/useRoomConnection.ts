'use client';

// React hook that opens a BrowserClient on mount, joins a room in viewer
// mode, and exposes the rolling feed + room snapshot as reactive state.
// On unmount the client is left()'d so the relay sees a clean leave and
// prunes the viewer from the agent list. Everything the hook surfaces is
// derived from events the relay already sends; no extra RPCs.

import { useEffect, useRef, useState } from 'react';
import type {
    AgentSummary,
    DirectMessageEvent,
    MessageEvent,
    ResourceSummary,
    TopicSummary,
} from 'openroom-sdk';
import { BrowserClient } from './client';

export type ConnectionState =
    | 'connecting'
    | 'joined'
    | 'closed'
    | 'error';

/** One entry in the rolling feed. Unions broadcast messages and DMs into
 *  a single chronological list, so the viewer UI can render both inline
 *  without a second merging pass. */
export type FeedEntry =
    | { kind: 'message'; at: number; event: MessageEvent }
    | { kind: 'direct'; at: number; event: DirectMessageEvent };

export interface UseRoomConnectionResult {
    state: ConnectionState;
    error: string | null;
    feed: FeedEntry[];
    agents: AgentSummary[];
    topics: TopicSummary[];
    resources: ResourceSummary[];
}

export interface UseRoomConnectionOptions {
    /** Max entries retained in the feed. Older messages are dropped.
     *  Default 500 — enough for a few minutes of busy coordination. */
    feedLimit?: number;
    /** Override the relay URL. Normally left undefined. */
    relayUrl?: string;
}

const DEFAULT_FEED_LIMIT = 500;

export function useRoomConnection(
    room: string,
    options: UseRoomConnectionOptions = {}
): UseRoomConnectionResult {
    const [state, setState] = useState<ConnectionState>('connecting');
    const [error, setError] = useState<string | null>(null);
    const [feed, setFeed] = useState<FeedEntry[]>([]);
    const [agents, setAgents] = useState<AgentSummary[]>([]);
    const [topics, setTopics] = useState<TopicSummary[]>([]);
    const [resources, setResources] = useState<ResourceSummary[]>([]);

    const clientRef = useRef<BrowserClient | null>(null);
    const feedLimit = options.feedLimit ?? DEFAULT_FEED_LIMIT;

    useEffect(() => {
        // Guard against the hook being mounted in a non-browser context
        // (Next.js can still invoke effects once during hydration; the
        // component must be a Client Component so this branch is for
        // defensive runtime, not SSR).
        if (typeof window === 'undefined') return;

        let cancelled = false;
        setState('connecting');
        setError(null);
        setFeed([]);
        setAgents([]);
        setTopics([]);
        setResources([]);

        const appendFeed = (entry: FeedEntry) => {
            setFeed((prev) => {
                const next = prev.concat(entry);
                if (next.length > feedLimit) {
                    next.splice(0, next.length - feedLimit);
                }
                return next;
            });
        };

        const client = new BrowserClient({
            room,
            relayUrl: options.relayUrl,
            displayName: 'viewer',
            onMessage: (event) => {
                appendFeed({
                    kind: 'message',
                    at: event.envelope.ts,
                    event,
                });
            },
            onDirectMessage: (event) => {
                appendFeed({
                    kind: 'direct',
                    at: event.envelope.ts,
                    event,
                });
            },
            onAgentsChanged: (event) => {
                setAgents([...event.agents]);
            },
            onTopicChanged: () => {
                // Rebuild from the client's cached snapshot — cheap and
                // lets us stay authoritative even if events arrive out
                // of order after a reconnect.
                setTopics([...client.cachedTopics]);
            },
            onResourceChanged: () => {
                setResources([...client.cachedResources]);
            },
            onError: (reason) => {
                if (cancelled) return;
                setError(reason);
            },
        });
        clientRef.current = client;

        client
            .connect()
            .then(() => {
                if (cancelled) return;
                setAgents([...client.agents]);
                setTopics([...client.cachedTopics]);
                setResources([...client.cachedResources]);
                // Backfill the feed from the relay's history buffer
                // so late joiners don't stare at an empty room.
                const backfill: FeedEntry[] = [];
                for (const m of client.recentMessages) {
                    if (m.type === 'direct_message') {
                        backfill.push({
                            kind: 'direct',
                            at: m.envelope.ts,
                            event: {
                                type: 'direct_message',
                                room: client.room,
                                envelope: m.envelope,
                            } as unknown as DirectMessageEvent,
                        });
                    } else {
                        backfill.push({
                            kind: 'message',
                            at: m.envelope.ts,
                            event: {
                                type: 'message',
                                room: client.room,
                                envelope: m.envelope,
                            } as unknown as MessageEvent,
                        });
                    }
                }
                if (backfill.length > 0) {
                    setFeed((prev) => {
                        // Merge live events that may have arrived
                        // during connect() with the historical prefix.
                        const merged = backfill.concat(prev);
                        if (merged.length > feedLimit) {
                            merged.splice(0, merged.length - feedLimit);
                        }
                        return merged;
                    });
                }
                setState('joined');
            })
            .catch((err: Error) => {
                if (cancelled) return;
                setError(err.message);
                setState('error');
            });

        return () => {
            cancelled = true;
            try {
                client.leave();
            } catch {
                // ws may already be closing — fine to swallow
            }
            clientRef.current = null;
            setState('closed');
        };
    }, [room, feedLimit, options.relayUrl]);

    return { state, error, feed, agents, topics, resources };
}
