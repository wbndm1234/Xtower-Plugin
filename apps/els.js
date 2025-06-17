import plugin from '../../../lib/plugins/plugin.js'

// 使用 Map 存储每个群的游戏状态，key: group_id
const gameStates = new Map()
const INITIAL_SPINS = 4;

export class RussianRoulette extends plugin {
  constructor () {
    super({
      name: '俄罗斯转盘',
      dsc: '一场紧张刺激的运气游戏',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#俄罗斯(转|轮)盘([1-5])?$', fnc: 'createGame' },
        { reg: '^#加入(转|轮)盘$', fnc: 'joinGame' },
        { reg: '^#退出(转|轮)盘$', fnc: 'quitGame' },
        { reg: '^#开始(转|轮)盘$', fnc: 'manualStartGame' },
        { reg: '^#(旋转|转)$', fnc: 'spinCylinder', prehash: true },
        { reg: '^#开枪$', fnc: 'fire', prehash: true },
        { reg: '^#结束(转|轮)盘$', fnc: 'endGameByCreator' }
      ]
    })
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
    const bulletCount = Number(e.msg.match(/\d/)?.[0] || 1)
    const creator = { id: e.user_id, name: e.sender.card || e.sender.nickname, spinsLeft: INITIAL_SPINS }
    const game = {
      creatorId: e.user_id,
      phase: 'waiting',
      players: [creator],
      bulletCount: bulletCount,
      cylinder: [],
      currentPosition: 0,
      turnIndex: 0,
      timeout: null
    }
    gameStates.set(e.group_id, game)
    game.timeout = setTimeout(() => this.startGame(e.group_id), 30 * 1000)
    const maxPlayers = bulletCount + 1;
    const msg = [
      segment.at(e.user_id),
      ` 发起了一场【俄罗斯转盘】！\n`,
      `子弹数量：${bulletCount} / 6\n`,
      `最大人数：${maxPlayers}人\n`,
      `每人拥有 ${INITIAL_SPINS} 次旋转机会。\n`,
      `发送【#加入转盘】参与对局。\n`,
      `游戏将在30秒后或由房主【#开始转盘】后进行。`
    ]
    return e.reply(msg)
  }

  async joinGame (e) {
    if (!e.isGroup) return
    const game = gameStates.get(e.group_id)
    if (!game || game.phase !== 'waiting') return e.reply('当前没有可以加入的游戏。')
    const maxPlayers = game.bulletCount + 1;
    if (game.players.length >= maxPlayers) {
        return e.reply(`赌桌已满（${maxPlayers}/${maxPlayers}），无法加入！`)
    }
    if (game.players.some(p => p.id === e.user_id)) return e.reply('你已经在这场赌局中了。')
    game.players.push({ id: e.user_id, name: e.sender.card || e.sender.nickname, spinsLeft: INITIAL_SPINS })
    if (game.players.length === maxPlayers) {
      clearTimeout(game.timeout);
      await e.reply([segment.at(e.user_id), ` 已加入赌局，赌桌已满！游戏立即开始...`])
      this.startGame(e.group_id)
    } else {
      await e.reply([segment.at(e.user_id), ` 已加入赌局，祝你好运... (${game.players.length}/${maxPlayers})`])
    }
  }

  // ***** 关键修改点: 格式化 quitGame 函数 *****
  async quitGame(e) {
    if (!e.isGroup) return;

    const game = gameStates.get(e.group_id);
    if (!game || game.phase !== 'waiting') return;

    const playerIndex = game.players.findIndex(p => p.id === e.user_id);
    if (playerIndex === -1) return;

    // 如果退出的是房主
    if (game.creatorId === e.user_id) {
      clearTimeout(game.timeout);
      gameStates.delete(e.group_id);
      return e.reply('房主已退出，赌局解散。');
    }

    // 其他玩家退出
    game.players.splice(playerIndex, 1);
    return e.reply([segment.at(e.user_id), ' 已退出赌局。']);
  }

  // ***** 关键修改点: 格式化 manualStartGame 函数 *****
  async manualStartGame(e) {
    if (!e.isGroup) return;
  
    const game = gameStates.get(e.group_id);
    if (!game || game.phase !== 'waiting') {
      return e.reply('当前没有等待中的游戏可以开始。');
    }
    if (e.user_id !== game.creatorId) {
      return e.reply('只有房主才能开始游戏哦。');
    }
    if (game.players.length < 2) {
      return e.reply('参与人数不足2人，无法开始游戏。');
    }
  
    clearTimeout(game.timeout);
    this.startGame(e.group_id);
  }

  async startGame (groupId) {
    const game = gameStates.get(groupId); 
    if (!game || game.phase !== 'waiting') return; 
    if (game.players.length < 2) { 
      gameStates.delete(groupId); 
      Bot.sendGroupMsg(groupId, '参与人数不足，赌局已解散。'); 
      return; 
    } 
    game.players.sort(() => Math.random() - 0.5); 
    game.cylinder = Array(6).fill(0); 
    for (let i = 0; i < game.bulletCount; i++) game.cylinder[i] = 1; 
    game.cylinder.sort(() => Math.random() - 0.5); 
    game.phase = 'playing'; 
    game.currentPosition = Math.floor(Math.random() * 6); 
    logger.info(`[俄罗斯转盘] 群 ${groupId} 游戏开始，弹巢状态: ${game.cylinder.join('')}`); 
    await Bot.sendGroupMsg(groupId, '赌局已满，命运的齿轮开始转动...'); 
    this.announceTurn(groupId);
  }

  async announceTurn (groupId) {
    const game = gameStates.get(groupId); 
    if (!game || game.phase !== 'playing') return; 
    const currentPlayer = game.players[game.turnIndex]; 
    let actionPrompt; 
    if (currentPlayer.spinsLeft > 0) { 
      actionPrompt = `你还剩下 ${currentPlayer.spinsLeft} 次旋转机会。\n你可以【#旋转】或直接【#开枪】。`; 
    } else { 
      actionPrompt = `你已经没有旋转机会了，命运已定。\n请直接【#开枪】。`; 
    } 
    const msg = [ `轮到 `, segment.at(currentPlayer.id), ` 了。\n`, `当前幸存者: ${game.players.length}人。\n`, actionPrompt ]; 
    Bot.sendGroupMsg(groupId, msg);
  }

  async spinCylinder (e) {
    if (!this.isGameContext) return; 
    const game = gameStates.get(e.group_id); 
    const currentPlayer = game.players[game.turnIndex]; 
    if (currentPlayer.spinsLeft > 0) { 
      game.currentPosition = Math.floor(Math.random() * 6); 
      currentPlayer.spinsLeft--; 
      logger.info(`[俄罗斯转盘] 玩家 ${e.user_id} 旋转了弹巢，剩余${currentPlayer.spinsLeft}次`); 
      return e.reply(`你消耗了一次机会拨动了弹巢... 还剩下 ${currentPlayer.spinsLeft} 次旋转机会。`, true); 
    } else { 
      return e.reply('你已经没有旋转的机会了，开枪吧！', true); 
    }
  }

  async fire (e) {
    if (!this.isGameContext) return;
    
    const game = gameStates.get(e.group_id);
    const currentPlayer = game.players[game.turnIndex];
    
    if (game.cylinder[game.currentPosition] === 0) {
      game.currentPosition = (game.currentPosition + 1) % 6;
      game.turnIndex = (game.turnIndex + 1) % game.players.length;
      await e.reply([ '咔... ', segment.at(currentPlayer.id), ' 松了口气，你活了下来。\n', '左轮手枪递给了下一个人...' ], true);
      this.announceTurn(e.group_id);
    } else {
      game.cylinder[game.currentPosition] = -1; // 标记子弹已使用
      await e.reply([ '砰！一声枪响。\n', segment.at(currentPlayer.id), ' 倒在了桌上，赌局结束了... 对他而言。' ], true);
      game.players.splice(game.turnIndex, 1);
      
      if (game.players.length <= 1) {
        const winner = game.players[0];
        let endMsg;
        if(winner) {
          endMsg = [ '所有人都倒下了，最终的幸存者是... ', segment.at(winner.id) ];
        } else {
          endMsg = "没有人活下来...";
        }
        await e.reply(endMsg);
        gameStates.delete(e.group_id);
        return;
      }
      
      game.turnIndex %= game.players.length;
      this.announceTurn(e.group_id);
    }
  }

  // ***** 关键修改点: 格式化 endGameByCreator 函数 *****
  async endGameByCreator(e) {
    if (!e.isGroup) return;
  
    const game = gameStates.get(e.group_id);
    if (!game) return;
  
    if (e.user_id === game.creatorId) {
      if (game.timeout) {
        clearTimeout(game.timeout);
      }
      gameStates.delete(e.group_id);
      return e.reply('游戏已被房主强制解散。');
    } else {
      return e.reply('只有房主才能结束游戏哦。');
    }
  }
}