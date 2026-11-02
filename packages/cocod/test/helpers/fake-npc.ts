import { PaymentRequest } from '@cashu/cashu-ts';
import { verifyEvent, type Event } from 'nostr-tools';

import { startTcpTestServer } from './tcp.js';

/** External NPC HTTP boundary; the real plugin, SDK, signer, and Coco services run unchanged. */
export function startFakeNpc() {
  let name: string | undefined;
  let pubkey: string | undefined;
  let failInfo = false;
  const usernames: string[] = [];
  const token = crypto.randomUUID();
  const paymentRequest = new PaymentRequest([], 'npc-username', 21, 'sat', [
    'https://mint.example.com',
  ]).toEncodedRequest();
  const server = startTcpTestServer({
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/api/v2/auth/nip98' && request.method === 'GET') {
        const header = request.headers.get('authorization');
        if (!header?.startsWith('Nostr ')) return new Response(null, { status: 401 });
        const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString()) as Event;
        if (
          !verifyEvent(event) ||
          event.kind !== 27235 ||
          !event.tags.some(([key, value]) => key === 'u' && value === request.url) ||
          !event.tags.some(([key, value]) => key === 'method' && value === 'GET')
        ) {
          return new Response(null, { status: 401 });
        }
        pubkey = event.pubkey;
        return Response.json({ data: { token } });
      }
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        return new Response(null, { status: 401 });
      }
      if (path === '/api/v2/user/info' && request.method === 'GET') {
        return failInfo
          ? Response.json({ message: 'NPC unavailable' }, { status: 503 })
          : Response.json({ data: { user: { name, pubkey } } });
      }
      if (path === '/api/v2/user/username' && request.method === 'POST') {
        const { username } = (await request.json()) as { username: string };
        usernames.push(username);
        if (username === 'paid-name') {
          return Response.json(
            { message: 'Payment required' },
            { status: 402, headers: { 'X-Cashu': paymentRequest } },
          );
        }
        if (username === 'unavailable') {
          return Response.json({ message: 'Username unavailable' }, { status: 409 });
        }
        name = username;
        return Response.json({ data: {} });
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    url: server.url.origin,
    usernames,
    failInfo: () => {
      failInfo = true;
    },
    stop: () => server.stop(true),
  };
}
