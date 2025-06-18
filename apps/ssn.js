import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const PLUGIN_NAME = '谁是卧底'

// --- 1. 通用数据管理模块 ---
const DATA_DIR = path.resolve(process.cwd(), 'data', PLUGIN_NAME) // 修正了路径，使其在Yunzai的data目录下
const ROOM_DATA_DIR = path.join(DATA_DIR, 'rooms')
const LOCK_DIR = path.join(DATA_DIR, 'locks')

// 确保目录存在 (启动时同步操作是可接受的)
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(ROOM_DATA_DIR)) fs.mkdirSync(ROOM_DATA_DIR, { recursive: true })
if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true })

class FileLock {
  constructor(lockFile) {
    this.lockFile = lockFile
    this.acquired = false
  }
  async acquire() {
    const fsp = fs.promises
    const startTime = Date.now();
    while (!this.acquired) {
      if (Date.now() - startTime > 10000) { // 增加10秒超时以防止死锁
          throw new Error(`获取锁 ${this.lockFile} 超时。`);
      }
      try {
        await fsp.writeFile(this.lockFile, String(process.pid), { flag: 'wx' })
        this.acquired = true
        return true
      } catch (err) {
        if (err.code === 'EEXIST') {
          try {
            const stat = await fsp.stat(this.lockFile)
            // 如果锁文件存在超过5秒，认为是过期的死锁
            if (Date.now() - stat.mtimeMs > 5000) {
              await fsp.unlink(this.lockFile)
              continue // 尝试重新获取
            }
          } catch (statErr) { 
            // 如果在检查时文件消失，直接重试
            continue
          }
          // 等待一小段时间再试
          await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 50))
          continue
        }
        throw err // 其他错误直接抛出
      }
    }
  }
  async release() {
    if (this.acquired) {
      try {
        await fs.promises.unlink(this.lockFile)
        this.acquired = false
      } catch (err) {
        // 如果文件已经被删除，不是错误
        if (err.code !== 'ENOENT') {
          console.warn(`[${PLUGIN_NAME}] 释放锁文件 ${this.lockFile} 时出错: ${err.message}`)
        }
        this.acquired = false; // 确保状态被重置
      }
    }
  }
}

class GameDataManager {
  static async load(groupId) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    if (!fs.existsSync(roomFile)) return null

    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      const data = await fs.promises.readFile(roomFile, 'utf8')
      return JSON.parse(data)
    } catch (err) {
      if (err.code === 'ENOENT') return null
      console.error(`[${PLUGIN_NAME}] 读取游戏数据失败 (${groupId}):`, err)
      return null
    } finally {
      await lock.release()
    }
  }
  static async save(groupId, data) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      await fs.promises.writeFile(roomFile, JSON.stringify(data, null, 2))
    } catch (err)
    {
      console.error(`[${PLUGIN_NAME}] 保存游戏数据失败 (${groupId}):`, err)
    } finally {
      await lock.release()
    }
  }
  static async delete(groupId) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      // 使用 fse.pathExists 避免在文件不存在时unlink抛出错误
      if(fs.existsSync(roomFile)) {
        await fs.promises.unlink(roomFile)
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[${PLUGIN_NAME}] 删除游戏数据失败 (${groupId}):`, err)
      }
    } finally {
      await lock.release()
    }
  }
}

class GameCleaner {
    static cleanupTimers = new Map()
    static CLEANUP_DELAY = 2 * 60 * 60 * 1000 // 2小时

    static registerGame(groupId, instance) {
      this.cleanupGame(groupId) // 先清理旧的计时器
      const timer = setTimeout(async () => {
        console.log(`[${PLUGIN_NAME}] 正在清理超时游戏 (${groupId})...`)
        const gameData = await GameDataManager.load(groupId)
        if (gameData && gameData.gameState.status !== 'ended') {
          const fakeEvent = {
            group_id: groupId,
            user_id: gameData.gameState.hostUserId,
            reply: (msg) => instance.sendSystemGroupMsg(groupId, `[自动清理] ${msg}`),
            sender: { card: '系统', nickname: '系统' },
            isMaster: true
          }
          await instance.forceEndGame(fakeEvent, true)
        }
        this.cleanupTimers.delete(groupId)
      }, this.CLEANUP_DELAY)
      this.cleanupTimers.set(groupId, timer)
    }
    static cleanupGame(groupId) { const timer = this.cleanupTimers.get(groupId); if (timer) { clearTimeout(timer); this.cleanupTimers.delete(groupId); } }
    static cleanupAll() { for (const [, timer] of this.cleanupTimers) clearTimeout(timer); this.cleanupTimers.clear(); }
}

// --- 游戏核心逻辑类 (无改动) ---
class WhoIsTheSpyGame {
  constructor(initialData = {}) { this.players = initialData.players || []; this.gameState = initialData.gameState || { status: 'ended', hostUserId: null, isOpenIdentity: false, currentSpeakerIndex: 0, currentRound: 0, normalWord: '', spyWord: '', votes: {}, lastVoteTie: false, }; }
  initGame(hostUserId, hostNickname, isOpenIdentity) { this.players = []; this.gameState = { status: 'waiting', hostUserId: hostUserId, isOpenIdentity: isOpenIdentity, currentSpeakerIndex: 0, currentRound: 0, normalWord: '', spyWord: '', votes: {}, lastVoteTie: false }; this.addPlayer(hostUserId, hostNickname); return { success: true, message: `游戏创建成功！模式：${isOpenIdentity ? '明牌' : '暗牌'}\n你是房主，发送 #加入卧底 参与。` }; }
  addPlayer(userId, nickname) { if (this.players.some(p => p.userId === userId)) { return { success: false, message: '你已经加入游戏了。' }; } const player = { userId, nickname, isSpy: false, isAlive: true, tempId: String(this.players.length + 1).padStart(2, '0') }; this.players.push(player); return { success: true, message: `${nickname} (${player.tempId}号) 加入游戏。当前人数: ${this.players.length}` }; }
  removePlayer(userId) { const playerIndex = this.players.findIndex(p => p.userId === userId); if (playerIndex === -1) { return { success: false, message: '你不在游戏中。' }; } if (this.gameState.status !== 'waiting') { return { success: false, message: '游戏已经开始，无法退出。' }; } const removedPlayer = this.players.splice(playerIndex, 1)[0]; if (removedPlayer.userId === this.gameState.hostUserId) { this.gameState.status = 'ended'; return { success: true, message: `房主 ${removedPlayer.nickname} 退出了，游戏解散。`, gameDissolved: true }; } this.players.forEach((p, i) => p.tempId = String(i + 1).padStart(2, '0')); return { success: true, message: `${removedPlayer.nickname} 退出游戏。当前人数: ${this.players.length}` }; }
  prepareGame(wordPairs) { if (this.players.length < 3) { return { success: false, message: '游戏人数不足，至少需要3人才能开始。' }; } const spyIndex = Math.floor(Math.random() * this.players.length); this.players[spyIndex].isSpy = true; const [normalWord, spyWord] = wordPairs[Math.floor(Math.random() * wordPairs.length)]; this.gameState.normalWord = normalWord; this.gameState.spyWord = spyWord; this.gameState.status = 'playing'; this.gameState.currentRound = 1; return { success: true }; }
  moveToNextSpeaker() { const activePlayers = this.players.filter(p => p.isAlive); if (this.gameState.currentSpeakerIndex >= activePlayers.length) { return null; } const nextSpeaker = activePlayers[this.gameState.currentSpeakerIndex]; this.gameState.currentSpeakerIndex++; return nextSpeaker; }
  recordVote(voterUserId, targetTempId) { const voter = this.players.find(p => p.userId === voterUserId && p.isAlive); if (!voter) return { success: false, message: '你不在游戏中或已淘汰，无法投票。' }; if (this.gameState.votes[voter.userId]) return { success: false, message: '你已经投过票了。' }; const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive); if (!targetPlayer) return { success: false, message: '投票目标无效。' }; if (voter.userId === targetPlayer.userId) return { success: false, message: '不能投票给自己。' }; this.gameState.votes[voter.userId] = targetTempId; return { success: true, message: `${voter.nickname} 投票给 ${targetPlayer.nickname} (${targetTempId}号)。` }; }
  processVotes() { const voteCounts = {}; Object.values(this.gameState.votes).forEach(targetId => { voteCounts[targetId] = (voteCounts[targetId] || 0) + 1; }); let maxVotes = 0; let candidates = []; for (const tempId in voteCounts) { if (voteCounts[tempId] > maxVotes) { maxVotes = voteCounts[tempId]; candidates = [tempId]; } else if (voteCounts[tempId] === maxVotes && maxVotes > 0) { candidates.push(tempId); } } this.gameState.votes = {}; if (candidates.length === 0) { this.gameState.lastVoteTie = false; return { summary: '无人投票，无人出局。', eliminatedPlayer: null, gameStatus: this.checkGameStatus() }; } if (candidates.length > 1) { if (this.gameState.lastVoteTie) { this.gameState.lastVoteTie = false; return { summary: `再次平票 (${candidates.join(', ')}号)，无人出局。`, eliminatedPlayer: null, gameStatus: this.checkGameStatus() }; } else { this.gameState.lastVoteTie = true; return { summary: `平票！(${candidates.join(', ')}号)。本轮无人出局。`, eliminatedPlayer: null, gameStatus: this.checkGameStatus() }; } } this.gameState.lastVoteTie = false; const eliminatedId = candidates[0]; const eliminatedPlayer = this.players.find(p => p.tempId === eliminatedId); eliminatedPlayer.isAlive = false; return { summary: `${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`, eliminatedPlayer, gameStatus: this.checkGameStatus() }; }
  checkGameStatus() { const alivePlayers = this.players.filter(p => p.isAlive); const spiesAlive = alivePlayers.filter(p => p.isSpy).length; const civiliansAlive = alivePlayers.length - spiesAlive; if (spiesAlive === 0) return { isEnd: true, winner: '平民' }; if (civiliansAlive <= spiesAlive) return { isEnd: true, winner: '卧底' }; return { isEnd: false, winner: null }; }
  getGameData() { return { players: this.players, gameState: this.gameState }; }
  getFinalRoles() { const spy = this.players.find(p => p.isSpy); return [`卧底是：${spy?.nickname || '??'} (${spy?.tempId || '??'}号)`, `卧底词：${this.gameState.spyWord}`, `平民词：${this.gameState.normalWord}`].join('\n'); }
  getAlivePlayerList() { return this.players.filter(p => p.isAlive).map(p => `${p.tempId}号: ${p.nickname}`).join('\n'); }
}

// --- 3. Yunzai 插件类 (作为控制器) ---
export class WhoIsTheSpy extends plugin {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: '谁是卧底游戏',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#卧底创建\\s*(明牌|暗牌)?$', fnc: 'createGame' },
        { reg: '^#加入卧底$', fnc: 'joinGame' },
        { reg: '^#退出卧底$', fnc: 'leaveGame' },
        { reg: '^#开始卧底$', fnc: 'startGame' },
        { reg: '^#(结束发言|发言结束)$', fnc: 'endSpeech' },
        { reg: '^#投票\\s*(\\d+)$', fnc: 'vote' },
        { reg: '^#结束卧底$', fnc: 'forceEndGame' },
        { reg: '^#卧底状态$', fnc: 'showGameStatus' },
      ]
    })

    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    // 假设资源在插件的 resource 目录下
    this.wordPairs = JSON.parse(fs.readFileSync(path.join(__dirname, '../resource/word_pairs.json'),'utf8'))
    
    this.gameInstances = new Map()
    this.actionTimeouts = new Map()
    this.SPEECH_TIMEOUT = 30 * 1000 // 30秒发言
    this.VOTE_TIMEOUT = 60 * 1000 // 60秒投票

    process.on('exit', () => this.cleanup())
  }

  // --- 核心游戏管理 ---
  async getGameInstance(groupId, createIfNotExist = false) {
    let game = this.gameInstances.get(groupId)
    if (!game) {
      const gameData = await GameDataManager.load(groupId)
      if (gameData) {
        game = new WhoIsTheSpyGame(gameData)
        this.gameInstances.set(groupId, game)
        // 如果加载的游戏不是结束状态，重新注册清理计时器
        if (game.gameState.status !== 'ended') {
          GameCleaner.registerGame(groupId, this)
        }
      } else if (createIfNotExist) {
        game = new WhoIsTheSpyGame()
        this.gameInstances.set(groupId, game)
      }
    }
    return game
  }

  async saveGame(groupId, game) {
    if (game) {
      await GameDataManager.save(groupId, game.getGameData());
      // 每次保存都意味着游戏有活动，重置自动清理计时器
      GameCleaner.registerGame(groupId, this);
    }
  }

  async deleteGame(groupId) {
    this.clearActionTimeout(groupId)
    GameCleaner.cleanupGame(groupId)
    this.gameInstances.delete(groupId)
    await GameDataManager.delete(groupId)
  }

  // --- 用户指令处理 ---
  async createGame(e) {
    const groupId = e.group_id
    let game = await this.getGameInstance(groupId)
    if (game && game.gameState.status !== 'ended') return e.reply('本群已有进行中的游戏。')
    
    game = await this.getGameInstance(groupId, true)
    const isOpenIdentity = /明牌$/.test(e.msg)
    const result = game.initGame(e.user_id, e.sender.card || e.sender.nickname, isOpenIdentity)
    
    await this.saveGame(groupId, game)
    return e.reply(result.message, true)
  }

  async joinGame(e) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'waiting') return e.reply('当前没有等待加入的游戏。')

    const result = game.addPlayer(e.user_id, e.sender.card || e.sender.nickname)
    if (result.success) await this.saveGame(groupId, game)
    return e.reply(result.message, false)
  }

  async leaveGame(e) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game) return e.reply('本群当前没有游戏。')

    const result = game.removePlayer(e.user_id)
    if (result.success) {
      if (result.gameDissolved) {
        await this.deleteGame(groupId);
      } else {
        await this.saveGame(groupId, game);
      }
    }
    return e.reply(result.message, false)
  }

  async startGame(e) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.hostUserId !== e.user_id) return e.reply('只有房主才能开始游戏。')
    if (game.gameState.status !== 'waiting') return e.reply('游戏状态不正确。')

    const prepareResult = game.prepareGame(this.wordPairs)
    if (!prepareResult.success) return e.reply(prepareResult.message)

    await e.reply("游戏开始！正在私聊发送身份词语...")
    
    let allSent = true
    for (const p of game.players) {
        const word = p.isSpy ? game.gameState.spyWord : game.gameState.normalWord
        let message = `你的词语是：【${word}】\n你的编号是：【${p.tempId}】`
        if (game.gameState.isOpenIdentity) {
            message = `你的身份是：【${p.isSpy ? '卧底' : '平民'}】\n` + message
        }
        const sent = await this.sendDirectMessage(p.userId, message, groupId)
        if (!sent) allSent = false
    }
    
    if (!allSent) {
      await this.sendSystemGroupMsg(groupId, "部分玩家私聊发送失败，游戏已自动结束。")
      await this.deleteGame(groupId)
      return true
    }
    
    await this.saveGame(groupId, game)
    await this.startSpeakingRoundFlow(groupId, game)
  }

  async endSpeech(e) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'playing') return
    
    const activePlayers = game.players.filter(p => p.isAlive)
    // 注意：moveToNextSpeaker 会使 index 加一，所以当前发言者是 index - 1
    const currentSpeakerIndex = game.gameState.currentSpeakerIndex - 1
    if (currentSpeakerIndex < 0 || currentSpeakerIndex >= activePlayers.length) return

    if (activePlayers[currentSpeakerIndex].userId !== e.user_id) {
        return e.reply('现在不是你的发言时间。', true)
    }

    this.clearActionTimeout(groupId) 
    
    await this.sendSystemGroupMsg(groupId, `${e.sender.card || e.sender.nickname} 结束发言。`)
    await this.processNextSpeaker(groupId)
  }

  async vote(e) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status !== 'voting') return e.reply('当前不是投票时间。')

    const targetTempId = e.msg.match(/\d+/)?.[0].padStart(2, '0')
    const result = game.recordVote(e.user_id, targetTempId)
    
    if (result.success) {
      await e.reply(result.message, true)
      await this.saveGame(groupId, game)

      const activePlayerCount = game.players.filter(p => p.isAlive).length
      if (Object.keys(game.gameState.votes).length === activePlayerCount) {
          this.clearActionTimeout(groupId)
          await this.processVoteEnd(groupId)
      }
    } else {
      await e.reply(result.message, true)
    }
  }

  async forceEndGame(e, isAutoCleanup = false) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game) return isAutoCleanup ? null : e.reply('本群没有游戏。')
    
    const canEnd = isAutoCleanup || e.isMaster || game.gameState.hostUserId === e.user_id
    if (!canEnd) return e.reply('只有房主或机器人主人才能结束游戏。')
    
    await this.sendSystemGroupMsg(groupId, `游戏已被 ${(e.sender.card || e.sender.nickname)} 强制结束。`)
    if (game.gameState.status !== 'waiting' && game.gameState.status !== 'ended') {
        await this.sendSystemGroupMsg(groupId, "公布身份：\n" + game.getFinalRoles())
    }
    await this.deleteGame(groupId)
    return true
  }

  async showGameStatus(e) {
    const groupId = e.group_id
    const game = await this.getGameInstance(groupId)
    if (!game || game.gameState.status === 'ended') return e.reply('本群没有游戏。')

    let statusMsg = `--- ${PLUGIN_NAME} 游戏状态 ---\n`
    statusMsg += `模式: ${game.gameState.isOpenIdentity ? '明牌' : '暗牌'}\n`
    statusMsg += `状态: ${game.gameState.status}\n`
    statusMsg += `回合: ${game.gameState.currentRound}\n`
    statusMsg += `存活玩家 (${game.players.filter(p => p.isAlive).length}/${game.players.length}):\n`
    statusMsg += game.getAlivePlayerList()
    return e.reply(statusMsg, true)
  }

  // --- 游戏流程与计时器 ---
  setActionTimeout(groupId, type, duration) {
    this.clearActionTimeout(groupId)

    const timeoutId = setTimeout(async () => {
      const game = await this.getGameInstance(groupId)
      if (!game || game.gameState.status === 'ended') {
        this.actionTimeouts.delete(groupId)
        return
      }
      
      let expectedStatus;
      switch (type) {
        case 'speech': expectedStatus = 'playing'; break;
        case 'vote': expectedStatus = 'voting'; break;
        default: return;
      }
      // 防御性检查，如果状态不匹配，说明流程已经被其他操作改变，计时器作废
      if (game.gameState.status !== expectedStatus) {
        this.actionTimeouts.delete(groupId)
        return
      }
      
      switch (type) {
        case 'speech':
            await this.sendSystemGroupMsg(groupId, "发言时间到，自动进入下一位。")
            await this.processNextSpeaker(groupId)
            break
        case 'vote':
            await this.sendSystemGroupMsg(groupId, "投票时间到，开始计票。")
            await this.processVoteEnd(groupId)
            break
      }
    }, duration)

    this.actionTimeouts.set(groupId, { type, timeoutId })
  }

  clearActionTimeout(groupId) {
    const timeoutInfo = this.actionTimeouts.get(groupId)
    if (timeoutInfo) {
      clearTimeout(timeoutInfo.timeoutId)
    }
    this.actionTimeouts.delete(groupId)
  }

  async startSpeakingRoundFlow(groupId, game) {
    game.gameState.status = 'playing'
    game.gameState.currentSpeakerIndex = 0
    await this.saveGame(groupId, game) // 在回合开始时保存一次状态

    await this.sendSystemGroupMsg(groupId, `--- 第 ${game.gameState.currentRound} 轮发言开始 ---`)
    await this.processNextSpeaker(groupId)
  }

  async processNextSpeaker(groupId) {
    const game = await this.getGameInstance(groupId);
    if (!game || game.gameState.status !== 'playing') return;

    const nextSpeaker = game.moveToNextSpeaker();

    // 只有在确定有下一位发言人时，才保存游戏状态
    if (nextSpeaker) {
        await this.saveGame(groupId, game); // 保存更新后的 speaker index
        const msg = [segment.at(nextSpeaker.userId), ` 请开始发言 (${this.SPEECH_TIMEOUT / 1000}秒)。发言完毕请说“结束发言”。`];
        await this.sendSystemGroupMsg(groupId, msg);
        this.setActionTimeout(groupId, 'speech', this.SPEECH_TIMEOUT);
    } else {
        // 没有下一位发言人，说明发言阶段结束
        this.clearActionTimeout(groupId);
        await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
        // 直接进入投票流程，由 startVotingFlow 负责改变状态和保存
        await this.startVotingFlow(groupId, game);
    }
  }

  async startVotingFlow(groupId, game) {
    game.gameState.status = 'voting'; // 明确设置状态为投票
    // 在这里统一保存进入投票阶段的状态
    await this.saveGame(groupId, game);

    const alivePlayerList = game.getAlivePlayerList();
    const msg = `现在开始投票，请选择你要投出的人。\n发送 #投票 [编号]\n你有 ${this.VOTE_TIMEOUT / 1000} 秒时间。\n存活玩家列表：\n${alivePlayerList}`;
    await this.sendSystemGroupMsg(groupId, msg);

    this.setActionTimeout(groupId, 'vote', this.VOTE_TIMEOUT);
  }

  async processVoteEnd(groupId) {
    const game = await this.getGameInstance(groupId);
    // 增加防御性判断，防止游戏已结束但计时器仍在运行的极端情况
    if (!game || game.gameState.status !== 'voting') return;

    const result = game.processVotes();
    await this.saveGame(groupId, game); // 保存计票后的结果
    await this.sendSystemGroupMsg(groupId, result.summary);
    
    const { isEnd, winner } = result.gameStatus;
    if (isEnd) {
      await this.endGameFlow(groupId, game, winner);
    } else {
      game.gameState.currentRound++;
      // 下一轮的 speaking flow 会自己保存状态，这里无需重复保存
      await this.startSpeakingRoundFlow(groupId, game);
    }
  }

  async endGameFlow(groupId, game, winner) {
    game.gameState.status = 'ended';
    // 在游戏彻底结束前，不再保存状态，直接准备删除
    
    await this.sendSystemGroupMsg(groupId, `游戏结束！${winner} 阵营获胜！\n` + game.getFinalRoles());
    await this.deleteGame(groupId);
  }

  // --- 辅助函数 ---
  async sendSystemGroupMsg(groupId, msg) {
    if (!groupId || !msg) return
    try { await Bot.pickGroup(groupId).sendMsg(msg) } 
    catch (err) { console.error(`[${PLUGIN_NAME}] 发送系统群消息失败 (${groupId}):`, err) }
  }

  async sendDirectMessage(userId, msg, sourceGroupId) {
    if (!userId || !msg) return false
    try {
      await Bot.pickUser(userId).sendMsg(msg)
      return true
    } catch (err) {
      console.error(`[${PLUGIN_NAME}] 发送私聊消息失败 (userId: ${userId}):`, err)
      if (sourceGroupId) {
        await this.sendSystemGroupMsg(sourceGroupId, `[!] 无法向玩家 QQ:${userId} 发送私聊消息，请检查好友关系或机器人是否被屏蔽。`)
      }
      return false
    }
  }

  cleanup() {
    console.log(`[${PLUGIN_NAME}] 正在清理插件资源...`)
    GameCleaner.cleanupAll()
    for (const groupId of this.actionTimeouts.keys()) {
        this.clearActionTimeout(groupId)
    }
  }
}