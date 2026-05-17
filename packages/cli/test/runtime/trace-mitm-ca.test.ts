/**
 * Local CA + leaf cert pool tests.
 *
 * We don't mock anything — we generate real RSA keys, sign real
 * certs, parse them back via Node's built-in X509Certificate, and
 * assert the extensions/SANs line up. The bar for "working" is
 * "Node can load the resulting PEMs into a `tls.Server` config
 * without complaint," which is what the MITM proxy actually does.
 */

import { createPrivateKey, X509Certificate } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCertPool, createTraceCa } from '../../src/runtime/trace/mitm/ca.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('createTraceCa', () => {
  it('generates a CA cert that Node can parse as X509', () => {
    const ca = createTraceCa();
    const x509 = new X509Certificate(ca.caCertPem);
    expect(x509.subject).toContain('CN=ac7 trace CA');
    expect(x509.issuer).toContain('CN=ac7 trace CA');
    // CA:TRUE basic constraint
    expect(x509.ca).toBe(true);
    expect(x509.validTo).toBeTruthy();
    // CA cert subject must match its own issuer (self-signed)
    expect(x509.subject).toBe(x509.issuer);
  });

  it('issues a CA valid for years — it cannot be rotated mid-session', () => {
    // NODE_EXTRA_CA_CERTS is read once at agent-child startup, so the
    // CA must outlive the longest runner process. A short window (the
    // old 24h) expired mid-session and broke every agent TLS handshake.
    const ca = createTraceCa();
    const x509 = new X509Certificate(ca.caCertPem);
    const lifespanMs = new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime();
    expect(lifespanMs).toBeGreaterThan(365 * DAY_MS);
  });

  it('produces a leaf private key PEM that Node accepts', () => {
    const ca = createTraceCa();
    // If the PEM is invalid, `createPrivateKey` throws.
    const key = createPrivateKey(ca.leafKeyPem);
    expect(key.type).toBe('private');
    expect(key.asymmetricKeyType).toBe('rsa');
  });
});

describe('createCertPool', () => {
  it('issues a leaf cert that Node can parse with a DNS SAN', () => {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const leaf = pool.issueLeaf('api.anthropic.com');
    const x509 = new X509Certificate(leaf.certPem);
    expect(x509.subject).toContain('CN=api.anthropic.com');
    expect(x509.ca).toBe(false);
    // SAN should include the hostname as a DNS name
    const sans = x509.subjectAltName ?? '';
    expect(sans).toContain('api.anthropic.com');
  });

  it('issues a leaf cert with an IP SAN for an IPv4 hostname', () => {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const leaf = pool.issueLeaf('127.0.0.1');
    const x509 = new X509Certificate(leaf.certPem);
    const sans = x509.subjectAltName ?? '';
    // X509Certificate.subjectAltName renders IP SANs as e.g. "IP Address:127.0.0.1"
    expect(sans).toMatch(/127\.0\.0\.1/);
  });

  it('caches leaves per hostname — second call returns the same cert PEM', () => {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const a = pool.issueLeaf('api.anthropic.com');
    const b = pool.issueLeaf('api.anthropic.com');
    expect(b.certPem).toBe(a.certPem);
  });

  it('re-issues a cached leaf once it nears expiry', () => {
    // The per-hostname cache would otherwise pin the first leaf for the
    // whole runner lifetime; a multi-day session would then serve an
    // expired leaf. issueLeaf re-signs as the cached one nears notAfter.
    vi.useFakeTimers();
    try {
      const start = new Date('2030-01-01T00:00:00Z');
      vi.setSystemTime(start);
      const ca = createTraceCa();
      const pool = createCertPool(ca);
      const first = pool.issueLeaf('api.anthropic.com');
      // Still fresh — cache hit, identical PEM.
      expect(pool.issueLeaf('api.anthropic.com').certPem).toBe(first.certPem);
      // Advance to within a day of the leaf's expiry → re-issue.
      vi.setSystemTime(new Date(start.getTime() + 90 * DAY_MS - 60 * 60 * 1000));
      const renewed = pool.issueLeaf('api.anthropic.com');
      expect(renewed.certPem).not.toBe(first.certPem);
      // The renewed leaf is valid well past the original's expiry.
      const x = new X509Certificate(renewed.certPem);
      expect(new Date(x.validTo).getTime()).toBeGreaterThan(start.getTime() + 90 * DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('issues distinct leaves for distinct hostnames', () => {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const a = pool.issueLeaf('api.anthropic.com');
    const b = pool.issueLeaf('console.anthropic.com');
    expect(a.certPem).not.toBe(b.certPem);
    const xa = new X509Certificate(a.certPem);
    const xb = new X509Certificate(b.certPem);
    expect(xa.subject).toContain('api.anthropic.com');
    expect(xb.subject).toContain('console.anthropic.com');
  });

  it('shares the same leaf private key across all issued leaves', () => {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const a = pool.issueLeaf('api.anthropic.com');
    const b = pool.issueLeaf('example.com');
    expect(b.keyPem).toBe(a.keyPem);
  });

  it('signs leaves with the CA key — Node X509 cert chain verifies', () => {
    const ca = createTraceCa();
    const pool = createCertPool(ca);
    const leaf = pool.issueLeaf('api.anthropic.com');
    const caCert = new X509Certificate(ca.caCertPem);
    const leafCert = new X509Certificate(leaf.certPem);
    // Leaf's issuer matches CA's subject.
    expect(leafCert.issuer).toBe(caCert.subject);
    // Leaf signature verifies against the CA public key.
    expect(leafCert.verify(caCert.publicKey)).toBe(true);
  });
});
