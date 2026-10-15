const { X509Certificate, verify } = require('crypto')

function invalid() {
  return Object.assign(new Error('Apple 商店签名验证失败'), { code: 'APP_STORE_PROOF_INVALID', statusCode: 400 })
}

// Read only the DER extension OIDs; matching raw certificate bytes could match a subject value instead.
function derNode(bytes, offset) {
  const tag = bytes[offset++]
  let length = bytes[offset++]
  if (length & 0x80) {
    const count = length & 0x7f
    if (count < 1 || count > 4 || offset + count > bytes.length) throw invalid()
    length = 0
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[offset++]
  }
  if (tag === undefined || !Number.isSafeInteger(length) || offset + length > bytes.length) throw invalid()
  return { tag, start: offset, end: offset + length }
}

function children(bytes, node) {
  const result = []
  let offset = node.start
  while (offset < node.end) {
    const child = derNode(bytes, offset)
    if (child.end > node.end) throw invalid()
    result.push(child)
    offset = child.end
  }
  return result
}

function hasExtension(certificate, oid) {
  const bytes = certificate.raw
  const tbs = children(bytes, derNode(bytes, 0))[0]
  const extensions = children(bytes, tbs).find((node) => node.tag === 0xa3)
  if (!extensions) return false
  const sequence = children(bytes, extensions)[0]
  return children(bytes, sequence).some((extension) => {
    const first = children(bytes, extension)[0]
    return first?.tag === 6 && bytes.subarray(first.start, first.end).toString('hex') === oid
  })
}

function verifyAppleSignedData(signedPayload, rootCertificates, now = Date.now()) {
  try {
    if (typeof signedPayload !== 'string' || signedPayload.length > 65_536) throw invalid()
    const parts = signedPayload.split('.')
    if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw invalid()
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url'))
    if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3 ||
        !Number.isSafeInteger(payload.signedDate) || payload.signedDate > now + 60_000 || payload.signedDate <= 0) throw invalid()
    const chain = header.x5c.map((pem) => new X509Certificate(Buffer.from(pem, 'base64')))
    const [leaf, intermediate, suppliedRoot] = chain
    const trustedRoot = rootCertificates.map((pem) => new X509Certificate(pem))
      .find((root) => root.raw.equals(suppliedRoot.raw))
    if (!trustedRoot || leaf.ca || !intermediate.ca || !trustedRoot.ca ||
        leaf.publicKey.asymmetricKeyType !== 'ec' || leaf.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
        !leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey) ||
        !intermediate.checkIssued(trustedRoot) || !intermediate.verify(trustedRoot.publicKey) ||
        !trustedRoot.verify(trustedRoot.publicKey) ||
        !hasExtension(leaf, '2a864886f76364060b01') || !hasExtension(intermediate, '2a864886f76364060201')) throw invalid()
    // Match Apple's documented offline verification mode: certificate validity at signedDate.
    // Root certificates must come from Apple PKI configuration; this is not an OCSP status check.
    for (const certificate of [leaf, intermediate, trustedRoot]) {
      if (Date.parse(certificate.validFrom) > payload.signedDate + 60_000 ||
          Date.parse(certificate.validTo) < payload.signedDate - 60_000) throw invalid()
    }
    if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'))) throw invalid()
    return payload
  } catch (_) { throw invalid() }
}

module.exports = { verifyAppleSignedData }
