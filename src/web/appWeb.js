const express = require('express')
const { randomBytes } = require('crypto')
const { DELETED_APP_RETENTION_DAYS: RETENTION_DAYS } = require('../user/app-retention')

function httpsUrl(value, originOnly = false) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password ||
        (originOnly && (url.pathname !== '/' || url.search || url.hash))) return ''
    return originOnly ? url.origin : url.href
  } catch (_) { return '' }
}

function readAppWebConfig(env = process.env) {
  const invalid = []
  const read = (key, validate = (value) => value) => {
    const raw = String(env[key] || '').trim()
    if (!raw) return ''
    const value = validate(raw)
    if (!value) invalid.push(key)
    return value || ''
  }
  const origin = read('INVITATION_ORIGIN', (value) => httpsUrl(value, true))
  const operatorName = read('APP_OPERATOR_NAME')
  const operatorWebsite = read('APP_OPERATOR_WEBSITE', (value) => httpsUrl(value))
  const supportEmail = read('APP_SUPPORT_EMAIL', (value) =>
    /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) && value)
  const policyEffectiveDate = read('APP_POLICY_EFFECTIVE_DATE', (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
    const date = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value
  })
  const appStoreUrl = read('APP_STORE_URL', (value) => {
    const safe = httpsUrl(value)
    if (!safe) return ''
    const url = new URL(safe)
    return url.hostname === 'apps.apple.com' && !url.port && /\/id\d+\/?$/.test(url.pathname) && safe
  })
  const googlePlayUrl = read('GOOGLE_PLAY_URL', (value) => {
    const safe = httpsUrl(value)
    if (!safe) return ''
    const url = new URL(safe)
    return url.hostname === 'play.google.com' && !url.port && url.pathname === '/store/apps/details' &&
      /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(url.searchParams.get('id') || '') && safe
  })
  const appleTeamId = read('APPLE_AUTH_TEAM_ID', (value) => /^[A-Z0-9]{10}$/.test(value) && value)
  const bundleKey = String(env.APPLE_BUNDLE_IDS || '').trim() ? 'APPLE_BUNDLE_IDS' : 'APPLE_CLIENT_ID'
  const appleBundleIds = read(bundleKey, (value) => {
    const entries = [...new Set(value.split(',').map((entry) => entry.trim()))]
    return entries.every((entry) => /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(entry)) && entries
  }) || []
  const packageKey = String(env.ANDROID_PACKAGE_NAME || '').trim() ? 'ANDROID_PACKAGE_NAME' : 'GOOGLE_STORE_PACKAGE_NAME'
  const androidPackageName = read(packageKey, (value) => /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(value) && value)
  const androidFingerprints = read('ANDROID_SHA256_CERT_FINGERPRINTS', (value) => {
    const entries = [...new Set(value.split(',').map((entry) => entry.trim().toUpperCase()))]
    return entries.every((entry) => /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(entry)) && entries
  }) || []
  const available = {
    INVITATION_ORIGIN: origin, APP_OPERATOR_NAME: operatorName, APP_SUPPORT_EMAIL: supportEmail,
    APP_POLICY_EFFECTIVE_DATE: policyEffectiveDate,
    APPLE_AUTH_TEAM_ID: appleTeamId, [bundleKey]: appleBundleIds.length,
    [packageKey]: androidPackageName, ANDROID_SHA256_CERT_FINGERPRINTS: androidFingerprints.length,
  }
  const status = (keys) => {
    const missing = keys.filter((key) => !available[key])
    return { configured: !missing.length, missing }
  }
  return {
    origin, operatorName, operatorWebsite, supportEmail, retentionDays: RETENTION_DAYS, policyEffectiveDate, appStoreUrl, googlePlayUrl,
    appleTeamId, appleBundleIds, androidPackageName, androidFingerprints, invalid,
    status: {
      invitation: status(['INVITATION_ORIGIN']),
      support: status(['APP_OPERATOR_NAME', 'APP_SUPPORT_EMAIL']),
      policy: status(['INVITATION_ORIGIN', 'APP_OPERATOR_NAME', 'APP_SUPPORT_EMAIL', 'APP_POLICY_EFFECTIVE_DATE']),
      appleAssociation: status(['INVITATION_ORIGIN', 'APPLE_AUTH_TEAM_ID', bundleKey]),
      androidAssociation: status(['INVITATION_ORIGIN', packageKey, 'ANDROID_SHA256_CERT_FINGERPRINTS']),
    },
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

// App-only English copy. Configured operator details and room codes remain untouched.
const copy = {
  brand: 'Who’s Undercover?',
  invitation: 'Join Lobby',
  invalidInvitation: 'Invalid invitation',
  support: 'Support & reports',
  deletion: 'Delete your account',
  privacy: 'Privacy policy',
  terms: 'Terms of use',
  unavailable: 'This page is unavailable. Try again later.',
  associationUnavailable: 'App link association is not configured yet.',
  copied: 'Room code copied.',
  copyFallback: 'Copy the selected room code using your device’s Copy option, then enter it in the app.',
}
const navigation = [
  ['/support', copy.support], ['/account-deletion', copy.deletion],
  ['/privacy', copy.privacy], ['/terms', copy.terms],
]

const css = `:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#10121b;color:#f5f1ec;font-size:100%}
*{box-sizing:border-box}body{margin:0;font-size:1rem;line-height:1.65}header,main,footer{width:100%;max-width:760px;margin:0 auto;padding-left:24px;padding-right:24px}
header{padding-top:32px;padding-bottom:24px}main{padding-top:16px;padding-bottom:40px}footer{padding-bottom:40px}
h1{font-size:2.5rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 24px;font-weight:700;text-wrap:balance}h2{font-size:1.25rem;line-height:1.4;margin:32px 0 12px}p{margin:0 0 16px}p,li,h1,h2,a{overflow-wrap:anywhere}li{padding-left:4px;margin-bottom:12px}ol{padding-left:24px}
a{color:#e6a080;text-underline-offset:4px}a:hover{text-decoration-thickness:2px}nav{display:flex;flex-wrap:wrap;gap:8px 24px;border-top:1px solid #30323f;padding-top:24px;font-size:.875rem}nav a{display:inline-flex;align-items:center;min-height:48px}nav a[aria-current="page"]{color:#f5f1ec;font-weight:600}
.brand{color:#e6a080;font-size:1rem;font-weight:700;line-height:1.4}.muted,.details{color:#b5b3c1}.details{border-left:3px solid #e6a080;padding:4px 0 4px 16px;margin-bottom:32px}.lead{color:#d8d5df;font-size:1.125rem}
.card{background:#1a1d28;border:1px solid #3c3e4c;border-radius:24px;padding:24px;margin:24px 0}.card p:last-child{margin-bottom:0}.room{font-size:2.5rem;line-height:1.3;letter-spacing:.125em;margin:12px 0 24px;font-variant-numeric:tabular-nums;font-weight:700}.eyebrow{font-size:.875rem;color:#b5b3c1}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.actions>*{flex:1 1 200px}button,.button{font:inherit;font-weight:600;line-height:1.5;display:inline-flex;align-items:center;justify-content:center;text-align:center;min-height:52px;max-width:100%;border:1px solid transparent;border-radius:16px;background:#e6a080;color:#291c18;padding:12px 20px;text-decoration:none;cursor:pointer;touch-action:manipulation}
button:hover,.button:hover{background:#f1b394;text-decoration:none}.button.secondary{background:#1a1d28;color:#f5f1ec;border-color:#565564}.button.secondary:hover{background:#282b38}button:focus-visible,a:focus-visible{outline:3px solid #dcc599;outline-offset:4px}.notice{white-space:pre-line}.copy-status{min-height:1.65em;margin-top:16px;font-size:.875rem}
.skip-link{position:absolute;left:16px;top:-100px;background:#e6a080;color:#291c18;padding:12px 20px;border-radius:12px}.skip-link:focus{top:8px}
@media(max-width:374px){header,main,footer{padding-left:16px;padding-right:16px}.card{padding:16px}h1{font-size:2rem}.room{font-size:1.75rem;letter-spacing:.025em}header{padding-top:24px}}`

function secureHeaders(res, nonce) {
  res.set({
    'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), clipboard-write=(self)',
    'Cache-Control': 'no-store',
  })
}

function page(res, title, body, { status = 200, script = '' } = {}) {
  const nonce = randomBytes(18).toString('base64')
  secureHeaders(res, nonce)
  const nav = navigation.map(([href, label]) => `<a href="${href}"${label === title ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`).join('')
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${copy.brand}</title><style nonce="${nonce}">${css}</style></head><body><a class="skip-link" href="#content">Skip to content</a><header><div class="brand">${copy.brand}</div></header><main id="content" tabindex="-1" aria-labelledby="page-title"><h1 id="page-title">${escapeHtml(title)}</h1>${body}</main><footer><nav aria-label="Support and policies">${nav}</nav></footer>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`)
}

function unavailable(res, title) {
  page(res, title, `<p class="lead">${copy.unavailable}</p>`, { status: 503 })
}

function retentionDisclosure() {
  return `<p>After account deletion, de-identified transaction records and transaction fingerprints are retained for ${RETENTION_DAYS} days for reconciliation, refund checks and prevention of duplicate processing.</p><p>Irreversible identity and account fingerprints, together with the deletion time, are also retained for ${RETENTION_DAYS} days. These prevent old platform credentials from recreating the account and confirm the outcome of repeated deletion requests. Deleted guest credentials are also rejected while their fingerprints are retained. These records are de-identified, but are not fully anonymous.</p><p>Both types of records are automatically removed ${RETENTION_DAYS} days after account deletion. After removal, old orders cannot recover the deleted account or transfer its VIP benefits to a new account. Store refunds must still be requested through the platform used for purchase.</p>`
}

function createAppWebRouter(config = readAppWebConfig()) {
  const router = express.Router()
  const email = () => `<a href="mailto:${escapeHtml(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>`

  router.get('/join/:roomId', (req, res) => {
    if (!/^\d{6}$/.test(req.params.roomId)) {
      return page(res, copy.invalidInvitation, '<p class="lead">Ask the Host for the six-digit room code, then enter it on the app’s Home screen.</p>', { status: 404 })
    }
    const links = [config.appStoreUrl && `<a class="button secondary" href="${escapeHtml(config.appStoreUrl)}" rel="noopener noreferrer">Get it on the App Store</a>`,
      config.googlePlayUrl && `<a class="button secondary" href="${escapeHtml(config.googlePlayUrl)}" rel="noopener noreferrer">Get it on Google Play</a>`].filter(Boolean)
    page(res, copy.invitation, `<p class="lead">A face-to-face party game. Enter this code on the app’s Home screen.</p><section class="card" aria-label="Room invitation"><div class="eyebrow">Room code</div><p class="room" data-room>${escapeHtml(req.params.roomId)}</p><button type="button" data-copy>Copy code</button><p class="muted copy-status" role="status" aria-live="polite" aria-atomic="true" data-copy-status></p></section><div class="actions">${links.join('')}</div>${links.length ? '<p class="muted">After installing, enter the room code manually to join.</p>' : '<p class="muted">Store downloads are unavailable. Already have the app? Enter the room code to join.</p>'}<p class="muted">The room may be full, in progress or closed. Open the app to check if you can join.</p>`, {
      script: `document.querySelector('[data-copy]').addEventListener('click',async()=>{const room=document.querySelector('[data-room]');const status=document.querySelector('[data-copy-status]');try{await navigator.clipboard.writeText(room.textContent);status.textContent=${JSON.stringify(copy.copied)};}catch{const selection=window.getSelection();const range=document.createRange();range.selectNodeContents(room);selection.removeAllRanges();selection.addRange(range);status.textContent=${JSON.stringify(copy.copyFallback)};}});`,
    })
  })

  router.get('/support', (req, res) => {
    if (!config.status.support.configured) return unavailable(res, copy.support)
    const website = config.operatorWebsite ? `<br><a href="${escapeHtml(config.operatorWebsite)}" rel="noopener noreferrer">Official website</a>` : ''
    page(res, copy.support, `<p class="details">Operated by ${escapeHtml(config.operatorName)}<br>Contact ${email()}${website}</p><h2>Game help & nickname reports</h2><p>Include the time, room code and relevant nicknames. Hide secret words, roles and unrelated personal information in screenshots. The Host can remove players from the Lobby.</p><h2>Purchases & orders</h2><p>Copy the order ID from the app’s VIP page. Email it with your purchase platform and a description of the issue. An order ID helps us find your order; it is not proof of payment.</p><p>Do not send login credentials, identity tokens, purchase tokens, full payment receipts or bank card details. We will never ask for these by email.</p><p>Apple or Google reviews store refund requests under its own rules. Contacting support or deleting your account does not request a refund. Use your purchase history or the store’s official support service to request one. We can help check whether VIP was credited in the app.</p><p><a href="/account-deletion">How to request account deletion</a></p>`)
  })

  router.get('/account-deletion', (req, res) => {
    if (!config.status.support.configured) return unavailable(res, copy.deletion)
    page(res, copy.deletion, `<p class="details">Operated by ${escapeHtml(config.operatorName)}</p><p class="lead">Open More in the app and choose Clear guest data or Delete account. Guest deletion does not require platform authorization. Inactive guest profiles are also removed after 180 days without activity when no active connection or room remains. If you cannot use the app, follow these steps to request deletion by email.</p><ol><li>Email ${email()} with the subject “Account deletion request”.</li><li>Include your sign-in platform (Apple or Google), or state that you are a guest, and your nickname in the app. A reason is optional. For purchase issues, you may include your order ID.</li><li>Support will reply with identity verification steps. Do not email passwords, login credentials or store purchase tokens.</li><li>After verifying your identity, support will process your request and email the result. Sending an email does not mean your account has been deleted. Reply to the same email to check progress.</li></ol><h2>What deletion means</h2><p>Your profile, sign-in links and remaining VIP benefits will no longer be available. Signing in again will not restore the deleted account. Deletion is not an Apple or Google store refund; request a refund separately under the store’s rules.</p><p>The app displays the result after you verify your identity and confirm deletion. Email requests require manual verification and do not count as completed in-app deletion.</p><h2>Data retained for seven days</h2>${retentionDisclosure()}`)
  })

  router.get('/privacy', (req, res) => {
    if (!config.status.policy.configured) return unavailable(res, copy.privacy)
    page(res, copy.privacy, `<p class="details">Operated by ${escapeHtml(config.operatorName)}<br>Effective date: ${escapeHtml(config.policyEffectiveDate)}<br>Contact ${email()}</p><h2>Account & game data</h2><p>Free play starts with a random guest credential generated and stored securely on your device. The server stores its hash to associate it with a guest account; we do not use a device ID as proof of identity. Guests can create and join rooms, edit a profile and browse VIP. Signing in with Apple or Google is required to purchase or restore purchases. When you sign in with Apple or Google, we verify the platform’s identity credentials and store account identifiers for sign-in, account recovery and purchase ownership. We do not ask for your platform password.</p><p>We store your app nickname, selected avatar and VIP expiry time. During a game, we process room membership, online status and the current round’s cards. Other players can see your nickname, avatar and VIP status. Each player’s secret word and role are sent only to that player.</p><h2>Purchases & recovery</h2><p>Apple or Google handles purchases. Our server verifies transactions and stores the app order ID, store transaction identifiers, product, environment, any supplied currency and amount, benefit periods, refund status and acknowledgement status. This supports delivery, recovery and refund checks, and prevents duplicate delivery. We do not receive bank card details.</p><h2>Device storage & network requests</h2><p>The app keeps login credentials in secure device storage. Regular storage holds necessary preferences, purchase recovery context and ad game-start counts by device date. Signing out clears local account state. Switching accounts does not reset the device’s ad count. Our network services handle requests needed for authentication, games and purchases. The app does not offer public chat or contact uploading.</p><h2>Third-party platforms & ads</h2><p>Apple and Google handle sign-in and store transactions under their own rules. If Google Mobile Ads is enabled in your version, ad requests depend on available configuration, VIP status and consent. Consent choices appear when required, and declining does not prevent free gameplay. See <a href="https://policies.google.com/technologies/ads" rel="noopener noreferrer">Google’s advertising privacy information</a> for how its ad services process data.</p><h2>Retention & deletion</h2><p>Guest profile data is removed after 180 days without activity once there is no active connection or room. Use Clear guest data in the app to remove it sooner. Reinstalling the app does not restore an old guest identity. When a guest signs in, the current player position and cards continue on the verified account; if that account is already in another game, the current guest game is kept and sign-in continuation stops. Profile data and sign-in links support your account. Signing out only clears local sign-in state. To delete your account, confirm in the app or complete identity verification through an <a href="/account-deletion">email deletion request</a>.</p>${retentionDisclosure()}<p>Financial records retained after deletion are not used to recreate accounts or grant benefits again. Contact the email address above for access, correction, deletion or privacy questions.</p>`)
  })

  router.get('/terms', (req, res) => {
    if (!config.status.policy.configured) return unavailable(res, copy.terms)
    page(res, copy.terms, `<p class="details">Operated by ${escapeHtml(config.operatorName)}<br>Effective date: ${escapeHtml(config.policyEffectiveDate)}</p><h2>Game service</h2><p>Create and join rooms, then deal secret cards for face-to-face play. Keep your room code private and do not expose secret words or roles to others. The Host can remove players. Use appropriate nicknames, do not impersonate others or use nicknames to harass them, and contact <a href="/support">Support & reports</a> if you need help.</p><h2>Accounts & devices</h2><p>You can play as a guest. Guest profiles are removed after 180 days without activity when no connection or room remains. Purchase and recovery require a supported Apple or Google identity that you are entitled to use. Signing in continues your guest game unless that account already occupies another game seat. Reinstalling does not recover guest data. A new connection on the same account may replace its earlier connection. Signing out on a device does not delete your account.</p><h2>VIP & store purchases</h2><p>Each VIP purchase adds 30 days of benefits and does not auto-renew. Availability and local pricing are shown in the app and the store’s purchase confirmation. You can still play free when purchases are unavailable. Once a purchase is verified, 30 days are added from the later of the confirmation time and your current expiry time.</p><p>After a purchase, you can restore the current account’s orders and remaining benefits. Apple or Google handles refunds under its own rules. A confirmed refund removes unused benefits from that order and adjusts later benefit periods. Time already used from other orders is not removed.</p><h2>Account deletion & support</h2><p>Deleting your account makes its profile and remaining VIP benefits unavailable. It does not request a store refund. Before confirming, read <a href="/account-deletion">the account deletion information</a> and <a href="/privacy">Privacy policy</a>. For help, contact ${email()}. Email deletion requests take effect only after identity verification and processing.</p>${retentionDisclosure()}`)
  })

  const association = (res, ready, body) => {
    secureHeaders(res, randomBytes(18).toString('base64'))
    if (!ready) return res.status(503).json({ error: { code: 'APP_WEB_NOT_CONFIGURED', message: copy.associationUnavailable } })
    return res.json(body)
  }
  router.get('/.well-known/apple-app-site-association', (req, res) => association(res,
    config.status.appleAssociation.configured, { applinks: { apps: [], details: config.appleBundleIds.map((bundleId) => ({
      appID: `${config.appleTeamId}.${bundleId}`, paths: ['/join/??????'],
    })) } }))
  router.get('/.well-known/assetlinks.json', (req, res) => association(res,
    config.status.androidAssociation.configured, [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
      namespace: 'android_app', package_name: config.androidPackageName, sha256_cert_fingerprints: config.androidFingerprints,
    } }]))
  router.use((error, req, res, next) => {
    if (error instanceof URIError && error.status === 400) {
      return page(res, copy.invalidInvitation, '<p class="lead">This link is invalid. Ask the Host for the six-digit room code, then enter it on the app’s Home screen.</p>', { status: 400 })
    }
    next(error)
  })
  return router
}

module.exports = { readAppWebConfig, createAppWebRouter }
