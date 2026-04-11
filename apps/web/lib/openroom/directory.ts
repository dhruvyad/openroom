// Directory REST client. GETs /v1/public-rooms from the relay so the
// landing page can render a list of announced public rooms. The relay
// serves this endpoint with Cache-Control: public, max-age=30 so multiple
// viewers on the landing page share the edge cache and don't stampede
// the directory DO.

import type { AnnouncementSummary } from 'openroom-sdk';
import { relayHttpBase } from './config';

export interface PublicRoomsResponse {
    rooms: AnnouncementSummary[];
}

/**
 * Fetch the public rooms list from the directory endpoint. On the server,
 * Next.js's fetch cache may hold this further; pass `cache: 'no-store'`
 * to opt out when rendering a freshness-critical view.
 */
export async function fetchPublicRooms(
    options?: { signal?: AbortSignal; cache?: RequestCache }
): Promise<AnnouncementSummary[]> {
    const response = await fetch(`${relayHttpBase()}/v1/public-rooms`, {
        signal: options?.signal,
        cache: options?.cache,
    });
    if (!response.ok) {
        throw new Error(
            `public-rooms fetch failed: ${response.status} ${response.statusText}`
        );
    }
    const payload = (await response.json()) as PublicRoomsResponse;
    return payload.rooms ?? [];
}
