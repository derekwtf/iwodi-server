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
    origin, operatorName, supportEmail, retentionDays: RETENTION_DAYS, policyEffectiveDate, appStoreUrl, googlePlayUrl,
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

const css = `:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#10121b;color:#f5f1ec}
*{box-sizing:border-box}body{margin:0;line-height:1.75}main{max-width:720px;margin:0 auto;padding:48px 20px 64px}
h1{font-size:30px;line-height:1.3;margin:12px 0 28px}h2{font-size:20px;margin-top:30px}p,li{overflow-wrap:anywhere}
a{color:#e6a080;text-underline-offset:4px}nav{display:flex;flex-wrap:wrap;gap:16px;border-top:1px solid #30323f;margin-top:36px;padding-top:20px;font-size:14px}
.brand,.muted{color:#a5a4b1}.card{background:#1a1d28;border:1px solid #30323f;border-radius:20px;padding:24px;margin:24px 0}
.room{font-size:42px;letter-spacing:8px;margin:8px 0 20px;font-variant-numeric:tabular-nums}.actions{display:flex;gap:12px;flex-wrap:wrap}
button,.button{font:inherit;border:0;border-radius:12px;background:#d2603f;color:#fff;padding:12px 18px;text-decoration:none;cursor:pointer}
button:focus-visible,a:focus-visible{outline:3px solid #dcc599;outline-offset:4px}.notice{white-space:pre-line}
@media(max-width:360px){main{padding:30px 16px}.card{padding:18px}.room{font-size:36px;letter-spacing:6px}}`

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
  res.status(status).type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 奇乐谁是卧底</title><style nonce="${nonce}">${css}</style></head><body><main><div class="brand">奇乐谁是卧底</div><h1>${escapeHtml(title)}</h1>${body}<nav aria-label="支持与政策"><a href="/support">支持与举报</a><a href="/account-deletion">账号删除申请</a><a href="/privacy">隐私政策</a><a href="/terms">用户协议</a></nav></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`)
}

function unavailable(res, title) {
  page(res, title, '<p>此页面尚未配置完成，暂不对外提供。请稍后重试。</p>', { status: 503 })
}

function retentionDisclosure() {
  return `<p>账号删除后，去标识交易记录及交易指纹保留 ${RETENTION_DAYS} 天，用于对账、退款核对和防止重复处理。</p><p>不可逆的身份和账号指纹以及删除时间同样保留 ${RETENTION_DAYS} 天，用于拒绝删除前的旧平台证明重建账号，并确认重复删除请求的结果。上述保留记录已经去标识，但不属于完全匿名数据。</p><p>上述两类记录均在账号删除 ${RETENTION_DAYS} 天后自动清理。清理后，无法再凭旧订单找回已删除账号或向新账号认领原有 VIP 权益；商店退款仍需通过购买平台申请。</p>`
}

function createAppWebRouter(config = readAppWebConfig()) {
  const router = express.Router()
  const email = () => `<a href="mailto:${escapeHtml(config.supportEmail)}">${escapeHtml(config.supportEmail)}</a>`

  router.get('/join/:roomId', (req, res) => {
    if (!/^\d{6}$/.test(req.params.roomId)) {
      return page(res, '邀请链接无效', '<p>房间号应为六位数字。请向房主获取当前房间号，再到 App 首页输入。</p>', { status: 404 })
    }
    const links = [config.appStoreUrl && `<a class="button" href="${escapeHtml(config.appStoreUrl)}" rel="noopener noreferrer">前往 App Store</a>`,
      config.googlePlayUrl && `<a class="button" href="${escapeHtml(config.googlePlayUrl)}" rel="noopener noreferrer">前往 Google Play</a>`].filter(Boolean)
    page(res, '一起加入房间', `<p>打开 App，在首页输入下面的六位房间号。</p><section class="card" aria-label="房间邀请"><div>房间号</div><p class="room" data-room>${escapeHtml(req.params.roomId)}</p><button type="button" data-copy>复制房间号</button><p class="muted" role="status" aria-live="polite" data-copy-status></p></section><div class="actions">${links.join('')}</div>${links.length ? '<p class="muted">安装后请手动输入房间号。安装应用不会自动加入房间。</p>' : '<p class="muted">商店下载入口尚未提供；已安装 App 的玩家可直接输入房间号。</p>'}<p>此页面不检查房间是否仍可加入。房间可能已满、已开局或已关闭，实际结果以 App 内提示为准。</p>`, {
      script: `document.querySelector('[data-copy]').addEventListener('click',async()=>{const room=document.querySelector('[data-room]');const status=document.querySelector('[data-copy-status]');try{await navigator.clipboard.writeText(room.textContent);status.textContent='房间号已复制';}catch{const selection=window.getSelection();const range=document.createRange();range.selectNodeContents(room);selection.removeAllRanges();selection.addRange(range);status.textContent='请长按或使用系统复制，将选中的房间号复制后输入 App。';}});`,
    })
  })

  router.get('/support', (req, res) => {
    if (!config.status.support.configured) return unavailable(res, '支持与举报')
    page(res, '支持与举报', `<p>运营方：${escapeHtml(config.operatorName)}</p><p>请通过 ${email()} 联系我们。</p><h2>使用问题与昵称举报</h2><p>请说明问题发生时间、所在房间号和相关昵称；如有截图，请先遮住词卡、身份及其他不相关的个人信息。房主可在房间内移出玩家。</p><h2>购买与订单</h2><p>请在 App 的 VIP 页面复制业务订单号，并在邮件中附上订单号、购买平台和问题描述。订单号用于核对记录，不代表支付凭证。</p><p>不要发送登录凭证、身份令牌、purchase token、完整支付凭证或银行卡信息。我们不会通过邮件索取这些信息。</p><p>商店退款由 Apple 或 Google 按其规则审核；联系客服或删除账号不会自动申请退款。请在购买平台的订单记录或官方支持入口申请退款，我们可协助核对 App 内到账情况。</p><p><a href="/account-deletion">查看账号删除申请步骤</a></p>`)
  })

  router.get('/account-deletion', (req, res) => {
    if (!config.status.support.configured) return unavailable(res, '账号删除申请')
    page(res, '账号删除申请', `<p>运营方：${escapeHtml(config.operatorName)}</p><p>可在 App「更多」中发起账号删除；无法使用 App 时，可通过下述邮件流程申请。</p><ol><li>向 ${email()} 发送主题为「账号删除申请」的邮件。</li><li>说明登录平台（Apple 或 Google）、App 内昵称及申请原因（可选）。涉及购买时可附业务订单号。</li><li>客服将回复身份核对步骤；请勿在邮件中发送密码、登录凭证或商店 purchase token。</li><li>完成身份核对后，客服处理申请并通过邮件告知结果。发送邮件不代表账号已经删除；处理期间可回复原邮件查询进度。</li></ol><h2>删除的影响</h2><p>删除后原账号资料、登录关联及未到期权益不能继续使用，再次登录不会恢复原账号。删除不等于 Apple 或 Google 商店退款；请按商店规则另行申请。</p><p>App 内完成身份验证并确认删除后会显示处理结果。网页邮件申请需要人工核验，不能视为 App 内即时删除已完成。</p>${retentionDisclosure()}`)
  })

  router.get('/privacy', (req, res) => {
    if (!config.status.policy.configured) return unavailable(res, '隐私政策')
    page(res, '隐私政策', `<p>运营方：${escapeHtml(config.operatorName)}<br>生效日期：${escapeHtml(config.policyEffectiveDate)}<br>联系邮箱：${email()}</p><h2>账号与游戏数据</h2><p>使用 Apple 或 Google 登录时，我们验证平台提供的身份凭证并保存账号标识，用于登录、恢复账号和保护交易归属。我们不要求提供该平台密码。</p><p>我们保存 App 昵称、所选头像和 VIP 到期时间；游戏期间处理房间成员、在线状态和本局发牌信息。房间成员可看到昵称、头像和会员标识，每位玩家的词卡与身份只发送给本人。</p><h2>购买与恢复</h2><p>购买由 Apple 或 Google 商店处理。服务端验证交易，并保存业务订单号、商店交易标识、商品、环境、已提供的币种金额、发放区间、退款及确认状态，用于发货、恢复、退款核对和避免重复发货；我们不接收银行卡信息。</p><h2>设备存储与网络请求</h2><p>App 在设备安全存储中保存登录凭证；普通存储用于必要偏好、订单恢复上下文和按设备日期记录的广告开局计数。退出会清除本机账号状态；设备广告计数不因更换账号而重置。网络服务为完成认证、游戏和交易处理必要请求，不提供公开聊天或通讯录上传功能。</p><h2>第三方平台与广告</h2><p>Apple 和 Google 分别按其规则处理登录与商店交易。如果当前版本启用了 Google Mobile Ads，广告请求受可用配置、会员权益和同意状态控制；需要时提供同意选择，拒绝不影响免费游戏。广告服务的数据处理说明见 <a href="https://policies.google.com/technologies/ads" rel="noopener noreferrer">Google 广告隐私说明</a>。</p><h2>保留与删除</h2><p>账号资料和登录关联用于维持账号服务。退出仅清除本机登录状态；账号删除需在 App 内确认或通过 <a href="/account-deletion">网页邮件申请</a> 完成身份核验。</p>${retentionDisclosure()}<p>删除后保留的财务记录不用于重建账号或重新授予权益。关于访问、更正、删除或隐私问题，请通过上方邮箱联系我们。</p>`)
  })

  router.get('/terms', (req, res) => {
    if (!config.status.policy.configured) return unavailable(res, '用户协议')
    page(res, '用户协议', `<p>运营方：${escapeHtml(config.operatorName)}<br>生效日期：${escapeHtml(config.policyEffectiveDate)}</p><h2>游戏服务</h2><p>本 App 为线下聚会提供建房、加入和发牌功能。请妥善保管房间号，不向无关人员展示本局私密词卡或身份；房主可移出房间成员。请使用适当昵称，不冒用他人身份或以昵称骚扰他人，相关问题可通过 <a href="/support">支持与举报</a> 联系我们。</p><h2>账号与设备</h2><p>账号通过受支持的 Apple 或 Google 身份登录。请使用本人有权使用的账号；同一账号建立新连接可能替换原连接。退出本机不会自动删除账号。</p><h2>VIP 与商店购买</h2><p>VIP 为单次 30 天权益，不自动续费。可售状态和本地化价格以 App 与商店付款确认内容为准；未开放购买时仍可使用免费游戏。验证到账后，自确认时间与当前到期时间中较晚者增加 30 天。</p><p>购买成功后可恢复当前账号的订单与剩余权益。退款按 Apple 或 Google 商店规则处理，获确认的退款会撤回该笔订单尚未使用的权益并调整后续权益区间，不撤回其他订单已消费的时间。</p><h2>账号删除与支持</h2><p>删除将使原账号资料及未到期权益不可继续使用，不自动产生商店退款。确认前请阅读 <a href="/account-deletion">账号删除说明</a> 和 <a href="/privacy">隐私政策</a>；需要帮助请联系 ${email()}。网页邮件申请在完成身份核验与处理后才生效。</p>${retentionDisclosure()}`)
  })

  const association = (res, ready, body) => {
    secureHeaders(res, randomBytes(18).toString('base64'))
    if (!ready) return res.status(503).json({ error: { code: 'APP_WEB_NOT_CONFIGURED', message: '应用链接关联尚未配置完成' } })
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
      return page(res, '邀请链接无效', '<p>链接格式不正确。请向房主获取六位房间号，再到 App 首页输入。</p>', { status: 400 })
    }
    next(error)
  })
  return router
}

module.exports = { readAppWebConfig, createAppWebRouter }
