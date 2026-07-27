import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeConnectionOfferToUrl,
  parseConnectionOfferFromUrl,
  parseConnectionOffer,
  buildRelayWebSocketUrl,
  isOfferExpired,
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

  // C1: the optional pairingToken field round-trips through encode → parse and
  // is dropped when absent (no stray key on offers that omit it).
  it('round-trips an optional pairingToken field', () => {
    const withToken = { ...sampleOffer, pairingToken: 'tok_abc123' };
    const url = encodeConnectionOfferToUrl(withToken);
    const parsed = parseConnectionOfferFromUrl(url);
    assert.equal(parsed.pairingToken, 'tok_abc123');
  });

  it('omits pairingToken when not set on the source offer', () => {
    const parsed = parseConnectionOffer(sampleOffer);
    assert.equal('pairingToken' in parsed, false);
  });

  it('rejects an empty/non-string pairingToken when set', () => {
    assert.throws(
      () => parseConnectionOffer({ ...sampleOffer, pairingToken: '' }),
      /pairingToken/,
    );
    assert.throws(
      () => parseConnectionOffer({ ...sampleOffer, pairingToken: 42 }),
      /pairingToken/,
    );
  });

  // M-mr7: optional `exp` field round-trips and isOfferExpired checks it.
  it('round-trips an optional exp field and reports expiry', () => {
    const future = Date.now() + 60_000;
    const withExp = { ...sampleOffer, exp: future };
    const url = encodeConnectionOfferToUrl(withExp);
    const parsed = parseConnectionOfferFromUrl(url);
    assert.equal(parsed.exp, future);
    assert.equal(isOfferExpired(parsed), false);
    assert.equal(isOfferExpired({ ...parsed, exp: Date.now() - 1 }), true);
  });

  it('treats an offer without exp as never expired', () => {
    const parsed = parseConnectionOffer(sampleOffer);
    assert.equal('exp' in parsed, false);
    assert.equal(isOfferExpired(parsed), false);
  });

  it('rejects a non-positive/non-finite exp when set', () => {
    assert.throws(() => parseConnectionOffer({ ...sampleOffer, exp: 0 }), /exp/);
    assert.throws(() => parseConnectionOffer({ ...sampleOffer, exp: 'soon' }), /exp/);
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
