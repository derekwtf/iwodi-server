// Operational policy selected by the user; not a statement of statutory retention requirements.
const GUEST_RETENTION_DAYS = 180
const GUEST_RETENTION_MS = GUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000
const DELETED_APP_RETENTION_DAYS = 7
const DELETED_APP_RETENTION_MS = DELETED_APP_RETENTION_DAYS * 24 * 60 * 60 * 1000
const APP_PROOF_CLOCK_SKEW_MS = 60_000
// A proof already present at deletion can have an iat up to one minute in the future.
// Reserve that skew so it is necessarily expired when the deletion fingerprint is purged.
const MAX_APP_IDENTITY_PROOF_LIFETIME_MS = DELETED_APP_RETENTION_MS - APP_PROOF_CLOCK_SKEW_MS

module.exports = { GUEST_RETENTION_DAYS, GUEST_RETENTION_MS, DELETED_APP_RETENTION_DAYS, DELETED_APP_RETENTION_MS,
  APP_PROOF_CLOCK_SKEW_MS, MAX_APP_IDENTITY_PROOF_LIFETIME_MS }
