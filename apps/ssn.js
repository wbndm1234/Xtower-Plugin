import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

// 数据存储路径
const DATA_DIR = path.resolve(process.cwd(), '../data/ssn')
const ROOM_DATA_DIR = path.join(DATA_DIR, 'rooms')
const LOCK_DIR = path.join(DATA_DIR, 'locks')

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}
if (!fs.existsSync(ROOM_DATA_DIR)) {
  fs.mkdirSync(ROOM_DATA_DIR, { recursive: true })
}
if (!fs.existsSync(LOCK_DIR)) {
  fs.mkdirSync(LOCK_DIR, { recursive: true })
}

// 游戏数据操作封装
class GameDataManager {
  static async load(groupId) {
    const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
    const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)
    
    // 如果文件不存在，返回空对象
    if (!fs.existsSync(roomFile)) {
      return {}
    }
    
    const lock = new FileLock(lockFile)
    try {
      await lock.acquire()
      return JSON.parse(fs.readFileSync(roomFile, 'utf8'))
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
      if (fs.existsSync(roomFile)) {
        fs.unlinkSync(roomFile)
      }
    } finally {
      lock.release()
    }
  }

  // 生成唯一房间号
  static async generateRoomId() {
    let roomId = ''
    const usedIds = new Set()
    
    // 获取已存在的房间ID
    if (fs.existsSync(ROOM_DATA_DIR)) {
      const files = fs.readdirSync(ROOM_DATA_DIR)
      files.forEach(file => {
        if (file.endsWith('.json')) {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(ROOM_DATA_DIR, file), 'utf8'))
            if (data.roomId) {
              usedIds.add(data.roomId)
            }
          } catch (e) {
            console.error('读取房间文件错误:', e)
          }
        }
      })
    }
    
    // 生成不重复的6位数字房间号
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString()
    } while (usedIds.has(roomId))
    
    return roomId
  }
}

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
          } catch (e) {
            continue
          }
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
        fs.unlinkSync(this.lockFile)
        this.acquired = false
      } catch (err) {
        console.error('释放锁失败:', err)
      }
    }
  }
}

// 游戏清理器
class GameCleaner {
  static cleanupTimers = new Map()

  static registerGame(groupId, instance) {
    // 清理旧的定时器
    this.cleanupGame(groupId)
    
    // 设置新的清理定时器(2小时后自动清理)
    this.cleanupTimers.set(groupId, setTimeout(async () => {
      const gameData = await GameDataManager.load(groupId)
      if (gameData[groupId]) {
        await instance.forceEndGame({ group_id: groupId, user_id: gameData.host })
      }
    }, 7200000))
  }

  static cleanupGame(groupId) {
    const timer = this.cleanupTimers.get(groupId)
    if (timer) {
      clearTimeout(timer)
      this.cleanupTimers.delete(groupId)
    }
  }

  static cleanupAll() {
    for (const [groupId, timer] of this.cleanupTimers) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()
  }
}

// 游戏配置
const GAME_CONFIG = {
  VOTE_TIMEOUT: 60000, // 60秒投票时间
  SPEAK_TIMEOUT: 30000 // 30秒发言时间
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export class WhoIsTheSpy extends plugin {
  constructor() {
    super({
      name: PLUGIN_NAME,
      dsc: '谁是卧底游戏',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#卧底创建\\s*(明牌|暗牌)?$', fnc: 'createGame' },
        { reg: '^#加入卧底$', fnc: 'joinGame' },
        { reg: '^#退出卧底$', fnc: 'leaveGame' },
        { reg: '^#开始卧底$', fnc: 'startGame' },
        { reg: '^#(结束发言|发言结束)$', fnc: 'endSpeech' },
        { reg: '^#投票\\s?\\d+$', fnc: 'vote' },
        { reg: '^#结束卧底$', fnc: 'forceEndGame' }
      ]
    })
    
    // 加载词库
    this.wordPairs = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../resource/word_pairs.json'),
        'utf8'
      )
    )
    
    this.gameTimers = {}

    // 注册进程退出时的清理
    process.on('exit', () => {
      this.cleanup()
    })
  }

  cleanup() {
    // 清理所有定时器
    for (const groupId in this.gameTimers) {
      if (this.gameTimers[groupId]) {
        clearTimeout(this.gameTimers[groupId])
        delete this.gameTimers[groupId]
      }
    }
    // 清理所有游戏清理器
    GameCleaner.cleanupAll()
  }

  // 发送群消息
  async sendGroupMsg(groupId, msg) {
    const bot = global.Bot || this.e?.bot
    try {
      await bot.pickGroup(groupId).sendMsg(msg)
    } catch (err) {
      console.error(`群消息发送失败: ${groupId}`, err)
    }
  }

  // 创建游戏
  async createGame(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (gameData.status && gameData.status !== 'ended') {
      return e.reply('本群已经有一个进行中的游戏了哦~ 请先结束当前游戏再创建新的吧 (｡･ω･｡)')
    }
    
    // 解析明暗牌参数，默认为暗牌
    const isOpenIdentity = /明牌$/.test(e.msg)
    const roomId = await GameDataManager.generateRoomId()
    
    const newGameData = {
      roomId,
      status: 'waiting',
      host: e.user_id,
      isOpenIdentity, // 添加明暗牌标记
      players: [{
        userId: e.user_id,
        nickname: e.sender.card || e.sender.nickname,
        isSpy: false,
        eliminated: false,
        tempId: null
      }],
      currentSpeaker: 0,
      currentRound: 0,
      votedPlayers: {},
      normalWord: '',
      spyWord: '',
      voteResults: {},
      speakingTimeout: null
    }
    
    await GameDataManager.save(groupId, newGameData)
    // 注册游戏清理
    GameCleaner.registerGame(groupId, this)
    return e.reply([
      '游戏创建成功！',
      `模式：${isOpenIdentity ? '明牌' : '暗牌'}`,
      `房间号：${roomId}`,
      `当前玩家：${e.sender.card || e.sender.nickname}`,
      '发送 #加入卧底 参与，需至少3人'
    ].join('\n'))
  }

  // 加入游戏
  async joinGame(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (!gameData.status || gameData.status !== 'waiting') {
      return e.reply('当前没有等待中的游戏呢~')
    }

    const playerExists = gameData.players.some(p => p.userId === e.user_id)
    if (playerExists) {
      return e.reply('你已经加入游戏了哦，不要重复加入啦 (＾▽＾)')
    }

    gameData.players.push({
      userId: e.user_id,
      nickname: e.sender.card || e.sender.nickname,
      isSpy: false,
      eliminated: false,
      tempId: null
    })

    await GameDataManager.save(groupId, gameData)
    return e.reply(`${e.sender.card || e.sender.nickname} 加入游戏`)
  }

  // 退出游戏
  async leaveGame(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (!gameData.status || gameData.status !== 'waiting') {
      return e.reply('当前没有等待中的游戏呢~')
    }

    const playerIndex = gameData.players.findIndex(p => p.userId === e.user_id)
    if (playerIndex === -1) {
      return e.reply('你还没有加入游戏哦，快来加入吧！(＾▽＾)')
    }

    if (gameData.host === e.user_id) {
      await GameDataManager.delete(groupId)
      return e.reply('房主退出了，游戏解散~')
    }

    gameData.players.splice(playerIndex, 1)
    await GameDataManager.save(groupId, gameData)
    return e.reply(`${e.sender.card || e.sender.nickname} 退出游戏`)
  }

  // 开始游戏
  async startGame(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (!gameData.status || 
        gameData.host !== e.user_id ||
        gameData.status !== 'waiting' ||
        gameData.players.length < 3) {
      return e.reply('游戏人数不足或状态不对，无法开始哦~ 需要至少3人才能开始游戏')
    }

    // 分配临时ID
    gameData.players.forEach((p, i) => {
      p.tempId = String(i + 1).padStart(2, '0')
    })

    // 分配卧底
    const spyIndex = Math.floor(Math.random() * gameData.players.length)
    gameData.players[spyIndex].isSpy = true

    // 分配词语
    const [normalWord, spyWord] = this.wordPairs[
      Math.floor(Math.random() * this.wordPairs.length)
    ]
    gameData.normalWord = normalWord
    gameData.spyWord = spyWord
    gameData.status = 'playing'
    gameData.currentRound = 1

    await GameDataManager.save(groupId, gameData)

    // 私发身份
    for (const p of gameData.players) {
      const word = p.isSpy ? spyWord : normalWord
      const message = gameData.isOpenIdentity ? 
        [
          `身份：${p.isSpy ? '卧底' : '平民'}`,
          `词语：${word}`,
          `编号：${p.tempId}`
        ] :
        [
          `词语：${word}`,
          `编号：${p.tempId}`,
          '游戏为暗牌模式，身份保密'
        ]
      
      const success = await this.sendPrivateMsg(p.userId, message.join('\n'), groupId)

      // 如果发送失败,函数会自动清理游戏数据
      if (!success) return
    }

    await this.sendGroupMsg(groupId, '游戏开始！已发送身份信息')
    this.startSpeakingRound(groupId)
  }

  // 开始发言环节
  async startSpeakingRound(groupId) {
    const gameData = await GameDataManager.load(groupId)
    if (!gameData.status) return
    
    // 获取未淘汰的玩家，并确保有序列表
    const activePlayers = gameData.players.filter(p => !p.eliminated)
    const orderList = activePlayers.map(p => `${p.tempId}号 ${p.nickname}`).join('\n')
    
    await this.sendGroupMsg(groupId, `第${gameData.currentRound}轮发言开始！顺序：\n${orderList}`)
    
    // 重置发言索引
    gameData.currentSpeaker = 0
    gameData.status = 'playing'
    await GameDataManager.save(groupId, gameData)
    
    // 延迟一秒后开始第一个玩家发言，避免消息堆叠
    setTimeout(() => {
      this.nextSpeaker(groupId)
    }, 1000)
  }

  // 下一位玩家发言
  async nextSpeaker(groupId) {
    const gameData = await GameDataManager.load(groupId)
    if (!gameData.status) return
  
    // 获取未淘汰的玩家
    const activePlayers = gameData.players.filter(p => !p.eliminated)
    
    // 如果发言索引超出范围，开始投票
    if (gameData.currentSpeaker >= activePlayers.length) {
      // 所有玩家已发言，进入投票阶段
      this.startVoting(groupId)
      return
    }
  
    const currentSpeakerIndex = gameData.currentSpeaker  // 保存当前发言索引
    const currentPlayer = activePlayers[currentSpeakerIndex]
    
    // 清除之前的超时计时器
    if (this.gameTimers[groupId]) {
      clearTimeout(this.gameTimers[groupId])
      delete this.gameTimers[groupId]
    }
    
    // 发送发言提示
    await this.sendGroupMsg(groupId, `请${currentPlayer.tempId}号 ${currentPlayer.nickname} 开始发言吧~ 你有30秒的时间哦 (＾▽＾)`)
  
    // 设置新的超时计时器，使用索引而不是玩家对象
    this.gameTimers[groupId] = setTimeout(async () => {
      // 重新加载游戏数据，确保使用最新状态
      const updatedGameData = await GameDataManager.load(groupId)
      if (!updatedGameData.status || updatedGameData.status !== 'playing') {
        return
      }
      
      // 获取当前应该发言的玩家
      const currentActivePlayers = updatedGameData.players.filter(p => !p.eliminated)
      const currentSpeaker = currentActivePlayers[currentSpeakerIndex]
      
      await this.sendGroupMsg(groupId, `${currentSpeaker.tempId}号发言超时`)
      updatedGameData.currentSpeaker++
      await GameDataManager.save(groupId, updatedGameData)
      this.nextSpeaker(groupId)
    }, 30000)
  }

  // 结束发言
  async endSpeech(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (!gameData.status || gameData.status !== 'playing') {
      return e.reply('当前无法结束发言')
    }
  
    // 确保是当前发言玩家
    const activePlayers = gameData.players.filter(p => !p.eliminated)
    const speakerIndex = gameData.currentSpeaker
    
    if (speakerIndex >= activePlayers.length) {
      return e.reply('当前无人发言')
    }
    
    const currentSpeaker = activePlayers[speakerIndex]
    
    if (currentSpeaker.userId !== e.user_id) {
      return e.reply('不是你的发言回合')
    }
  
    // 清除超时计时器
    if (this.gameTimers[groupId]) {
      clearTimeout(this.gameTimers[groupId])
      delete this.gameTimers[groupId]
    }
  
    // 移动到下一个发言者
    gameData.currentSpeaker++
    await GameDataManager.save(groupId, gameData)
    
    await this.sendGroupMsg(groupId, `${currentSpeaker.nickname} 已结束发言`)
    
    // 添加短暂延迟，避免快速连续的消息
    setTimeout(() => {
      this.nextSpeaker(groupId)
    }, 500)
  }

  // 开始投票
  async startVoting(groupId) {
    const gameData = await GameDataManager.load(groupId)
    if (!gameData.status) return
    
    gameData.status = 'voting'
    gameData.voteResults = {}
    await GameDataManager.save(groupId, gameData)

    const playerList = gameData.players
      .filter(p => !p.eliminated)
      .map(p => `${p.tempId}号 ${p.nickname}`)
      .join('\n')
    
    await this.sendGroupMsg(groupId, [
      '开始投票！',
      '格式：#投票 编号',
      `剩余时间：${GAME_CONFIG.VOTE_TIMEOUT / 1000}秒`,
      playerList
    ].join('\n'))

    // 清除之前的计时器
    if (this.gameTimers[groupId]) {
      clearTimeout(this.gameTimers[groupId])
      delete this.gameTimers[groupId]
    }

    // 设置投票超时
    this.gameTimers[groupId] = setTimeout(async () => {
      const updatedGameData = await GameDataManager.load(groupId)
      if (!updatedGameData.status || updatedGameData.status !== 'voting') return

      // 检查是否有人投票
      const voteCount = Object.keys(updatedGameData.voteResults).length
      if (voteCount === 0) {
        // 无人投票,直接进入下一轮
        await this.sendGroupMsg(groupId, '投票时间结束啦，没有人投票呢，直接进入下一轮吧 (＾▽＾)')
        updatedGameData.currentRound++
        updatedGameData.status = 'playing'
        updatedGameData.votedPlayers = {}
        await GameDataManager.save(groupId, updatedGameData)
        this.startSpeakingRound(groupId)
      } else {
        // 有投票，进行正常计票
        await this.sendGroupMsg(groupId, '投票时间结束，开始计票')
        this.countVotes(groupId)
      }
    }, GAME_CONFIG.VOTE_TIMEOUT)
  }

  // 投票
  async vote(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (!gameData.status || gameData.status !== 'voting') {
      return e.reply('当前不在投票阶段')
    }

    // 检查计时器是否存在
    if (!this.gameTimers[groupId]) {
      return e.reply('投票时间已结束')
    }

    // 检查投票者是否为活跃玩家
    const voter = gameData.players.find(p => 
      p.userId === e.user_id && !p.eliminated
    )
    if (!voter) return e.reply('你不在游戏中，无法参与投票哦~ 下次记得加入游戏吧 (＾▽＾)')

    // 解析投票目标
    const voteTargetRaw = e.msg.match(/\d+/)?.[0]
    if (!voteTargetRaw) return e.reply('投票格式错误')
    
    // 确保两位数格式
    const voteTarget = voteTargetRaw.padStart(2, '0')

    // 平票投票限制
    if (gameData.votedPlayers?.isTie && 
        !gameData.votedPlayers.ids.includes(voteTarget)) {
      return e.reply('本轮只能投给：' + gameData.votedPlayers.ids.join(','))
    }

    // 检查投票目标是否有效
    const targetPlayer = gameData.players.find(p => 
      p.tempId === voteTarget && !p.eliminated
    )
    if (!targetPlayer) {
      return e.reply('你投的玩家好像不存在呢，请检查一下编号')
    }
    
    // 不能投给自己
    if (targetPlayer.userId === e.user_id) {
      return e.reply('投票给自己？你想干嘛QWQ')
    }

    // 记录投票
    gameData.voteResults[voter.tempId] = voteTarget
    await GameDataManager.save(groupId, gameData)
    await e.reply(`${voter.nickname} 投票给 ${voteTarget}号`)

    // 检查是否所有人都已投票
    const activePlayerCount = gameData.players.filter(p => !p.eliminated).length
    if (Object.keys(gameData.voteResults).length === activePlayerCount) {
      this.countVotes(groupId)
    }
  }

  // 统计票数
  async countVotes(groupId) {
    const gameData = await GameDataManager.load(groupId)
    if (!gameData.status) return
    
    const votes = Object.values(gameData.voteResults)
    
    // 计算每个玩家获得的票数
    const voteCount = votes.reduce((acc, cur) => {
      acc[cur] = (acc[cur] || 0) + 1
      return acc
    }, {})

    // 找出得票最多的玩家
    let maxVotes = Math.max(...Object.values(voteCount))
    let candidates = Object.keys(voteCount).filter(k => voteCount[k] === maxVotes)

    // 处理平票
    if (candidates.length > 1) {
      if (gameData.votedPlayers?.isTie) {
        // 连续平票，无人淘汰，进入下一轮
        await this.sendGroupMsg(groupId, '连续平票，无人淘汰')
        gameData.currentRound++
        gameData.status = 'playing'
        gameData.votedPlayers = {}
        await GameDataManager.save(groupId, gameData)
        this.startSpeakingRound(groupId)
      } else {
        // 第一次平票，进行重新投票
        gameData.votedPlayers = { ids: candidates, isTie: true }
        gameData.voteResults = {}
        await GameDataManager.save(groupId, gameData)
        await this.sendGroupMsg(groupId, `平票！请重新投票：${candidates.join(',')}`)
      }
      return
    }

    // 淘汰玩家
    const eliminatedId = candidates[0]
    const eliminated = gameData.players.find(p => p.tempId === eliminatedId)
    eliminated.eliminated = true

    // 判断胜负
    const alive = gameData.players.filter(p => !p.eliminated)
    const spiesAlive = alive.filter(p => p.isSpy).length
    const civiliansAlive = alive.filter(p => !p.isSpy).length
    
    // 卧底获胜条件：卧底存活且平民数量 <= 卧底数量
    const spyWins = spiesAlive > 0 && civiliansAlive <= spiesAlive
    // 平民获胜条件：无卧底存活
    const civilianWins = spiesAlive === 0

    if (spyWins || civilianWins) {
      // 游戏结束
      const spy = gameData.players.find(p => p.isSpy)
      await this.sendGroupMsg(groupId, [
        `游戏结束！${eliminated.nickname} 被淘汰`,
        `卧底是：${spy.tempId}号 ${spy.nickname}`,
        `卧底词：${gameData.spyWord}`,
        `平民词：${gameData.normalWord}`,
        spyWins ? '卧底获胜！' : '平民获胜！'
      ].join('\n'))
      
      // 清理游戏数据
      if (this.gameTimers[groupId]) {
        clearTimeout(this.gameTimers[groupId])
        delete this.gameTimers[groupId]
      }
      gameData.status = 'ended'
      await GameDataManager.save(groupId, gameData)
    } else {
      // 游戏继续
      await this.sendGroupMsg(groupId, `${eliminated.nickname} 被淘汰，游戏继续`)
      gameData.currentRound++
      gameData.status = 'playing'
      gameData.votedPlayers = {}
      await GameDataManager.save(groupId, gameData)
      
      // 进入下一轮
      this.startSpeakingRound(groupId)
    }
  }

  // 强制结束游戏
  async forceEndGame(e) {
    const groupId = e.group_id
    const gameData = await GameDataManager.load(groupId)
    
    if (!gameData.status || gameData.host !== e.user_id) {
      return e.reply('无法操作呢，你是房主吗，还是没有正在进行的游戏呢咕？')
    }

    // 清除超时计时器
    if (this.gameTimers[groupId]) {
      clearTimeout(this.gameTimers[groupId])
      delete this.gameTimers[groupId]
    }

    if (gameData.status !== 'waiting') {
      const spy = gameData.players.find(p => p.isSpy)
      await this.sendGroupMsg(groupId, [
        '游戏已强制结束',
        `卧底：${spy.tempId}号 ${spy.nickname}`,
        `卧底词：${gameData.spyWord}`,
        `平民词：${gameData.normalWord}`
      ].join('\n'))
    } else {
      await this.sendGroupMsg(groupId, '游戏已取消')
    }

    // 清理游戏相关资源
    this.cleanupGame(groupId)
    await GameDataManager.delete(groupId)
  }

  // 清理单个游戏的资源
  cleanupGame(groupId) {
    if (this.gameTimers[groupId]) {
      clearTimeout(this.gameTimers[groupId])
      delete this.gameTimers[groupId]
    }
    GameCleaner.cleanupGame(groupId)
  }

  // 发送私聊消息
  async sendPrivateMsg(userId, msg, groupId) {
    const bot = global.Bot || this.e?.bot
    try {
      await bot.pickUser(userId).sendMsg(msg)
      return true
    } catch (err) {
      console.error('私聊发送失败:', err)
      // 在群里提示
      await this.sendGroupMsg(groupId, `无法向所有玩家发送私聊消息，游戏立刻结束`)
      // 清理游戏数据
      const gameData = await GameDataManager.load(groupId)
      if (gameData.status) {
        this.cleanupGame(groupId)
        await GameDataManager.delete(groupId)
      }
      return false
    }
  }
}