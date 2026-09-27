# 本地 master 已存在的问题

## Socket 会话只凭客户端提供的 playerId 认领

`master` 的 `src/socket/index.js` 从 Socket.IO 握手的 `auth.playerId` 或 `query.playerId` 读取玩家 ID，并直接交给 `RoomManager.registerConnection`；连接后，房间操作使用该 ID。服务端没有校验本次 Socket 连接是否属于对应的微信用户。房间状态会向成员公开玩家 ID，因此获知 ID 的连接可以认领其他玩家的会话，读取重连快照并执行该玩家可执行的房间或游戏操作。

建议在 Socket 握手中验证由服务端签发、与微信身份绑定的凭证，再允许认领已有玩家会话；同时对匿名会话使用不可公开的凭证。此问题在本地 `master` 中已存在，应单独跟踪，不作为当前分支原有代码的回归。

## 文档中的 30 秒断线离房未实际执行

`master` 的 `src/room/RoomManager.js` 定义了 `disconnectGraceMs` 和 `disconnectTimer`，但断线处理只标记玩家离线，没有启动移出房间的定时器。因此玩家不会在 30 秒后自动离房；只会在房间空闲或全员断线超时关闭时离房。`documents/PLAN/manager.md`、`documents/PLAN/06-联调与测试.md` 和 `documents/PRD/pages/05-投票页.md` 仍描述了 30 秒超时行为。

全流程模式下还有一个直接后果：`startGame` 按房间总人数开局，并将掉线玩家也放入存活玩家列表；发牌确认要求所有存活玩家确认。若开局时已有掉线成员，其他玩家全部确认后仍无法进入发言阶段，只能等待该成员重连后确认或离房，或等待房间超时关闭。`master` 的开局和确认逻辑已经如此。

建议确认产品需要的断线保留时长，并同步实现与文档；同时在开局前处理掉线成员，避免确认阶段停滞。此问题在本地 `master` 中已存在，不作为当前分支的回归。

## 仅发牌模式离房仍会触发胜负结算并公开牌面

核对基线：本地 `master`（`36da7503`）。`src/room/RoomManager.js` 的 `_resolveGameStateAfterLeave` 在检查 `deal-only` 模式前先调用 `Judge.checkGameOver`。四人仅发牌局中，唯一卧底离房就会将房间改为 `ended`，并通过 `getEndedPayload` 向剩余成员发送全部身份和双方词语；平民离房导致人数达到胜负条件时也会触发。已直接加载基线代码复现。

这与仅发牌模式由玩家在线下自行裁决的定义不一致。建议在执行胜负判定前处理仅发牌模式的离房状态同步。此问题已存在于基线，仅作提示，不影响当前分支合并。

## 全流程结束后离房可能改写已经确定的赢家

核对基线：本地 `master`（`36da7503`）。`src/room/RoomManager.js` 的 `_resolveGameStateAfterLeave` 在检查 `phase === 'ended'` 前重新判断存活人数并覆盖 `finalResult`。已通过基线的正常确认、投票和继续接口复现：卧底以一对一存活赢得对局后，卧底离房，剩余平民收到的赢家会变为 `civilian`。

建议终局后保留原结算结果，离房仅更新成员状态。此问题已存在于基线，仅作提示，不影响当前分支合并。

## 过期重连事件会清除客户端刚收到的新身份

服务端本地 `master`（`36da7503`）在未知 `playerId` 连接时，先发送带有新 ID 的 `connect:success`，再发送 `reconnect:expired`。关联客户端的本地 `master` 及当前代码中，`client/utils/socket.js` 的过期事件处理都会清除本地和 store 中的 `playerId`，但保留已经连接的 Socket。服务重启后携带旧 ID 重连即可进入该路径，造成客户端身份与服务端连接身份不一致。

建议明确区分旧房间恢复失败与当前连接身份失效，并保留服务端已分配的新身份。该事件顺序和客户端处理均已存在于基线，仅作提示，不影响当前分支合并。

## 玩家重连后的在线状态未主动广播给其他成员

核对基线：本地 `master`（`36da7503`）。`src/room/RoomManager.js` 的 `registerConnection` 会清除玩家的离线标记，但 `src/socket/index.js` 的连接处理只给重连者发送恢复快照，没有向房间其他成员广播新的房间状态；断线时则会广播离线状态。无后续房间事件或主动同步时，其他成员仍会显示该玩家暂时掉线。

当前关联客户端的 `client/utils/room-state-refresher.js` 已每 15 秒主动同步，可在下一次成功同步时修正显示，因此正常前台场景主要表现为短暂延迟。若需要实时恢复在线标记，可在恢复连接后复用房间状态广播。服务端的广播缺口已存在于基线，仅作提示，不影响当前分支合并。
