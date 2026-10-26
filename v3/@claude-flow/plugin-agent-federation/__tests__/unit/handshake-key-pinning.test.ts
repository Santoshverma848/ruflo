import { describe, expect, it } from 'vitest';
import { HandshakeService } from '../../src/domain/services/handshake-service.js';
import { FederationNode } from '../../src/domain/entities/federation-node.js';
import { TrustLevel } from '../../src/domain/entities/trust-level.js';

const PINNED = 'aa'.repeat(32);
const caps = { agentTypes: [], maxConcurrentSessions: 1, supportedProtocols: ['websocket'], complianceModes: [] };
const remote = () => FederationNode.create({ nodeId: 'peer', publicKey: '', endpoint: 'ws://peer:1', capabilities: caps });
let n = 0;
const service = (pins?: Record<string, string>) =>
  new HandshakeService({
    generateSessionId: () => `s-${++n}`, generateSessionToken: () => `t-${++n}`, generateNonce: () => `nonce-${++n}`,
    signChallenge: async () => 'sig', verifySignature: async () => true,
    ...(pins ? { pinnedKeyFor: (id: string) => pins[id] } : {}),
    getLocalNodeId: () => 'local', getLocalPublicKey: () => 'local-key', getLocalCapabilities: () => ['send'],
  });
const answer = async (svc: HandshakeService, node: FederationNode, publicKey: string) => {
  const challenge = await svc.initiateHandshake(node);
  return svc.verifyChallenge({ challengeId: challenge.challengeId, signedNonce: 'sig', publicKey, nodeId: 'peer', capabilities: ['send'] } as never, node);
};

describe('a handshake proves possession of a key, not who holds it', () => {
  it('attests a peer that answers with the key pinned for its node id', async () => {
    const node = remote();
    const result = await answer(service({ peer: PINNED }), node, PINNED);
    expect(result.success).toBe(true);
    expect(result.session!.trustLevel).toBe(TrustLevel.ATTESTED);
    expect(node.trustLevel).toBe(TrustLevel.ATTESTED);
  });

  it('refuses a peer that signs with a different key than the pinned one', async () => {
    const node = remote();
    const result = await answer(service({ peer: PINNED }), node, 'bb'.repeat(32));
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/pinned key/) });
    expect(node.trustLevel).toBe(TrustLevel.UNTRUSTED);
  });

  it('never attests a peer with no pinned key, whatever key it supplies', async () => {
    for (const svc of [service({}), service()]) {
      const node = remote();
      const result = await answer(svc, node, PINNED);
      expect(result.success).toBe(true);
      expect(result.pinned).toBe(false);
      expect(result.session!.trustLevel).toBe(TrustLevel.UNTRUSTED);
      expect(node.trustLevel).toBe(TrustLevel.UNTRUSTED);
    }
  });
});
