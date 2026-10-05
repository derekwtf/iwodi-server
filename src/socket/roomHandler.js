const EVENTS = require('./events')
const { emitPlayerLeftSequence, publishLeaveResult } = require('./emitPatterns')
const { handleError, handleSuccess } = require('./helpers')

function registerRoomHandlers(io, socket, roomManager, getRoomChannel) {
  socket.on(EVENTS.client.ROOM_CREATE, (payload = {}, ack) => {
    try {
      const result = roomManager.createRoom({
        playerId: socket.data.playerId,
        ...socket.data.profile,
        playMode: payload.playMode,
      })

      if (result.previousRoomResult) {
        publishLeaveResult(io, socket, getRoomChannel, result.previousRoomResult)
      }

      const roomChannel = getRoomChannel(result.room.id)
      const roomState = roomManager.getRoomState(result.room.id)
      socket.join(roomChannel)
      socket.emit(EVENTS.server.ROOM_CREATED, { room: roomState })

      handleSuccess(ack, { room: roomState })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_CREATE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_JOIN, (payload = {}, ack) => {
    try {
      const roomId = String(payload.roomId || '')
      const result = roomManager.joinRoom(roomId, {
        playerId: socket.data.playerId,
        ...socket.data.profile,
      })

      if (result.previousRoomResult) {
        publishLeaveResult(io, socket, getRoomChannel, result.previousRoomResult)
      }

      const roomChannel = getRoomChannel(result.room.id)
      const roomState = roomManager.getRoomState(result.room.id)
      socket.join(roomChannel)

      socket.emit(EVENTS.server.ROOM_JOINED, { room: roomState })
      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, { room: roomState })

      if (!result.alreadyInRoom) {
        socket.to(roomChannel).emit(EVENTS.server.ROOM_PLAYER_JOINED, {
          player: result.player,
          room: roomState,
        })
      }

      handleSuccess(ack, { room: roomState })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_JOIN, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_LEAVE, (payload = {}, ack) => {
    try {
      const roomId = roomManager.getRoomIdForPlayer(socket.data.playerId)
      if (!roomId) {
        handleSuccess(ack, { roomId: null })
        return
      }

      const result = roomManager.leaveRoom(roomId, socket.data.playerId, {
        reason: 'leave',
      })
      publishLeaveResult(io, socket, getRoomChannel, result || { roomId }, {
        notifyLeaver: true,
      })

      handleSuccess(ack, {
        roomId,
        room: result ? result.roomState : null,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_LEAVE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_HEARTBEAT, (payload = {}, ack) => {
    try {
      const result = roomManager.heartbeat(socket.data.playerId)
      handleSuccess(ack, {
        roomId: result.room.id,
        status: result.status,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_HEARTBEAT, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_SYNC_STATE, (payload = {}, ack) => {
    try {
      const result = roomManager.getSyncState(socket.data.playerId)
      handleSuccess(ack, result)
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_SYNC_STATE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_KEEP_ALIVE, (payload = {}, ack) => {
    try {
      const result = roomManager.keepAlive(socket.data.playerId)
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.ROOM_IDLE_RESUMED, {
        roomId: result.room.id,
        status: result.status,
      })

      handleSuccess(ack, {
        roomId: result.room.id,
        status: result.status,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_KEEP_ALIVE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_SET_PLAY_MODE, (payload = {}, ack) => {
    try {
      const result = roomManager.setPlayMode(socket.data.playerId, payload.playMode)
      io.to(getRoomChannel(result.room.id)).emit(EVENTS.server.ROOM_STATE, { room: result.roomState })
      handleSuccess(ack, { room: result.roomState })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_SET_PLAY_MODE, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_SET_SPY_COUNT, (payload = {}, ack) => {
    try {
      const result = roomManager.setSpyCount(
        socket.data.playerId,
        payload.spyCount
      )
      const roomChannel = getRoomChannel(result.room.id)

      io.to(roomChannel).emit(EVENTS.server.ROOM_SPY_COUNT_CHANGED, {
        spyCount: result.spyCount,
        room: result.roomState,
      })
      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })

      handleSuccess(ack, {
        room: result.roomState,
        spyCount: result.spyCount,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_SET_SPY_COUNT, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_KICK_PLAYER, (payload = {}, ack) => {
    try {
      const targetPlayerId = String(payload.playerId || '')
      const targetSocketId = roomManager.getActiveSocketId(targetPlayerId)
      const result = roomManager.kickPlayer(socket.data.playerId, targetPlayerId)
      const roomChannel = getRoomChannel(result.roomId)

      if (targetSocketId) {
        const targetSocket = io.sockets.sockets.get(targetSocketId)
        if (targetSocket) {
          targetSocket.leave(roomChannel)
        }
        io.to(targetSocketId).emit(EVENTS.server.ROOM_LEFT, {
          roomId: result.roomId,
          reason: 'kick',
        })
      }

      emitPlayerLeftSequence(io, roomChannel, {
        removedPlayer: result.removedPlayer,
        roomState: result.roomState,
        hostChanged: result.hostChanged,
        reason: result.reason,
      })

      handleSuccess(ack, {
        room: result.roomState,
        player: result.removedPlayer,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.ROOM_KICK_PLAYER, ack, error)
    }
  })

  socket.on(EVENTS.client.ROOM_START_GAME, (payload = {}, ack) => {
    try {
      const result = roomManager.startGame(socket.data.playerId, payload.playMode)
      const roomChannel = getRoomChannel(result.room.id)

      result.room.players.forEach((player) => {
        const targetSocketId = roomManager.getActiveSocketId(player.id)
        if (!targetSocketId) {
          return
        }

        io.to(targetSocketId).emit(
          EVENTS.server.GAME_STARTED,
          roomManager.getReconnectGameSnapshot(result.room.id, player.id)
        )
      })

      io.to(roomChannel).emit(EVENTS.server.ROOM_STATE, {
        room: result.roomState,
      })

      handleSuccess(ack, { room: result.roomState })
    } catch (error) {
      if (error.code === 'PLAY_MODE_MISMATCH') {
        const roomId = roomManager.getRoomIdForPlayer(socket.data.playerId)
        socket.emit(EVENTS.server.ROOM_STATE, { room: roomManager.getRoomState(roomId) })
      }
      handleError(socket, EVENTS.client.ROOM_START_GAME, ack, error)
    }
  })

  socket.on(EVENTS.client.RECONNECT_ABANDON, (payload = {}, ack) => {
    try {
      const roomId = roomManager.getRoomIdForPlayer(socket.data.playerId)
      if (!roomId) {
        handleSuccess(ack, { roomId: null })
        return
      }

      const result = roomManager.abandonReconnect(socket.data.playerId)
      publishLeaveResult(io, socket, getRoomChannel, result || { roomId }, {
        notifyLeaver: true,
      })

      handleSuccess(ack, {
        roomId,
        room: result ? result.roomState : null,
      })
    } catch (error) {
      handleError(socket, EVENTS.client.RECONNECT_ABANDON, ack, error)
    }
  })
}

module.exports = registerRoomHandlers
