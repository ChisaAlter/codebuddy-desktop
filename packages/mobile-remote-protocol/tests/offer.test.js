import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeConnectionOfferToUrl,
  parseConnectionOfferFromUrl,
  parseConnectionOffer,
  buildRelayWebSocketUrl,
  PROTOCOL_VERSION,
} from '../src/index.js';

const sampleOffer = {
  v: 1,
  serverId: 'srv_test123',
  hostPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  relayAuthPublicKeyB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  relay: { endpoint: 'remote.example.com:443', useTls: true },
};

describe('connection offer', () => {
  it('round-trips via URL fragment', () => {
    const url = encodeConnectionOfferToUrl(sampleOffer);
    assert.match(url, /#offer=/);
    const parsed = parseConnectionOfferFromUrl(url);
    assert.deepEqual(parsed, parseConnectionOffer(sampleOffer));
  });

  it('rejects wrong version', () => {
    assert.throws(() => parseConnectionOffer({ ...sampleOffer, v: 2 }), /version/);
  });

  it('returns null without offer fragment', () => {
    assert.equal(parseConnectionOfferFromUrl('https://example.com/'), null);
  });
});

describe('relay url', () => {
  it('builds wss server url', () => {
    const url = buildRelayWebSocketUrl({
      endpoint: 'remote.example.com:443',
      useTls: true,
      serverId: 'srv_x',
      role: 'server',
    });
    assert.equal(
      url,
      'wss://remote.example.com:443/ws?v=1&serverId=srv_x&role=server',
    );
  });

  it('builds ws client url with connectionId', () => {
    const url = buildRelayWebSocketUrl({
      endpoint: '127.0.0.1:8787',
      useTls: false,
      serverId: 'srv_x',
      role: 'client',
      connectionId: 'c1',
    });
    assert.ok(url.startsWith('ws://127.0.0.1:8787/ws?'));
    assert.ok(url.includes('connectionId=c1'));
  });
});

describe('protocol version', () => {
  it('is 1', () => {
    assert.equal(PROTOCOL_VERSION, 1);
  });
});
