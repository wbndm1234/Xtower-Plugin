import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

// --- Configuration Loading ---
const pluginName = 'Xtower-Plugin' // Should match your plugin's folder name
const configPath = path.join(process.cwd(), 'plugins', pluginName, 'config', 'config.yaml')

const defaultConfig = {
  russianRoulette: {
    initial_spins: 4,
    default_bullet_count: 1,
    auto_start_delay_ms: 30000,
    cylinder_capacity: 6
  }
}

function loadGameConfig () {
  let loadedConfig = {}
  try {
    if (fs.existsSync(configPath)) {
      const yamlText = fs.readFileSync(configPath, 'utf8')
      const fullConfig = yaml.load(yamlText) || {}
      if (fullConfig.russianRoulette) {
        loadedConfig = fullConfig.russianRoulette
      }
    }
  } catch (error) {
    logger.error(`[${pluginName} - RussianRoulette] Failed to load config: ${error}`)
  }
  // Merge with defaults to ensure all keys are present
  return { ...defaultConfig.russianRoulette, ...loadedConfig }
}
// --- End Configuration Loading ---

// Use Map 存储每个群的游戏状态，key: group_id
const gameStates = new Map()

export class RussianRoulette extends plugin {
  constructor () {
    super({
      name: '俄罗斯转盘',
      dsc: '一场紧张刺激的运气游戏',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#俄罗斯(转|轮)盘([1-9])?$', fnc: 'createGame' },
        { reg: '^#加入(转|轮)盘$', fnc: 'joinGame' },
        { reg: '^#退出(转|轮)盘$', fnc: 'quitGame' },
        { reg: '^#开始(转|轮)盘$', fnc: 'manualStartGame' },
        { reg: '^#(旋转|转)$', fnc: 'spinCylinder', prehash: true },
        { reg: '^#开枪$', fnc: 'fire', prehash: true },
        { reg: '^#结束(转|轮)盘$', fnc: 'endGameByCreator' }
      ]
    })
    // Load config when plugin is initialized
    this.gameConfig = loadGameConfig()
    
    // Update regex for createGame based on cylinder_capacity
    // Max bullets should be cylinder_capacity - 1
    const maxBulletsRegexPart = this.gameConfig.cylinder_capacity > 1 ? `[1-${Math.min(9, this.gameConfig.cylinder_capacity - 1)}]` : ''
    if(this.rule[0]) { // Defensive check
        this.rule[0].reg = new RegExp(`^#俄罗斯(转|轮)盘${maxBulletsRegexPart}?$`)
    }

    // logger.info(`[${pluginName} - RussianRoulette] Loaded config: ${JSON.stringify(this.gameConfig)}`)
    // ^^^ 这条日志已被移除，因为它会在每次插件加载时触发 ^^^
    // 现在只有在 startGame 函数中才会打印游戏开始的日志
  }

  get isGameContext () {
    const e = this.e
    if (!e.isGroup) return false
    const game = gameStates.get(e.group_id)
    if (!game || game.phase !== 'playing') return false
    const currentPlayer = game.players[game.turnIndex]
    return currentPlayer?.id === e.user_id
  }

  async createGame (e) {
    if (!e.isGroup) return e.reply('请在群聊中开始游戏。')
    if (gameStates.has(e.group_id)) {
      return e.reply('本群已经有一场游戏正在进行或准备中啦！')
    }

    let bulletCountInput = e.msg.match(/\d+/)?.[0]
    let bulletCount = Number(bulletCountInput || this.gameConfig.default_bullet_count)

    // Validate bulletCount against cylinder_capacity
    const maxPossibleBullets = this.gameConfig.cylinder_capacity - 1
    if (this.gameConfig.cylinder_capacity <= 1) {
        return e.reply('弹巢容量配置过小，无法开始游戏！请联系管理员调整配置。');
    }
    if (bulletCount < 1) bulletCount = 1
    if (bulletCount > maxPossibleBullets) {
      await e.reply(`子弹数量过多！当前弹巢容量为 ${this.gameConfig.cylinder_capacity}，最多只能装填 ${maxPossibleBullets} 颗子弹。已自动设为 ${maxPossibleBullets} 颗。`)
      bulletCount = maxPossibleBullets
    }

    const creator = { id: e.user_id, name: e.sender.card || e.sender.nickname, spinsLeft: this.gameConfig.initial_spins }
    const game = {
      creatorId: e.user_id,
      phase: 'waiting',
      players: [creator],
      bulletCount: bulletCount,
      cylinder: [], // Will be sized according to cylinder_capacity
      currentPosition: 0,
      turnIndex: 0,
      timeout: null,
      cylinderCapacity: this.gameConfig.cylinder_capacity // Store for easy access
    }
    gameStates.set(e.group_id, game)
    game.timeout = setTimeout(() => this.startGame(e.group_id), this.gameConfig.auto_start_delay_ms)

    const maxPlayers = game.cylinderCapacity // Max players is the cylinder capacity
    const msg = [
      segment.at(e.user_id),
      ` 发起了一场【俄罗斯转盘】！\n`,
      `子弹数量：${bulletCount} / ${game.cylinderCapacity}\n`,
      `最大人数：${maxPlayers}人 (弹巢容量)\n`,
      `每人拥有 ${this.gameConfig.initial_spins} 次旋转机会。\n`,
      `发送【#加入转盘】参与对局。\n`,
      `游戏将在 ${this.gameConfig.auto_start_delay_ms / 1000} 秒后或由房主【#开始转盘】后进行。`
    ]
    return e.reply(msg)
  }

  async joinGame (e) {
    if (!e.isGroup) return
    const game = gameStates.get(e.group_id)
    if (!game || game.phase !== 'waiting') return e.reply('当前没有可以加入的游戏。')

    const maxPlayers = game.cylinderCapacity
    if (game.players.length >= maxPlayers) {
      return e.reply(`赌桌已满（${maxPlayers}/${maxPlayers}），无法加入！`)
    }
    if (game.players.some(p => p.id === e.user_id)) return e.reply('你已经在这场赌局中了。')
    
    game.players.push({ id: e.user_id, name: e.sender.card || e.sender.nickname, spinsLeft: this.gameConfig.initial_spins })
    
    if (game.players.length === maxPlayers) {
      clearTimeout(game.timeout)
      await e.reply([segment.at(e.user_id), ` 已加入赌局，赌桌已满！游戏立即开始...`])
      this.startGame(e.group_id)
    } else {
      await e.reply([segment.at(e.user_id), ` 已加入赌局，祝你好运... (${game.players.length}/${maxPlayers})`])
    }
  }

  async quitGame (e) {
    if (!e.isGroup) return

    const game = gameStates.get(e.group_id)
    if (!game || game.phase !== 'waiting') return

    const playerIndex = game.players.findIndex(p => p.id === e.user_id)
    if (playerIndex === -1) return

    if (game.creatorId === e.user_id) {
      clearTimeout(game.timeout)
      gameStates.delete(e.group_id)
      return e.reply('房主已退出，赌局解散。')
    }

    game.players.splice(playerIndex, 1)
    return e.reply([segment.at(e.user_id), ' 已退出赌局。'])
  }

  async manualStartGame (e) {
    if (!e.isGroup) return

    const game = gameStates.get(e.group_id)
    if (!game || game.phase !== 'waiting') {
      return e.reply('当前没有等待中的游戏可以开始。')
    }
    if (e.user_id !== game.creatorId) {
      return e.reply('只有房主才能开始游戏哦。')
    }
    if (game.players.length < 2) {
      return e.reply('参与人数不足2人，无法开始游戏。')
    }

    clearTimeout(game.timeout)
    this.startGame(e.group_id)
  }

  async startGame (groupId) {
    const game = gameStates.get(groupId)
    if (!game || game.phase !== 'waiting') return
    if (game.players.length < 2) {
      gameStates.delete(groupId)
      Bot.sendGroupMsg(groupId, '参与人数不足，赌局已解散。')
      return
    }
    
    game.players.sort(() => Math.random() - 0.5)
    // Initialize cylinder based on configured capacity
    game.cylinder = Array(game.cylinderCapacity).fill(0)
    for (let i = 0; i < game.bulletCount; i++) game.cylinder[i] = 1 // Load bullets
    game.cylinder.sort(() => Math.random() - 0.5) // Shuffle bullets

    game.phase = 'playing'
    game.currentPosition = Math.floor(Math.random() * game.cylinderCapacity)
    
    // 这条日志会在每局游戏开始时显示详细的装填情况
    logger.info(`[俄罗斯转盘] 群 ${groupId} 游戏开始，弹巢容量: ${game.cylinderCapacity}, 子弹: ${game.bulletCount}, 弹巢状态: ${game.cylinder.join('')}`)
    
    await Bot.sendGroupMsg(groupId, '赌局已满，命运的齿轮开始转动...')
    this.announceTurn(groupId)
  }

  async announceTurn (groupId) {
    const game = gameStates.get(groupId)
    if (!game || game.phase !== 'playing') return
    const currentPlayer = game.players[game.turnIndex]
    
    let actionPrompt
    if (currentPlayer.spinsLeft > 0) {
      actionPrompt = `你还剩下 ${currentPlayer.spinsLeft} 次旋转机会。\n你可以【#旋转】或直接【#开枪】。`
    } else {
      actionPrompt = `你已经没有旋转机会了，命运已定。\n请直接【#开枪】。`
    }
    
    const msg = [`轮到 `, segment.at(currentPlayer.id), ` 了。\n`, `当前幸存者: ${game.players.length}人。\n`, actionPrompt]
    Bot.sendGroupMsg(groupId, msg)
  }

  async spinCylinder (e) {
    if (!this.isGameContext) return
    const game = gameStates.get(e.group_id)
    const currentPlayer = game.players[game.turnIndex]
    
    if (currentPlayer.spinsLeft > 0) {
      game.currentPosition = Math.floor(Math.random() * game.cylinderCapacity)
      currentPlayer.spinsLeft--
      logger.info(`[俄罗斯转盘] 玩家 ${e.user_id} 旋转了弹巢，当前位置 ${game.currentPosition}，剩余旋转 ${currentPlayer.spinsLeft}次`)
      return e.reply(`你消耗了一次机会拨动了弹巢... 还剩下 ${currentPlayer.spinsLeft} 次旋转机会。`, true)
    } else {
      return e.reply('你已经没有旋转的机会了，开枪吧！', true)
    }
  }

  async fire (e) {
    if (!this.isGameContext) return

    const game = gameStates.get(e.group_id)
    const currentPlayer = game.players[game.turnIndex]

    logger.info(`[俄罗斯转盘] 玩家 ${e.user_id} 开枪，弹巢位置: ${game.currentPosition}, 弹膛状态: ${game.cylinder[game.currentPosition]}`)

    if (game.cylinder[game.currentPosition] === 0) { // Safe
      game.currentPosition = (game.currentPosition + 1) % game.cylinderCapacity // Move to next chamber
      game.turnIndex = (game.turnIndex + 1) % game.players.length
      await e.reply(['咔... ', segment.at(currentPlayer.id), ' 松了口气，你活了下来。\n', '左轮手枪递给了下一个人...'], true)
      this.announceTurn(e.group_id)
    } else { // Hit!
      game.cylinder[game.currentPosition] = -1 // Mark bullet as used
      await e.reply(['砰！一声枪响。\n', segment.at(currentPlayer.id), ' 倒在了桌上，赌局结束了... 对他而言。'], true)
      game.players.splice(game.turnIndex, 1) // Remove player

      if (game.players.length <= 1) { // Game ends
        const winner = game.players[0]
        let endMsg
        if (winner) {
          endMsg = ['所有人都倒下了，最终的幸存者是... ', segment.at(winner.id)]
        } else {
          // This case should be rare if game starts with >= 2 players and bullets > 0
          endMsg = "没有人活下来..."
        }
        await e.reply(endMsg)
        gameStates.delete(e.group_id)
        return
      }

      // If a player was removed, the turnIndex might now be out of bounds for the new array length.
      // Modulo operation handles this gracefully, ensuring the turn passes to the next logical player.
      game.turnIndex %= game.players.length
      this.announceTurn(e.group_id)
    }
  }

  async endGameByCreator (e) {
    if (!e.isGroup) return

    const game = gameStates.get(e.group_id)
    if (!game) return

    if (e.user_id === game.creatorId || e.isMaster) { // Allow bot master to end games
      if (game.timeout) {
        clearTimeout(game.timeout)
      }
      gameStates.delete(e.group_id)
      return e.reply('游戏已被强制解散。')
    } else {
      return e.reply('只有房主或机器人主人才能结束游戏哦。')
    }
  }
}