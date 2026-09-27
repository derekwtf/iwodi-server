# 本地 master 已存在的问题

## Socket 会话只凭客户端提供的 playerId 认领

`master` 的 `src/socket/index.js` 从 Socket.IO 握手的 `auth.playerId` 或 `query.playerId` 读取玩家 ID，并直接交给 `RoomManager.registerConnection`；连接后，房间操作使用该 ID。服务端没有校验本次 Socket 连接是否属于对应的微信用户。房间状态会向成员公开玩家 ID，因此获知 ID 的连接可以认领其他玩家的会话，读取重连快照并执行该玩家可执行的房间或游戏操作。

建议在 Socket 握手中验证由服务端签发、与微信身份绑定的凭证，再允许认领已有玩家会话；同时对匿名会话使用不可公开的凭证。此问题在本地 `master` 中已存在，应单独跟踪，不作为当前分支原有代码的回归。
