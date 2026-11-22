import { expect, type Page } from '@playwright/test';

const unexpectedRequests = new WeakMap<Page, string[]>();

/** Block external calls unless a scenario installs an explicit mock. */
export async function mockClientBoundaries(page: Page) {
  const unexpected: string[] = [];
  unexpectedRequests.set(page, unexpected);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://localhost:1420') return route.continue();
    unexpected.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  await page.route('https://example.com/**', (route) => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />',
  }));
}

export function expectOnlyMockedCalls(page: Page) {
  expect(unexpectedRequests.get(page), 'unexpected Service/cloud calls').toEqual([]);
}

export interface MockFittingRoom {
  id: string;
  name?: string;
  /** The staged members the room detail returns; the summary's count follows them. */
  items?: unknown[];
}

/**
 * Issue 313 — the two reads every Fitting Room surface makes.
 *
 * `GET /fitting-rooms` is the creating read: it answers the caller's rooms with
 * the default first, and a suite that navigates to `/fitting-room` must mock it or
 * `expectOnlyMockedCalls` reports an unmocked Service call. `GET
 * /fitting-rooms/{id}` answers the open room's staged members.
 *
 * The route falls back for every other path, so it composes with the suite's own
 * handler whatever order the two are registered in.
 */
export async function mockFittingRoom(page: Page, room: MockFittingRoom) {
  const summary = {
    id: room.id,
    userId: 'test-user-id',
    name: room.name ?? 'Default Fitting Room',
    isDefault: true,
    itemCount: room.items?.length ?? 0,
    createdAt: '2026-05-01T00:00:00.000Z',
  };
  await page.route('http://localhost:3000/**', async (route, request) => {
    if (request.method() !== 'GET') return route.fallback();
    const path = new URL(request.url()).pathname;
    if (path === '/fitting-rooms') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ fittingRooms: [summary] }),
      });
    }
    if (path === `/fitting-rooms/${room.id}`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: summary.id,
          userId: summary.userId,
          name: summary.name,
          isDefault: summary.isDefault,
          itemCount: summary.itemCount,
          createdAt: summary.createdAt,
          items: room.items ?? [],
        }),
      });
    }
    return route.fallback();
  });
}
