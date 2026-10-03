require('dotenv').config()
const UserStore = require('../src/user/UserStore')
const { readPaymentConfig } = require('../src/payment/config')
const { PaymentService, publicOrder } = require('../src/payment/PaymentService')

async function main() {
  const id = process.argv[2]
  if (!/^V[a-f0-9]{30}$/.test(id || '')) throw new Error('用法：node scripts/query-vip-order.js 业务订单号')
  const store = new UserStore(process.env.USER_DB_PATH)
  try {
    const service = new PaymentService({ userStore: store, config: readPaymentConfig() })
    const order = await service.reconcile(id, { force: true })
    console.log(JSON.stringify(publicOrder(order), null, 2))
  } finally { store.close() }
}
main().catch((error) => { console.error(error.code || error.message); process.exitCode = 1 })
