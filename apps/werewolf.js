import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const PLUGIN_NAME = '狼人杀'

// --- 数据存储与管理 ---
const DATA_DIR = path.resolve(process.cwd(), '../data/werewolf')
const ROOM_DATA_DIR = path.join(DATA_DIR, 'rooms')
const LOCK_DIR = path.join(DATA_DIR, 'locks')

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(ROOM_DATA_DIR)) fs.mkdirSync(ROOM_DATA_DIR, { recursive: true })
if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true })

class FileLock {
  constructor(lockFile) {
    this.lockFile = lockFile
    this.acquired = false
  }
  async acquire() {
    while (!this.acquired) {
      try {
        fs.writeFileSync(this.lockFile, process.pid.toString(), { flag: 'wx' })
        this.acquired = true
        return true
      } catch (err) {
        if (err.code === 'EEXIST') {
          try {
            const stat = fs.statSync(this.lockFile)
            if (Date.now() - stat.mtimeMs > 5000) {
              fs.unlinkSync(this.lockFile)
              continue
            }
          } catch (e) { continue }
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }
        throw err
      }
    }
  }
  release() {
    if (this.acquired) {
      try {
        if (fs.existsSync(this.lockFile) && fs.readFileSync(this.lockFile, 'utf8') === process.pid.toString()) {
          fs.unlinkSync(this.lockFile)
        }
        this.acquired = false
      } catch (err) {
        console.warn(`释放锁文件 ${this.lockFile} 时出错: ${err.message}`)
        this.acquired = false
      }
    }
  }
}

class GameDataManager {
  static async load(groupId) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    if (!fs.existsSync(roomFile)) return null
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      const data = fs.readFileSync(roomFile, 'utf8')
      return JSON.parse(data)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 读取游戏数据失败 (${groupId}):`, err)
      try { fs.unlinkSync(roomFile) } catch (unlinkErr) {}
      return null
    } finally {
      lock.release()
    }
  }
  static async save(groupId, data) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      fs.writeFileSync(roomFile, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 保存游戏数据失败 (${groupId}):`, err)
    } finally {
      lock.release()
    }
  }
  static async delete(groupId) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      if (fs.existsSync(roomFile)) fs.unlinkSync(roomFile)
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 删除游戏数据失败 (${groupId}):`, err)
    } finally {
      lock.release()
    }
  }
  static generateTempId(players) {
    let maxId = 0
    players.forEach(p => {
      if (p.tempId && parseInt(p.tempId) > maxId) maxId = parseInt(p.tempId)
    })
    return String(maxId + 1).padStart(2, '0')
  }
}

class GameCleaner {
  static cleanupTimers = new Map()
  static CLEANUP_DELAY = 2 * 60 * 60 * 1000 // 2 小时
  static registerGame(groupId, instance) {
    this.cleanupGame(groupId)
    const timer = setTimeout(async () => {
      console.log(`[${PLUGIN_NAME}] 清理超时游戏 (${groupId})...`)
      const gameData = await GameDataManager.load(groupId)
      if (gameData && gameData.gameState && gameData.gameState.isRunning) {
        console.log(`[${PLUGIN_NAME}] 强制结束超时游戏 (${groupId})...`)
        const fakeEvent = {
          group_id: groupId,
          user_id: gameData.hostUserId,
          reply: (msg) => instance.sendSystemGroupMsg(groupId, `[自动清理] ${msg}`),
          sender: { card: '系统', nickname: '系统' },
          isMaster: true,
          member: { is_admin: true }
        }
        await instance.forceEndGame(fakeEvent, true)
      }
      this.cleanupTimers.delete(groupId)
    }, this.CLEANUP_DELAY)
    this.cleanupTimers.set(groupId, timer)
    console.log(`[${PLUGIN_NAME}] 已注册游戏清理任务 (${groupId})`)
  }
  static cleanupGame(groupId) {
    const timer = this.cleanupTimers.get(groupId)
    if (timer) {
      clearTimeout(timer)
      this.cleanupTimers.delete(groupId)
      console.log(`[${PLUGIN_NAME}] 已清理游戏 (${groupId}) 的清理任务`)
    }
  }
  static cleanupAll() {
    console.log(`[${PLUGIN_NAME}] 清理所有游戏任务...`)
    for (const [, timer] of this.cleanupTimers) clearTimeout(timer)
    this.cleanupTimers.clear()
  }
}

// --- 游戏核心逻辑 ---
class WerewolfGame {
  constructor(initialData = {}) {
    this.players = initialData.players || []
    this.roles = initialData.roles || { WEREWOLF: '狼人', VILLAGER: '村民', SEER: '预言家', WITCH: '女巫', HUNTER: '猎人', GUARD: '守卫' }
    this.gameState = initialData.gameState || {
      isRunning: false,
      currentPhase: null,
      currentDay: 0,
      status: 'waiting', // waiting, starting, night, day_speak, day_vote, hunter_shooting, ended
      hostUserId: null,
      nightActions: {},
      lastProtectedId: null,
      hunterNeedsToShoot: null,
      currentSpeakerUserId: null,
      speakingOrder: [],
      currentSpeakerOrderIndex: -1,
      votes: {}
    }
    this.potions = initialData.potions || { save: true, kill: true }
    this.userGroupMap = initialData.userGroupMap || {}
  }

  initGame(hostUserId, hostNickname, groupId) {
    this.gameState = {
      isRunning: false, currentPhase: null, currentDay: 0, status: 'waiting',
      hostUserId: hostUserId, nightActions: {}, lastProtectedId: null, hunterNeedsToShoot: null,
      currentSpeakerUserId: null, speakingOrder: [], currentSpeakerOrderIndex: -1, votes: {}
    }
    this.players = []
    this.potions = { save: true, kill: true }
    this.userGroupMap = {}
    this.addPlayer(hostUserId, hostNickname, groupId)
    return { success: true, message: `狼人杀游戏已创建！你是房主。\n发送 #加入狼人杀 参与游戏。` }
  }

  addPlayer(userId, nickname, groupId) {
    if (this.players.some(p => p.userId === userId)) return { success: false, message: '你已经加入游戏了。' }
    if (!['waiting', 'starting'].includes(this.gameState.status)) return { success: false, message: '游戏已经开始或结束，无法加入。' }
    const player = {
      userId, nickname, role: null, isAlive: true, isProtected: false,
      tempId: GameDataManager.generateTempId(this.players), isDying: false
    }
    this.players.push(player)
    this.userGroupMap[userId] = groupId
    return { success: true, message: `${nickname} (${player.tempId}号) 加入了游戏。当前人数: ${this.players.length}` }
  }

  removePlayer(userId) {
    const playerIndex = this.players.findIndex(p => p.userId === userId)
    if (playerIndex === -1) return { success: false, message: '你不在游戏中。' }
    if (!['waiting', 'starting'].includes(this.gameState.status)) return { success: false, message: '游戏已经开始，无法退出。' }
    const removedPlayer = this.players.splice(playerIndex, 1)[0]
    if (removedPlayer.userId === this.gameState.hostUserId) {
      this.gameState.status = 'ended'
      return { success: true, message: `房主 ${removedPlayer.nickname} 退出了游戏，游戏已解散。`, gameDissolved: true }
    }
    delete this.userGroupMap[userId]
    return { success: true, message: `${removedPlayer.nickname} 退出了游戏。当前人数: ${this.players.length}` }
  }

  assignRoles() {
    const playerCount = this.players.length
    if (playerCount < 6) return { success: false, message: '玩家数量不足，至少需要6名玩家。' }
    let werewolfCount = playerCount >= 12 ? 4 : (playerCount >= 9 ? 3 : 2)
    let distribution = { WEREWOLF: werewolfCount, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1 }
    distribution.VILLAGER = playerCount - Object.values(distribution).reduce((a, b) => a + b, 0)
    let allRoles = []
    for (const role in distribution) {
      for (let i = 0; i < distribution[role]; i++) allRoles.push(role)
    }
    allRoles.sort(() => Math.random() - 0.5)
    this.players.forEach((player, index) => { player.role = allRoles[index] })
    return { success: true }
  }

  async prepareGameStart(pluginInstance) {
    if (this.players.length < 6) return { success: false, message: '玩家数量不足，至少需要6名玩家。' }
    if (this.gameState.status !== 'waiting') return { success: false, message: '游戏状态不正确。' }
    this.gameState.status = 'starting'
    const groupId = this.userGroupMap[this.gameState.hostUserId]
    await pluginInstance.sendSystemGroupMsg(groupId, "正在检查所有玩家私聊是否畅通...")
    let unreachablePlayers = []
    for (const player of this.players) {
      const reachable = await pluginInstance.sendDirectMessage(player.userId, `[${PLUGIN_NAME}] 游戏即将开始，测试私聊...`, groupId, false)
      if (!reachable) unreachablePlayers.push(player.nickname)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (unreachablePlayers.length > 0) {
      this.gameState.status = 'waiting'
      await pluginInstance.sendSystemGroupMsg(groupId, `以下玩家私聊发送失败：\n${unreachablePlayers.join(', ')}\n请确保机器人已加好友且未被屏蔽。`)
      return { success: false, message: '部分玩家私聊不可达，游戏无法开始。' }
    }
    await pluginInstance.sendSystemGroupMsg(groupId, "所有玩家私聊畅通！开始分配角色...")
    const assignResult = this.assignRoles()
    if (!assignResult.success) {
      this.gameState.status = 'waiting'
      return assignResult
    }
    return { success: true, message: '角色分配完毕！准备发送身份...' }
  }

  recordNightAction(role, userId, action) {
    if (this.gameState.status !== 'night') return { success: false, message: '当前不是夜晚行动时间。' }
    const player = this.players.find(p => p.userId === userId && p.isAlive)
    if (!player || player.role !== role) return { success: false, message: '无效操作：你的身份或状态不符。' }
    if (!this.gameState.nightActions[role]) this.gameState.nightActions[role] = {}
    let validation = this.validateTarget(action.targetTempId)
    if (!validation.success) return validation
    action.targetUserId = validation.targetPlayer.userId
    if (role === 'WITCH') validation = this.validateWitchAction(player, action)
    if (role === 'GUARD') validation = this.validateGuardAction(player, action)
    if (!validation.success) return validation
    this.gameState.nightActions[role][userId] = action
    let feedbackMsg = `${this.roles[role]} ${player.nickname} (${player.tempId}号) 已收到你的行动。`
    if (role === 'SEER') {
      const targetRole = validation.targetPlayer.role
      feedbackMsg += `\n[查验结果] ${validation.targetPlayer.nickname}(${validation.targetPlayer.tempId}号) 的身份是 【${targetRole === 'WEREWOLF' ? '狼人' : '好人'}】。`
    }
    return { success: true, message: feedbackMsg }
  }

  validateTarget(targetTempId) {
    const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return { success: false, message: '目标玩家编号无效或玩家已死亡。' }
    return { success: true, targetPlayer: targetPlayer }
  }

  validateWitchAction(witchPlayer, action) {
    if (action.type === 'save' && !this.potions.save) return { success: false, message: '你的解药已经用完了。' }
    if (action.type === 'kill' && !this.potions.kill) return { success: false, message: '你的毒药已经用完了。' }
    if (this.gameState.nightActions['WITCH']?.[witchPlayer.userId]) return { success: false, message: '你今晚已经行动过了。' } // 防止重复行动
    return { success: true }
  }

  validateGuardAction(guardPlayer, action) {
    if (action.targetUserId === this.gameState.lastProtectedId) return { success: false, message: '不能连续两晚守护同一个人。' }
    return { success: true }
  }

  processNightActions() {
    if (this.gameState.status !== 'night') return { message: '非夜晚，无法结算' }
    this.players.forEach(p => { p.isProtected = false; p.isDying = false })
    let guardTargetId = null
    let killedByWerewolfId = null
    let witchSavedPlayerId = null
    let witchKilledPlayerId = null
    const guardAction = Object.values(this.gameState.nightActions.GUARD || {})[0]
    if (guardAction) {
      const target = this.players.find(p => p.tempId === guardAction.targetTempId && p.isAlive)
      if (target) {
        target.isProtected = true
        guardTargetId = target.userId
        this.gameState.lastProtectedId = guardTargetId
      }
    }
    killedByWerewolfId = this.getWerewolfAttackTargetId()
    if (killedByWerewolfId) {
      const targetPlayer = this.players.find(p => p.userId === killedByWerewolfId)
      if (targetPlayer) targetPlayer.isDying = true
    }
    const witchAction = Object.values(this.gameState.nightActions.WITCH || {})[0]
    if (witchAction) {
      if (witchAction.type === 'save' && this.potions.save) {
        this.potions.save = false
        const savedTarget = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive)
        if (savedTarget && savedTarget.isDying) {
          savedTarget.isDying = false
          witchSavedPlayerId = savedTarget.userId
        }
      } else if (witchAction.type === 'kill' && this.potions.kill) {
        this.potions.kill = false
        const poisonedTarget = this.players.find(p => p.tempId === witchAction.targetTempId && p.isAlive)
        if (poisonedTarget) {
          witchKilledPlayerId = poisonedTarget.userId
          poisonedTarget.isDying = true
        }
      }
    }
    let actualDeaths = []
    this.players.forEach(p => {
      if (p.isDying) {
        if (p.isProtected && p.userId === killedByWerewolfId && p.userId !== witchKilledPlayerId) {
          p.isDying = false
        } else {
          p.isAlive = false
          actualDeaths.push(p)
        }
      }
    })
    let finalSummary = ["夜晚结束，现在公布昨晚发生的事情："]
    if (actualDeaths.length > 0) {
      actualDeaths.forEach(p => {
        finalSummary.push(`${p.nickname} (${p.tempId}号) 昨晚死亡了。`)
      })
    } else {
      if (killedByWerewolfId && (witchSavedPlayerId === killedByWerewolfId || guardTargetId === killedByWerewolfId)) {
        finalSummary.push("昨晚是个平安夜。")
      } else {
        finalSummary.push("昨晚无人死亡。")
      }
    }
    this.gameState.nightActions = {}
    const gameStatus = this.checkGameStatus()
    if (gameStatus.isEnd) {
      this.endGame(gameStatus.winner)
      return { success: true, summary: finalSummary.join('\n') + `\n游戏结束！${gameStatus.winner} 阵营获胜！`, gameEnded: true, winner: gameStatus.winner, finalRoles: this.getFinalRoles() }
    } else {
      this.gameState.status = 'day_speak'
      return { success: true, summary: finalSummary.join('\n'), gameEnded: false }
    }
  }

  recordVote(voterUserId, targetTempId) {
    if (this.gameState.status !== 'day_vote') return { success: false, message: '当前不是投票时间。' }
    const voter = this.players.find(p => p.userId === voterUserId && p.isAlive)
    if (!voter) return { success: false, message: '你无法投票。' }
    if (this.gameState.votes[voterUserId]) return { success: false, message: '你已经投过票了。' }
    const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return { success: false, message: '投票目标无效或已死亡。' }
    if (voter.userId === targetPlayer.userId) return { success: false, message: '不能投票给自己。' }
    this.gameState.votes[voter.userId] = targetTempId
    return { success: true, message: `${voter.nickname} (${voter.tempId}号) 投票给了 ${targetPlayer.nickname} (${targetTempId}号)。` }
  }

  moveToNextSpeaker() {
    if (this.gameState.currentSpeakerOrderIndex >= this.gameState.speakingOrder.length - 1) {
        this.gameState.currentSpeakerUserId = null;
        return null; // 所有人都已发言
    }
    this.gameState.currentSpeakerOrderIndex++;
    const nextSpeakerId = this.gameState.speakingOrder[this.gameState.currentSpeakerOrderIndex];
    this.gameState.currentSpeakerUserId = nextSpeakerId;
    this.gameState.speechStartTime = Date.now(); // 记录发言开始时间
    return nextSpeakerId;
  }

  processVotes() {
    if (this.gameState.status !== 'day_vote') return { message: '非投票阶段，无法计票' }
    const voteCounts = {}
    const voteDetails = {}
    this.players.filter(p => p.isAlive).forEach(voter => {
      const targetTempId = this.gameState.votes[voter.userId]
      if (targetTempId) {
        voteCounts[targetTempId] = (voteCounts[targetTempId] || 0) + 1
        if (!voteDetails[targetTempId]) voteDetails[targetTempId] = []
        voteDetails[targetTempId].push(`${voter.nickname}(${voter.tempId})`)
      } else {
        voteCounts['弃票'] = (voteCounts['弃票'] || 0) + 1
        if (!voteDetails['弃票']) voteDetails['弃票'] = []
        voteDetails['弃票'].push(`${voter.nickname}(${voter.tempId})`)
      }
    })
    let voteSummary = ["投票结果："]
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue
      const targetPlayer = this.players.find(p => p.tempId === targetTempId)
      if (targetPlayer) voteSummary.push(`${targetPlayer.nickname}(${targetTempId}号): ${voteCounts[targetTempId]}票 (${(voteDetails[targetTempId] || []).join(', ')})`)
    }
    if (voteCounts['弃票']) voteSummary.push(`弃票: ${voteCounts['弃票']}票 (${(voteDetails['弃票'] || []).join(', ')})`)
    let maxVotes = 0
    let tiedPlayers = []
    for (const targetTempId in voteCounts) {
      if (targetTempId === '弃票') continue
      if (voteCounts[targetTempId] > maxVotes) {
        maxVotes = voteCounts[targetTempId]
        tiedPlayers = [targetTempId]
      } else if (voteCounts[targetTempId] === maxVotes && maxVotes > 0) {
        tiedPlayers.push(targetTempId)
      }
    }
    this.gameState.votes = {}
    if (tiedPlayers.length === 1) {
      const eliminatedPlayer = this.players.find(p => p.tempId === tiedPlayers[0])
      if (eliminatedPlayer) {
        eliminatedPlayer.isAlive = false
        voteSummary.push(`${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`)
        if (eliminatedPlayer.role === 'HUNTER') {
          this.gameState.status = 'hunter_shooting'
          this.gameState.hunterNeedsToShoot = eliminatedPlayer.userId
          this.gameState.currentPhase = 'DAY'
          return { success: true, summary: voteSummary.join('\n'), gameEnded: false, needsHunterShoot: true }
        }
      }
    } else if (tiedPlayers.length > 1) {
      voteSummary.push(`出现平票 (${tiedPlayers.join(', ')}号)，本轮无人出局。`)
    } else {
      voteSummary.push("所有人都弃票或投票无效，本轮无人出局。")
    }
    const gameStatus = this.checkGameStatus()
    if (gameStatus.isEnd) {
      this.endGame(gameStatus.winner)
      return { success: true, summary: voteSummary.join('\n') + `\n游戏结束！${gameStatus.winner} 阵营获胜！`, gameEnded: true, winner: gameStatus.winner, finalRoles: this.getFinalRoles() }
    } else {
      this.gameState.status = 'night'
      return { success: true, summary: voteSummary.join('\n'), gameEnded: false }
    }
  }
  
  getWerewolfAttackTargetId() {
    const werewolfActions = this.gameState.nightActions['WEREWOLF'] || {};
    const killTargets = {};
    Object.values(werewolfActions).forEach(action => {
        const target = this.players.find(p => p.tempId === action.targetTempId && p.isAlive);
        if (target) killTargets[target.userId] = (killTargets[target.userId] || 0) + 1;
    });
    let maxVotes = 0;
    let topCandidates = [];
    Object.keys(killTargets).forEach(userId => {
        if (killTargets[userId] > maxVotes) {
            maxVotes = killTargets[userId];
            topCandidates = [userId];
        } else if (killTargets[userId] === maxVotes && maxVotes > 0) {
            topCandidates.push(userId);
        }
    });
    if (topCandidates.length > 1) {
        const randomIndex = Math.floor(Math.random() * topCandidates.length);
        return topCandidates[randomIndex];
    }
    return topCandidates.length === 1 ? topCandidates[0] : null;
  }

  checkGameStatus() {
    const alivePlayers = this.players.filter(p => p.isAlive)
    const aliveWerewolves = alivePlayers.filter(p => p.role === 'WEREWOLF').length
    const aliveHumans = alivePlayers.length - aliveWerewolves
    if (aliveWerewolves === 0) return { isEnd: true, winner: '好人' }
    if (aliveWerewolves >= aliveHumans) return { isEnd: true, winner: '狼人' }
    return { isEnd: false }
  }

  endGame() {
    this.gameState.isRunning = false
    this.gameState.status = 'ended'
  }

  getFinalRoles() {
    return this.players.map(p => `${p.nickname}(${p.tempId}号): ${this.roles[p.role] || '未知'}`).join('\n')
  }

  getPlayerInfo(userIdOrTempId) {
    const player = this.players.find(p => p.userId === userIdOrTempId || p.tempId === userIdOrTempId)
    return player ? `${player.nickname}(${player.tempId}号)` : '未知玩家'
  }

  getAlivePlayerList() {
    return this.players.filter(p => p.isAlive).map(p => `${p.tempId}号: ${p.nickname}`).join('\n')
  }
  
  getGameData() {
    return { players: this.players, roles: this.roles, gameState: this.gameState, potions: this.potions, userGroupMap: this.userGroupMap }
  }
}

// --- Yunzai 插件类 ---
export class WerewolfPlugin extends plugin {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: '狼人杀游戏插件',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#创建狼人杀$', fnc: 'createGame' },
        { reg: '^#加入狼人杀$', fnc: 'joinGame' },
        { reg: '^#退出狼人杀$', fnc: 'leaveGame' },
        { reg: '^#开始狼人杀$', fnc: 'startGame' },
        { reg: '^#(强制)?结束狼人杀$', fnc: 'forceEndGame' },
        { reg: '^#狼人杀状态$', fnc: 'showGameStatus' },
        { reg: '^#?(杀|刀)\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?查验\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?救\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?毒\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#?守\\s*(\\d+)$', fnc: 'handleNightAction', permission: 'private' },
        { reg: '^#结束发言$', fnc: 'handleEndSpeech' },
        { reg: '^#投票\\s*(\\d+)$', fnc: 'handleVote' },
        { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' }
      ]
    })
    this.gameInstances = new Map()
    this.actionTimeouts = new Map()
    this.NIGHT_INIT_TIMEOUT = 40 * 1000 // 狼人行动时间
    this.WITCH_ACTION_TIMEOUT = 30 * 1000 // 女巫独立思考时间
    this.SPEECH_TIMEOUT = 45 * 1000
    this.VOTE_TIMEOUT = 60 * 1000
    this.HUNTER_SHOOT_TIMEOUT = 30 * 1000
    process.on('exit', () => this.cleanup())
    process.on('SIGINT', () => this.cleanup())
  }

  // --- 核心游戏管理 ---
  async getGameInstance(groupId, createIfNotExist = false, hostUserId = null, hostNickname = null) {
    let game = this.gameInstances.get(groupId)
    if (!game) {
      const gameData = await GameDataManager.load(groupId)
      if (gameData) {
        game = new WerewolfGame(gameData)
        this.gameInstances.set(groupId, game)
        if (game.gameState.isRunning) {
          GameCleaner.registerGame(groupId, this)
          this.resumeGameTimers(groupId, game)
        }
      } else if (createIfNotExist && hostUserId && hostNickname) {
        game = new WerewolfGame()
        this.gameInstances.set(groupId, game)
        GameCleaner.registerGame(groupId, this)
      }
    }
    return game
  }

  async saveGame(groupId, game) {
    if (game) await GameDataManager.save(groupId, game.getGameData())
  }

  async deleteGame(groupId) {
    this.clearActionTimeout(groupId)
    GameCleaner.cleanupGame(groupId)
    this.gameInstances.delete(groupId)
    await GameDataManager.delete(groupId)
    console.log(`[${PLUGIN_NAME}] 已删除游戏数据 (${groupId})`)
  }
  
  resumeGameTimers(groupId, game) {
    // ... 恢复计时器逻辑（为简洁省略，可按需实现） ...
  }

  // --- 用户指令处理 (使用 e.reply) ---
  async createGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。")
    let game = await this.getGameInstance(groupId)
    if (game && game.gameState.status !== 'ended') return e.reply(`本群已有游戏（状态: ${game.gameState.status}）。\n请先 #结束狼人杀。`)
    
    game = await this.getGameInstance(groupId, true, e.user_id, e.sender.card || e.sender.nickname)
    const initResult = game.initGame(e.user_id, e.sender.card || e.sender.nickname, groupId)
    await this.saveGame(groupId, game)
    return e.reply(initResult.message, true)
  }

  async joinGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有等待加入的游戏。", true)
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始或结束，无法加入。", true)
    
    const result = game.addPlayer(e.user_id, e.sender.card || e.sender.nickname, groupId)
    await this.saveGame(groupId, game)
    return e.reply(result.message, false, { at: true })
  }

  async leaveGame(e) {
    const groupId = e.group_id;
    if (!groupId) return e.reply("请在群聊中使用此命令。", true);
    const game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true);
    if (!['waiting', 'starting'].includes(game.gameState.status)) return e.reply("游戏已经开始，无法退出。", true);
    
    const result = game.removePlayer(e.user_id);
    if (result.success) {
      if (result.gameDissolved) await this.deleteGame(groupId);
      else await this.saveGame(groupId, game);
    }
    return e.reply(result.message, false, { at: true });
  }

  async startGame(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)
    if (game.gameState.hostUserId !== e.user_id) return e.reply("只有房主才能开始游戏。", true)
    if (game.gameState.status !== 'waiting') return e.reply(`游戏状态为 ${game.gameState.status}，无法开始。`, true)
    
    const prepareResult = await game.prepareGameStart(this)
    await this.saveGame(groupId, game)
    if (!prepareResult.success) return e.reply(prepareResult.message, true)
    
    // 使用 e.reply 回复，因为这是对 #开始 指令的直接响应
    await e.reply(prepareResult.message, true)
    
    await this.sendRolesToPlayers(groupId, game)
    game.gameState.isRunning = true
    await this.saveGame(groupId, game)
    await this.startNightPhase(groupId, game)
  }

  async handleNightAction(e) {
    const userId = e.user_id
    const gameInfo = await this.findUserActiveGame(userId)
    if (!gameInfo) return e.reply('未找到你参与的有效游戏。')
    
    const game = gameInfo.instance
    if (game.gameState.status !== 'night') return e.reply('当前不是夜晚行动时间。')
    
    let role = null, type = null, targetTempId = null;
    let match;
    if ((match = e.msg.match(/^#?(杀|刀)\s*(\d+)$/))) {
      role = 'WEREWOLF'; type = 'kill'; targetTempId = match[2].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?查验\s*(\d+)$/))) {
      role = 'SEER'; type = 'check'; targetTempId = match[1].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?救\s*(\d+)$/))) {
      role = 'WITCH'; type = 'save'; targetTempId = match[1].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?毒\s*(\d+)$/))) {
      role = 'WITCH'; type = 'kill'; targetTempId = match[1].padStart(2, '0');
    } else if ((match = e.msg.match(/^#?守\s*(\d+)$/))) {
      role = 'GUARD'; type = 'protect'; targetTempId = match[1].padStart(2, '0');
    }
    
    if (!role) return; // 不匹配任何行动指令
    if (game.players.find(p => p.userId === userId)?.role !== role) return e.reply('你的身份不符。')
    
    const result = game.recordNightAction(role, userId, { type, targetTempId })
    if (result.success) await this.saveGame(gameInfo.groupId, game)
    
    return e.reply(result.message)
  }

  async handleEndSpeech(e) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_speak') return
    if (game.gameState.currentSpeakerUserId !== e.user_id) return e.reply("现在不是你的发言时间哦。", false, { at: true })
    
    this.clearActionTimeout(groupId)
    const speaker = game.players.find(p => p.userId === e.user_id)
    
    // 这里是系统广播，没有直接的回复对象，使用辅助函数
    await this.sendSystemGroupMsg(groupId, `${speaker?.nickname || '玩家'} (${speaker?.tempId || '??'}号) 已结束发言。`)
    
    const nextSpeakerUserId = game.moveToNextSpeaker()
    await this.saveGame(groupId, game)
    
    if (nextSpeakerUserId) {
      await this.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。")
      await this.startVotingPhase(groupId, game)
    }
  }

  async handleVote(e) {
    const groupId = e.group_id
    if (!groupId) return e.reply("请在群聊中使用此命令。", true)
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'day_vote') return e.reply("当前不是投票时间。", true)
    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return
    
    const result = game.recordVote(e.user_id, targetTempId)
    await this.saveGame(groupId, game)
    await e.reply(result.message, false, { at: true }) // 回复投票者
    
    const activePlayerCount = game.players.filter(p => p.isAlive).length
    if (Object.keys(game.gameState.votes).length === activePlayerCount) {
        this.clearActionTimeout(groupId)
        await this.processVoteEnd(groupId, game)
    }
  }

  async handleHunterShoot(e) {
    const userId = e.user_id
    const gameInfo = await this.findUserActiveGame(userId)
    if (!gameInfo) return e.reply("未找到你参与的游戏。")
    const game = gameInfo.instance
    if (game.gameState.status !== 'hunter_shooting' || game.gameState.hunterNeedsToShoot !== userId) return e.reply("现在不是你开枪的时间。")
    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    if (!targetTempId) return e.reply("指令格式错误，请发送 #开枪 编号")
    
    this.clearActionTimeout(gameInfo.groupId)
    
    const targetPlayer = game.players.find(p => p.tempId === targetTempId && p.isAlive)
    if (!targetPlayer) return e.reply("目标无效或已死亡。")
    if (targetPlayer.userId === userId) return e.reply("你不能对自己开枪。")
    
    targetPlayer.isAlive = false
    const summary = `猎人 ${game.getPlayerInfo(userId)} 开枪带走了 ${targetPlayer.nickname}(${targetPlayer.tempId}号)！`
    
    await this.sendSystemGroupMsg(gameInfo.groupId, summary)
    
    const gameStatus = game.checkGameStatus()
    if (gameStatus.isEnd) {
      this.endGameFlow(gameInfo.groupId, game, gameStatus.winner);
    } else {
      game.gameState.status = game.gameState.currentPhase === 'DAY' ? 'night' : 'day_speak'
      await this.saveGame(gameInfo.groupId, game)
      await this.transitionToNextPhase(gameInfo.groupId, game)
    }
  }

  async forceEndGame(e, isAutoCleanup = false) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game) return isAutoCleanup ? null : e.reply("本群当前没有游戏。", true)
    
    let canEnd = false
    if (isAutoCleanup || e.isMaster || (e.member && await e.member.is_admin) || game.gameState.hostUserId === e.user_id) {
        canEnd = true;
    }
    if (!canEnd) return e.reply("只有房主、群管或主人才能强制结束游戏。", true)
    
    const enderNickname = isAutoCleanup ? '系统自动' : (e.sender.card || e.sender.nickname)
    await this.sendSystemGroupMsg(groupId, `游戏已被 ${enderNickname} 强制结束。`)
    
    if (game.gameState.status !== 'waiting' && game.gameState.status !== 'ended') {
      await this.sendSystemGroupMsg(groupId, "公布所有玩家身份：\n" + game.getFinalRoles())
    }
    await this.deleteGame(groupId)
    return true
  }

  async showGameStatus(e) {
    const groupId = e.group_id
    if (!groupId) return
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply("本群当前没有游戏。", true)
    
    let statusMsg = `--- ${PLUGIN_NAME} 游戏状态 ---\n`
    statusMsg += `状态: ${game.gameState.status}\n`
    statusMsg += `天数: ${game.gameState.currentDay}\n`
    statusMsg += `房主: ${game.getPlayerInfo(game.gameState.hostUserId)}\n`
    statusMsg += `存活玩家 (${game.players.filter(p => p.isAlive).length}/${game.players.length}):\n`
    statusMsg += game.getAlivePlayerList()
    if (game.gameState.status === 'day_speak' && game.gameState.currentSpeakerUserId) {
      statusMsg += `\n当前发言: ${game.getPlayerInfo(game.gameState.currentSpeakerUserId)}`
    }
    return e.reply(statusMsg, true)
  }

  // --- 游戏流程与计时器 (使用辅助函数发送消息) ---

  async sendRolesToPlayers(groupId, game) {
    await this.sendSystemGroupMsg(groupId, "正在私聊发送角色身份和临时编号...")
    for (const player of game.players) {
      const roleName = game.roles[player.role] || '未知角色'
      const message = `你在本局狼人杀中的身份是：【${roleName}】\n你的临时编号是：【${player.tempId}号】`
      await this.sendDirectMessage(player.userId, message, groupId)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    await this.sendSystemGroupMsg(groupId, "所有身份已发送完毕！")
  }

  setActionTimeout(groupId, type, duration, context = {}) {
    this.clearActionTimeout(groupId)
    const timeoutId = setTimeout(async () => {
      const existingTimeout = this.actionTimeouts.get(groupId)
      if (!existingTimeout || existingTimeout.timeoutId !== timeoutId) return
      
      this.actionTimeouts.delete(groupId)
      console.log(`[${PLUGIN_NAME}] ${type} 时间到 (${groupId})`)
      
      const game = await this.getGameInstance(groupId)
      if (!game) return
      
      switch (type) {
        case 'night': if (game.gameState.status === 'night') await this.processNightEnd(groupId, game); break
        case 'speech': await this.processSpeechTimeout(groupId, game, context); break
        case 'vote': if (game.gameState.status === 'day_vote') await this.processVoteEnd(groupId, game); break
        case 'hunter_shoot': if (game.gameState.status === 'hunter_shooting') await this.processHunterShootEnd(groupId, game); break
      }
    }, duration)
    this.actionTimeouts.set(groupId, { type: type, timeoutId: timeoutId })
  }

  clearActionTimeout(groupId) {
    const timeoutInfo = this.actionTimeouts.get(groupId)
    if (timeoutInfo) clearTimeout(timeoutInfo.timeoutId)
    this.actionTimeouts.delete(groupId)
  }

  async startNightPhase(groupId, game) {
    if (!game) return
    game.gameState.status = 'night'
    game.gameState.currentDay++
    await this.saveGame(groupId, game)
    
    const day = game.gameState.currentDay
    await this.sendSystemGroupMsg(groupId, `--- 第 ${day} 天 - 夜晚 ---`)
    await this.sendSystemGroupMsg(groupId, `天黑请闭眼...`)
    
    const alivePlayerList = game.getAlivePlayerList()
    for (const player of game.players.filter(p => p.isAlive)) {
      let prompt = null
      switch (player.role) {
        case 'WEREWOLF': prompt = `狼人请行动。\n请私聊我：杀 [编号]\n${alivePlayerList}`; break
        case 'SEER': prompt = `预言家请行动。\n请私聊我：查验 [编号]\n${alivePlayerList}`; break
        case 'GUARD':
          let guardPrompt = `守卫请行动。\n`
          if (game.gameState.lastProtectedId) guardPrompt += `（你上晚守护了 ${game.getPlayerInfo(game.gameState.lastProtectedId)}，不能连守）\n`
          prompt = guardPrompt + `请私聊我：守 [编号]\n${alivePlayerList}`
          break
      }
      if (prompt) await this.sendDirectMessage(player.userId, prompt, groupId)
    }
    
    const totalNightTimeout = this.NIGHT_INIT_TIMEOUT + this.WITCH_ACTION_TIMEOUT
    game.gameState.nightStartTime = Date.now()
    await this.saveGame(groupId, game)
    this.setActionTimeout(groupId, 'night', totalNightTimeout)
    await this.sendSystemGroupMsg(groupId, `夜晚行动阶段开始，总时长 ${totalNightTimeout / 1000} 秒。`)
    
    setTimeout(async () => {
      const currentGame = await this.getGameInstance(groupId)
      if (!currentGame || currentGame.gameState.status !== 'night') return
      const witchPlayer = currentGame.players.find(p => p.role === 'WITCH' && p.isAlive)
      if (!witchPlayer) return
      
      const attackTargetId = currentGame.getWerewolfAttackTargetId()
      let witchPrompt = `女巫请行动。\n`
      if (attackTargetId) witchPrompt += `昨晚 ${currentGame.getPlayerInfo(attackTargetId)} 被袭击了。\n`
      else witchPrompt += `昨晚无人被袭击。\n`
      witchPrompt += `药剂状态：解药 ${currentGame.potions.save ? '可用' : '已用'}，毒药 ${currentGame.potions.kill ? '可用' : '已用'}。\n`
      if (currentGame.potions.save) witchPrompt += `使用解药请私聊我：救 [编号]\n`
      if (currentGame.potions.kill) witchPrompt += `使用毒药请私聊我：毒 [编号]\n`
      witchPrompt += `你的行动时间将在夜晚结束时截止。\n${currentGame.getAlivePlayerList()}`
      await this.sendDirectMessage(witchPlayer.userId, witchPrompt, groupId)
    }, this.NIGHT_INIT_TIMEOUT)
  }

  async processNightEnd(groupId, game) {
    if (!game || game.gameState.status !== 'night') return
    await this.sendSystemGroupMsg(groupId, "天亮了，进行夜晚结算...")
    
    const result = game.processNightActions()
    await this.saveGame(groupId, game)
    await this.sendSystemGroupMsg(groupId, result.summary)
    
    if (result.gameEnded) {
      this.endGameFlow(groupId, game, result.winner);
    } else {
      await this.transitionToNextPhase(groupId, game)
    }
  }

  async processSpeechTimeout(groupId, game, context) {
    if (!game || game.gameState.status !== 'day_speak') return
    if (context?.speakerId && context.speakerId !== game.gameState.currentSpeakerUserId) return
    
    const timedOutSpeaker = game.players.find(p => p.userId === game.gameState.currentSpeakerUserId)
    if (!timedOutSpeaker) return
    
    await this.sendSystemGroupMsg(groupId, `${timedOutSpeaker.nickname}(${timedOutSpeaker.tempId}号) 发言时间到。`)
    const nextSpeakerUserId = game.moveToNextSpeaker()
    await this.saveGame(groupId, game)
    
    if (nextSpeakerUserId) {
      await this.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。")
      await this.startVotingPhase(groupId, game)
    }
  }

  async announceAndSetSpeechTimer(groupId, game) {
    if (!game || game.gameState.status !== 'day_speak' || !game.gameState.currentSpeakerUserId) return
    const speaker = game.players.find(p => p.userId === game.gameState.currentSpeakerUserId)
    if (!speaker) return
    
    const msg = [segment.at(speaker.userId), ` 请开始发言 (${this.SPEECH_TIMEOUT / 1000}秒)。`]
    await this.sendSystemGroupMsg(groupId, msg)
    
    this.setActionTimeout(groupId, 'speech', this.SPEECH_TIMEOUT, { speakerId: speaker.userId })
  }
  
  async startDayPhase(groupId, game) {
    if (!game) return
    game.gameState.status = 'day_speak'
    await this.sendSystemGroupMsg(groupId, `--- 第 ${game.gameState.currentDay} 天 - 白天 ---`)
    
    const speechOrder = game.players.filter(p => p.isAlive).map(p => p.userId)
    game.gameState.speakingOrder = speechOrder
    game.gameState.currentSpeakerOrderIndex = -1
    
    const nextSpeakerId = game.moveToNextSpeaker()
    await this.saveGame(groupId, game)
    
    if (nextSpeakerId) {
      await this.announceAndSetSpeechTimer(groupId, game)
    } else {
      await this.sendSystemGroupMsg(groupId, "没有存活玩家可以发言，直接进入投票。")
      await this.startVotingPhase(groupId, game)
    }
  }

  async startVotingPhase(groupId, game) {
    game.gameState.status = 'day_vote'
    game.gameState.voteStartTime = Date.now()
    await this.saveGame(groupId, game)
    
    const alivePlayerList = game.getAlivePlayerList()
    await this.sendSystemGroupMsg(groupId, `现在开始投票，请选择你要投出的人。\n发送 #投票 [编号]\n你有 ${this.VOTE_TIMEOUT / 1000} 秒时间。\n存活玩家列表：\n${alivePlayerList}`)
    
    this.setActionTimeout(groupId, 'vote', this.VOTE_TIMEOUT)
  }

  async processVoteEnd(groupId, game) {
    if (!game || game.gameState.status !== 'day_vote') return
    await this.sendSystemGroupMsg(groupId, "投票时间结束，正在计票...")
    
    const result = game.processVotes()
    await this.saveGame(groupId, game)
    await this.sendSystemGroupMsg(groupId, result.summary)
    
    if (result.gameEnded) {
      this.endGameFlow(groupId, game, result.winner)
    } else if (result.needsHunterShoot) {
      await this.startHunterShootPhase(groupId, game)
    } else {
      await this.transitionToNextPhase(groupId, game)
    }
  }

  async processHunterShootEnd(groupId, game) {
    if (!game || game.gameState.status !== 'hunter_shooting') return
    
    const hunterInfo = game.getPlayerInfo(game.gameState.hunterNeedsToShoot)
    await this.sendSystemGroupMsg(groupId, `猎人 ${hunterInfo} 选择不开枪（或超时）。`)
    
    game.gameState.status = game.gameState.currentPhase === 'DAY' ? 'night' : 'day_speak'
    await this.saveGame(groupId, game)
    await this.transitionToNextPhase(groupId, game)
  }

  async transitionToNextPhase(groupId, game) {
    if (!game || game.gameState.status === 'ended') return
    const nextStatus = game.gameState.status
    console.log(`[${PLUGIN_NAME}] 状态转换 -> ${nextStatus} (群: ${groupId})`)
    switch (nextStatus) {
      case 'night': await this.startNightPhase(groupId, game); break
      case 'day_speak': await this.startDayPhase(groupId, game); break
      case 'day_vote': await this.startVotingPhase(groupId, game); break
      case 'hunter_shooting': await this.startHunterShootPhase(groupId, game); break
      default: console.warn(`[${PLUGIN_NAME}] 未知状态转换: ${nextStatus} (群: ${groupId})`)
    }
  }

  async startHunterShootPhase(groupId, game) {
    if (!game || game.gameState.status !== 'hunter_shooting' || !game.gameState.hunterNeedsToShoot) return
    const hunterUserId = game.gameState.hunterNeedsToShoot
    
    const hunterInfo = game.getPlayerInfo(hunterUserId)
    const alivePlayerList = game.getAlivePlayerList()
    await this.sendSystemGroupMsg(groupId, `${hunterInfo} 是猎人！临死前可以选择开枪带走一人！\n你有 ${this.HUNTER_SHOOT_TIMEOUT / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`)
    await this.sendDirectMessage(hunterUserId, `你是猎人，请开枪！\n发送 #开枪 [编号]\n你有 ${this.HUNTER_SHOOT_TIMEOUT / 1000} 秒时间。\n${alivePlayerList}`, groupId)
    
    game.gameState.hunterShootStartTime = Date.now()
    await this.saveGame(groupId, game)
    this.setActionTimeout(groupId, 'hunter_shoot', this.HUNTER_SHOOT_TIMEOUT)
  }
  
  async endGameFlow(groupId, game, winner) {
    await this.sendSystemGroupMsg(groupId, `游戏结束！${winner} 阵营获胜！\n公布所有玩家身份：\n` + game.getFinalRoles());
    await this.deleteGame(groupId);
  }

  // --- 辅助函数 ---
  async sendSystemGroupMsg(groupId, msg) {
    if (!groupId || !msg) return
    try { await Bot.pickGroup(groupId).sendMsg(msg) } 
    catch (err) { console.error(`[${PLUGIN_NAME}] 发送系统群消息失败 (${groupId}):`, err) }
  }

  async sendDirectMessage(userId, msg, sourceGroupId = null, notifyGroupOnError = true) {
    if (!userId || !msg) return false
    try {
      await Bot.pickUser(userId).sendMsg(msg)
      return true
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 发送私聊消息失败 (userId: ${userId}):`, err)
      if (sourceGroupId && notifyGroupOnError) {
        await this.sendSystemGroupMsg(sourceGroupId, `[!] 无法向玩家 QQ:${userId} 发送私聊消息，请检查好友关系或机器人是否被屏蔽。`)
      }
      return false
    }
  }

  cleanup() {
    console.log(`[${PLUGIN_NAME}] 正在清理插件资源...`)
    for (const groupId of this.actionTimeouts.keys()) this.clearActionTimeout(groupId)
    this.actionTimeouts.clear()
    GameCleaner.cleanupAll()
    console.log(`[${PLUGIN_NAME}] 清理完成。`)
  }
}