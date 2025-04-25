import plugin from '../../../lib/plugins/plugin.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { segment } from 'oicq' // 引入 segment

const PLUGIN_NAME = '狼人杀'

// --- 数据存储与管理 ---
const DATA_DIR = path.resolve(process.cwd(), '../data/werewolf')
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
        if (fs.existsSync(this.lockFile) && fs.readFileSync(this.lockFile, 'utf8') === process.pid.toString()) {
          fs.unlinkSync(this.lockFile)
        }
        this.acquired = false
      } catch (err) {
        console.warn(`释放锁文件 ${this.lockFile} 时出错: ${err.message}`)
        this.acquired = false;
      }
    }
  }
}


class GameDataManager {
    static async load(groupId) {
        const roomFile = path.join(ROOM_DATA_DIR, `${groupId}.json`)
        const lockFile = path.join(LOCK_DIR, `${groupId}.lock`)

        if (!fs.existsSync(roomFile)) {
            return null // 返回 null 表示没有游戏数据
        }

        const lock = new FileLock(lockFile)
        try {
            await lock.acquire()
            const data = fs.readFileSync(roomFile, 'utf8')
            return JSON.parse(data)
        } catch (err) {
            console.error(`[${PLUGIN_NAME}] 读取游戏数据失败 (${groupId}):`, err)
            // 如果解析失败，尝试删除可能损坏的文件
            try {
                fs.unlinkSync(roomFile);
            } catch (unlinkErr) {
                // ignore unlink error
            }
            return null; // 返回 null 表示数据读取失败或损坏
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
            if (fs.existsSync(roomFile)) {
                fs.unlinkSync(roomFile)
            }
        } catch (err) {
            console.error(`[${PLUGIN_NAME}] 删除游戏数据失败 (${groupId}):`, err)
        } finally {
            lock.release()
        }
    }

    // 生成唯一临时玩家编号
    static generateTempId(players) {
        let maxId = 0;
        players.forEach(p => {
            if (p.tempId && parseInt(p.tempId) > maxId) {
                maxId = parseInt(p.tempId);
            }
        });
        return String(maxId + 1).padStart(2, '0');
    }
}

class GameCleaner {
  static cleanupTimers = new Map()
  static CLEANUP_DELAY = 2 * 60 * 60 * 1000 // 2 小时

  static registerGame(groupId, instance) {
    this.cleanupGame(groupId) // 清理旧的定时器

    const timer = setTimeout(async () => {
      console.log(`[${PLUGIN_NAME}] 清理超时游戏 (${groupId})...`)
      const gameData = await GameDataManager.load(groupId)
      if (gameData && gameData.gameState && gameData.gameState.isRunning) {
          console.log(`[${PLUGIN_NAME}] 强制结束超时游戏 (${groupId})...`)
          const fakeEvent = {
              group_id: groupId,
              user_id: gameData.hostUserId,
              // 模拟 reply 方法，实际调用 sendSystemGroupMsg
              reply: (msg, quote = false, options = {}) => {
                    // 注意：这里的 instance 指的是 WerewolfPlugin 实例
                    instance.sendSystemGroupMsg(groupId, `[自动清理] ${msg}`)
              },
              sender: { card: '系统', nickname: '系统' },
              // 添加 isMaster 属性以满足权限检查（如果需要）
              isMaster: false, // 系统清理不是主人操作
              member: { // 模拟 member 对象
                  is_admin: false // 系统清理不是管理员操作
              }
          }
          await instance.forceEndGame(fakeEvent, true) // 添加一个标记表示是自动清理
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
    for (const [groupId, timer] of this.cleanupTimers) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()
  }
}

// --- 游戏核心逻辑 ---
class WerewolfGame {
    constructor(initialData = {}) {
        this.players = initialData.players || []; // { userId, nickname, role, isAlive, isProtected, tempId, isDying, votedBy: [], canReceiveMsg }
        this.roles = initialData.roles || {
            WEREWOLF: '狼人', VILLAGER: '村民', SEER: '预言家',
            WITCH: '女巫', HUNTER: '猎人', GUARD: '守卫'
        };
        this.gameState = initialData.gameState || {
            isRunning: false,
            currentPhase: null, // 用于记录猎人死亡时的大阶段 (NIGHT/DAY)
            currentDay: 0,
            deadPlayersToday: [],
            nightActions: {},
            votes: {},
            voteCounts: {},
            lastProtectedId: null,
            hostUserId: null,
            // 'waiting', 'starting', 'night_init', 'night_witch', 'day_speak', 'day_vote', 'hunter_shooting', 'ended'
            status: 'waiting',
            hunterNeedsToShoot: null,
            witchNeedsToAct: false,
            lastNightAttackTargetId: null,
            // 发言相关状态
            currentSpeakerUserId: null,   // 当前发言者的 userId
            speakingOrder: [],            // 本轮发言顺序 [userId1, userId2, ...]
            speakingDirection: true,      // 发言方向 true=正序, false=逆序
            currentSpeakerOrderIndex: -1, // 当前发言者在 speakingOrder 中的索引
            speechStartTime: null,        // 当前发言者开始时间（用于恢复计时器）

        };
        this.potions = initialData.potions || { save: true, kill: true };
        this.userGroupMap = initialData.userGroupMap || {};
        // gameTimeouts 不应保存在这里，由插件管理
    }

    // --- 初始化与玩家管理 ---
    initGame(hostUserId, hostNickname, groupId) {
        this.gameState.status = 'waiting';
        this.gameState.isRunning = false;
        this.gameState.currentDay = 0;
        this.gameState.deadPlayersToday = [];
        this.gameState.nightActions = {};
        this.gameState.votes = {};
        this.gameState.voteCounts = {};
        this.gameState.lastProtectedId = null;
        this.gameState.hostUserId = hostUserId;
        this.gameState.hunterNeedsToShoot = null;
        this.gameState.witchNeedsToAct = false;
        this.gameState.lastNightAttackTargetId = null;
        this.gameState.currentSpeakerUserId = null;
        this.gameState.speakingOrder = [];
        this.gameState.speakingDirection = true;
        this.gameState.currentSpeakerOrderIndex = -1;
        this.gameState.speechStartTime = null;
        this.players = [];
        this.potions = { save: true, kill: true };
        this.userGroupMap = {};
        this.addPlayer(hostUserId, hostNickname, groupId);
        return { success: true, message: `狼人杀游戏已创建！你是房主。\n发送 #加入狼人杀 参与游戏。` };
    }

    addPlayer(userId, nickname, groupId) { // 添加 groupId
        if (this.players.some(p => p.userId === userId)) {
            return { success: false, message: '你已经加入游戏了。' };
        }
        if (this.gameState.status !== 'waiting' && this.gameState.status !== 'starting') {
             return { success: false, message: '游戏已经开始或结束，无法加入。' };
        }
        const player = {
            userId: userId,
            nickname: nickname,
            role: null,
            isAlive: true,
            isProtected: false,
            tempId: GameDataManager.generateTempId(this.players),
            isDying: false,
            canSpeak: true,
            canVote: true,
            votedBy: [],
            canReceiveMsg: null,
        };
        this.players.push(player);
        this.userGroupMap[userId] = groupId;
        return { success: true, message: `${nickname} (${player.tempId}号) 加入了游戏。当前人数: ${this.players.length}` };
    }

    removePlayer(userId) {
        const playerIndex = this.players.findIndex(p => p.userId === userId);
        if (playerIndex === -1) {
            return { success: false, message: '你不在游戏中。' };
        }
        if (this.gameState.status !== 'waiting' && this.gameState.status !== 'starting') {
             return { success: false, message: '游戏已经开始，无法退出。请联系房主结束游戏。' };
        }
        const removedPlayer = this.players.splice(playerIndex, 1)[0];
        if (removedPlayer.userId === this.gameState.hostUserId) {
            this.gameState.status = 'ended';
            this.gameState.isRunning = false;
             return { success: true, message: `房主 ${removedPlayer.nickname} 退出了游戏，游戏已解散。`, gameDissolved: true };
        }
        delete this.userGroupMap[userId];
        return { success: true, message: `${removedPlayer.nickname} 退出了游戏。当前人数: ${this.players.length}` };
    }

    assignRoles() {
        const playerCount = this.players.length;
        if (playerCount < 6) { // 最少玩家数限制
            return { success: false, message: '玩家数量不足，至少需要6名玩家才能开始游戏。' };
        }

        let roleDistribution = this.calculateRoleDistribution(playerCount);
        let allRoles = [];
        Object.keys(roleDistribution).forEach(role => {
            for (let i = 0; i < roleDistribution[role]; i++) {
                allRoles.push(role);
            }
        });

        // 洗牌
        for (let i = allRoles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allRoles[i], allRoles[j]] = [allRoles[j], allRoles[i]];
        }

        // 分配角色给玩家
        this.players.forEach((player, index) => {
            player.role = allRoles[index];
            player.isAlive = true; // 确保开始时都是存活
            player.isProtected = false;
            player.isDying = false;
            player.canSpeak = true;
            player.canVote = true;
            player.votedBy = [];
        });

        return { success: true, rolesAssigned: true };
    }


    calculateRoleDistribution(playerCount) {
        // 基础配置：6-8人：2狼、预女猎守+村民
        // 9-11人：3狼、预女猎守+村民
        // 12+人：4狼、预女猎守+村民
        let werewolfCount;
        if (playerCount >= 12) werewolfCount = 4;
        else if (playerCount >= 9) werewolfCount = 3;
        else werewolfCount = 2; // 6-8人

        const godCount = 4; // 预女猎守固定

        let distribution = {
            WEREWOLF: werewolfCount,
            SEER: 1,
            WITCH: 1,
            HUNTER: 1,
            GUARD: 1
        };

        const assignedCount = werewolfCount + godCount;
        distribution.VILLAGER = playerCount - assignedCount;

        if (distribution.VILLAGER < 0) {
            distribution.VILLAGER = 0;
            console.warn(`[${PLUGIN_NAME}] 玩家人数 (${playerCount}) 过少，无法分配村民角色。`)
        }

        return distribution;
    }

    async prepareGameStart(pluginInstance) { // 改名并调整逻辑
        if (this.players.length < 6) {
            return { success: false, message: '玩家数量不足，至少需要6名玩家才能开始游戏。' };
        }
        if (this.gameState.status !== 'waiting') {
             return { success: false, message: '游戏状态不正确，无法开始。' };
        }

        this.gameState.status = 'starting';
        const groupId = this.userGroupMap[this.gameState.hostUserId];

        // 使用 sendSystemGroupMsg 发送系统消息
        await pluginInstance.sendSystemGroupMsg(groupId, "正在检查所有玩家私聊是否畅通...");
        let allReachable = true;
        let unreachablePlayers = [];
        for (const player of this.players) {
            const testMsg = `[${PLUGIN_NAME}] 游戏即将开始，测试私聊消息...`;
            // 调用新的 sendDirectMessage
            const reachable = await pluginInstance.sendDirectMessage(player.userId, testMsg, groupId, false);
            player.canReceiveMsg = reachable;
            if (!reachable) {
                allReachable = false;
                unreachablePlayers.push(player.nickname);
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (!allReachable) {
            this.gameState.status = 'waiting';
            await pluginInstance.sendSystemGroupMsg(groupId, `以下玩家私聊发送失败，无法开始游戏：\n${unreachablePlayers.join(', ')}\n请确保机器人已添加好友且未被屏蔽。`);
            return { success: false, message: '部分玩家私聊不可达，游戏无法开始。' };
        }

        await pluginInstance.sendSystemGroupMsg(groupId, "所有玩家私聊畅通！开始分配角色...");

        const assignResult = this.assignRoles();
        if (!assignResult.success) {
            this.gameState.status = 'waiting';
            return assignResult;
        }

        // sendRolesToPlayers 不再属于 Game 类的职责，移到插件类中
        // const sendRolesSuccess = await pluginInstance.sendRolesToPlayers(groupId, this);
        // if (!sendRolesSuccess) {
        //      this.gameState.status = 'ended';
        //      return { success: false, message: '发送角色信息失败，游戏结束。', gameEnded: true };
        // }

        // 分配角色成功，等待插件发送角色并开始游戏
        // 状态暂时保持 'starting'，由插件发送完角色后切换到 'night_init'
        return { success: true, message: `角色分配完毕！准备发送身份...` };
    }


    // --- 夜晚行动处理 ---
    recordNightAction(role, userId, action) {
        const allowedStatus = (role === 'WITCH') ? 'night_witch' : 'night_init';
        if (!this.gameState.isRunning || this.gameState.status !== allowedStatus) {
            const currentStatusDesc = this.gameState.status === 'night_init' ? '夜晚初始行动阶段' : (this.gameState.status === 'night_witch' ? '女巫行动阶段' : '非夜晚行动时间');
            return { success: false, message: `当前是 ${currentStatusDesc}，你的行动时机不符。` };
        }
        const player = this.players.find(p => p.userId === userId && p.isAlive);
        if (!player || player.role !== role) {
             return { success: false, message: '无效操作：你的身份或状态不符。' };
        }
        if (!this.gameState.nightActions[role]) {
            this.gameState.nightActions[role] = {};
        }

        let validation = { success: true };
        switch (role) {
            case 'WITCH':
                 validation = this.validateWitchAction(player, action);
                 break;
            case 'GUARD':
                 validation = this.validateGuardAction(player, action);
                 break;
            case 'WEREWOLF':
                validation = this.validateTarget(action.targetTempId);
                if (validation.success) action.targetUserId = validation.targetPlayer.userId;
                break;
            case 'SEER':
                validation = this.validateTarget(action.targetTempId);
                if (validation.success) action.targetUserId = validation.targetPlayer.userId;
                break;
        }

        if (!validation.success) {
            return validation;
        }

        this.gameState.nightActions[role][userId] = action;

        let feedbackMsg = `${this.roles[role]} ${player.nickname} (${player.tempId}号) 已收到你的行动。`; // 统一回复格式
        if (role === 'SEER' && validation.targetPlayer) {
             const targetRole = validation.targetPlayer.role;
             const isWerewolf = targetRole === 'WEREWOLF';
             feedbackMsg += `\n[查验结果] ${validation.targetPlayer.nickname}(${validation.targetPlayer.tempId}号) 的身份是 【${isWerewolf ? '狼人' : '好人'}】。`;
        }
        // 女巫和守卫的私聊确认已足够，无需额外结果反馈

        return { success: true, message: feedbackMsg, actionRecorded: true };
    }

    validateTarget(targetTempId) {
        const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive);
        if (!targetPlayer) {
            return { success: false, message: '目标玩家编号无效或玩家已死亡。' };
        }
        return { success: true, targetPlayer: targetPlayer };
    }


    validateWitchAction(witchPlayer, action) {
        const { type, targetTempId } = action;
        const validation = this.validateTarget(targetTempId);
        if (!validation.success) return validation;
        const targetPlayer = validation.targetPlayer;

        if (type === 'save') {
            if (!this.potions.save) return { success: false, message: '你的解药已经用完了。' };
            // 女巫不能自救 (大多数规则)
            if (targetPlayer.userId === witchPlayer.userId) return { success: false, message: '女巫不能自救。'};
            // 救人必须是当晚被袭击的目标（isDying 状态会在结算时设置）
            // 在记录阶段，我们暂时只验证药水状态和目标有效性
            // 实际是否救成功在结算阶段判断
        } else if (type === 'kill') {
            if (!this.potions.kill) return { success: false, message: '你的毒药已经用完了。' };
            // 不能毒自己
            if (targetPlayer.userId === witchPlayer.userId) return { success: false, message: '你不能毒自己。'};
            // 不能在同一晚既用解药又用毒药 (这个逻辑需要在处理完所有动作后检查，或者在recordNightAction外部控制)
        } else {
            return { success: false, message: '无效的女巫行动类型。' };
        }
        return { success: true, targetPlayer: targetPlayer }; // 返回目标玩家信息
    }

    validateGuardAction(guardPlayer, action) {
        const { targetTempId } = action;
         const validation = this.validateTarget(targetTempId);
         if (!validation.success) return validation;
         const targetPlayer = validation.targetPlayer;

        // 守卫不能连续两晚守护同一个人
        if (targetPlayer.userId === this.gameState.lastProtectedId) {
            return { success: false, message: '不能连续两晚守护同一个人。' };
        }
        // 守卫可以自守，但不能连续自守 (逻辑同上)
        // if (targetPlayer.userId === guardPlayer.userId && targetPlayer.userId === this.gameState.lastProtectedId) {
        //     return { success: false, message: '不能连续两晚守护自己。' };
        // }
        return { success: true, targetPlayer: targetPlayer };
    }


    // 结算夜晚行动
    processNightActions() {
        if (this.gameState.status !== 'night') return { message: '非夜晚，无法结算' };

        this.gameState.deadPlayersToday = []; // 清空今日死亡名单
        // 重置玩家状态
        this.players.forEach(p => {
            p.isProtected = false;
            p.isDying = false;
        });

        let nightSummary = ["夜晚结束，现在公布昨晚发生的事情："];
        let guardTargetId = null; // 守卫守护的目标 QQ 号
        let witchSavedPlayerId = null; // 女巫救的人 QQ 号
        let witchKilledPlayerId = null; // 女巫毒的人 QQ 号

        // 1. 处理守卫行动 (先确定谁被守护)
        const guardActions = this.gameState.nightActions['GUARD'] || {};
        for (const guardUserId in guardActions) {
            const action = guardActions[guardUserId];
             const targetPlayer = this.players.find(p => p.tempId === action.targetTempId && p.isAlive);
             if (targetPlayer) {
                targetPlayer.isProtected = true;
                 guardTargetId = targetPlayer.userId; // 记录被守卫的人
                 this.gameState.lastProtectedId = guardTargetId; // 更新守卫记录
                 // nightSummary.push(`守卫默默地守护了某人。`); // 通常不公布守卫信息
                 break; // 一般只有一个守卫
             }
        }

        // 2. 处理狼人行动 (标记可能死亡的人)
        const werewolfActions = this.gameState.nightActions['WEREWOLF'] || {};
        const killTargets = {}; // { targetUserId: count }
        for (const werewolfUserId in werewolfActions) {
             const action = werewolfActions[werewolfUserId];
             const targetPlayer = this.players.find(p => p.tempId === action.targetTempId && p.isAlive);
             if (targetPlayer) {
                 killTargets[targetPlayer.userId] = (killTargets[targetPlayer.userId] || 0) + 1;
             }
        }
         // 找到得票最多的目标 (处理分票情况，通常选择一个或随机)
        let killedByWerewolfId = null;
        let maxVotes = 0;
        const targetUserIds = Object.keys(killTargets);
        if (targetUserIds.length > 0) {
            targetUserIds.forEach(userId => {
                 if (killTargets[userId] > maxVotes) {
                     maxVotes = killTargets[userId];
                     killedByWerewolfId = userId;
                 }
            });
             // 如果平票，简单处理，选择第一个（或者可以随机选）
             if (targetUserIds.filter(id => killTargets[id] === maxVotes).length > 1) {
                 killedByWerewolfId = targetUserIds.find(id => killTargets[id] === maxVotes);
                 nightSummary.push(`狼人意见不统一，最终选择了攻击 ${this.getPlayerInfo(killedByWerewolfId)}。`);
             } else {
                 nightSummary.push(`狼人选择攻击了 ${this.getPlayerInfo(killedByWerewolfId)}。`);
             }

             const targetPlayer = this.players.find(p => p.userId === killedByWerewolfId);
             if (targetPlayer) {
                targetPlayer.isDying = true; // 标记为待死亡
             }
         } else {
              nightSummary.push("狼人今晚没有选择目标（或者目标无效）。");
         }


        // 3. 处理女巫行动 (救人解毒)
        const witchActions = this.gameState.nightActions['WITCH'] || {};
        let usedSave = false;
        let usedKill = false;
        for (const witchUserId in witchActions) {
            const action = witchActions[witchUserId];
            const targetPlayer = this.players.find(p => p.tempId === action.targetTempId && p.isAlive);
            if (!targetPlayer) continue; // 目标无效

            if (action.type === 'save' && this.potions.save && !usedSave) {
                // 检查是否救了被狼人标记的人
                if (targetPlayer.isDying) {
                    targetPlayer.isDying = false; // 救活
                    witchSavedPlayerId = targetPlayer.userId;
                    this.potions.save = false; // 消耗解药
                    usedSave = true;
                    // nightSummary.push(`女巫使用了灵丹妙药，救下了一人。`);
                } else {
                    // 救了没被标记的人，药白用了
                this.potions.save = false;
                usedSave = true;
                     // nightSummary.push(`女巫似乎用解药救了一个平安无事的人。`);
                }
            } else if (action.type === 'kill' && this.potions.kill && !usedKill) {
                // 如果已经用了救药，且规则不允许同时使用，则跳过毒人
                if (usedSave && action.cannotUseBoth) continue; // 假设 action 里有这个标记

                // 标记被毒杀
                   targetPlayer.isDying = true;
                   witchKilledPlayerId = targetPlayer.userId;
                this.potions.kill = false; // 消耗毒药
                usedKill = true;
                 // nightSummary.push(`女巫使用了致命的毒药。`);
            }
            // 假设只有一个女巫，处理完她的动作就跳出
            break;
        }

        // 4. 结算死亡 (结合守卫、狼杀、女巫救/毒)
        let deathMessages = [];
        this.players.forEach(p => {
            if (p.isDying) {
                let deathReason = "未知原因";
                // 检查是否被守护
                if (p.isProtected) {
                    p.isDying = false; // 被守卫救下
                    // 平安夜判断：如果狼人目标被守卫救下，且女巫没毒人
                    if (p.userId === killedByWerewolfId && !witchKilledPlayerId) {
                        nightSummary.push("昨晚是个平安夜。");
                    } else if (p.userId === killedByWerewolfId && witchKilledPlayerId){
                        // 狼杀目标被守卫救，但女巫毒了别人
                        // 继续下面的死亡结算
                    } else if (p.userId === witchKilledPlayerId) {
                        // 女巫毒的目标被守卫救下 (同守同救)
                        p.isDying = false; // 守卫优先，救下
                        nightSummary.push("昨晚发生了同守同救，被守护者平安无事。");
                    }
                } else {
                    // 没有被守护，确定死亡
                    p.isAlive = false;
                    if (p.userId === killedByWerewolfId && p.userId === witchKilledPlayerId) {
                        deathReason = "同时被狼人攻击和女巫下毒";
                    } else if (p.userId === killedByWerewolfId) {
                        deathReason = "被狼人攻击";
                    } else if (p.userId === witchKilledPlayerId) {
                        deathReason = "被女巫下毒";
                    }
                    this.gameState.deadPlayersToday.push({
                        userId: p.userId,
                        nickname: p.nickname,
                        tempId: p.tempId,
                        role: p.role, // 可选：是否公布角色
                        reason: deathReason
                    });
                deathMessages.push(`${p.nickname} (${p.tempId}号) 昨晚死亡了。`);
                     // 可以在这里添加遗言环节的触发
                }
            }
             // 重置 dying 状态
             p.isDying = false;
        });

        if (deathMessages.length === 0 && !nightSummary.includes("平安夜")) {
             // 如果没有死亡信息，并且不是明确的平安夜（比如狼人没杀人），也报告一下
             if (killedByWerewolfId && !this.players.find(p => p.userId === killedByWerewolfId)?.isAlive) {
                 // 这种情况是狼人目标刚好被女巫救了，上面已经处理，这里不用加信息
             } else if (!killedByWerewolfId && !witchKilledPlayerId) {
           nightSummary.push("昨晚无人死亡。");
             } else if (witchKilledPlayerId && !this.players.find(p => p.userId === witchKilledPlayerId)?.isAlive) {
                 // 女巫毒的人被救了，上面已处理
             }
             // 其他复杂情况，例如狼人空刀等
        }

        // 整合夜晚总结信息
        let finalSummary = nightSummary[0]; // "夜晚结束..."
        if (deathMessages.length > 0) {
             finalSummary += "\n" + deathMessages.join("\n");
        } else if (nightSummary.length > 1) {
             // 加入平安夜等信息
             finalSummary += "\n" + nightSummary.slice(1).join("\n");
        } else {
             finalSummary += "\n昨晚无人死亡。"; // 默认情况
        }


        // 清理夜晚行动记录
        this.gameState.nightActions = {};

        // 检查游戏是否结束
        const gameStatus = this.checkGameStatus();
        if (gameStatus.isEnd) {
            this.endGame(gameStatus.winner);
            return {
                 success: true,
                 summary: finalSummary + `\n游戏结束！${gameStatus.winner} 阵营获胜！`,
                 gameEnded: true,
                 winner: gameStatus.winner,
                 finalRoles: this.getFinalRoles() // 返回所有玩家最终身份
             };
        } else {
            // 进入白天
            this.gameState.status = 'day_speak'; // 或者直接进入 'day_vote'
            // 重置发言/投票状态
            this.players.forEach(p => {
                if (p.isAlive) {
                    p.canSpeak = true;
                    p.canVote = true;
                }
            });
             return { success: true, summary: finalSummary, gameEnded: false };
        }
    }


    // --- 白天行动处理 ---
    recordVote(voterUserId, targetTempId) {
        if (this.gameState.status !== 'day_vote') {
            return { success: false, message: '当前不是投票时间。' };
        }
        const voter = this.players.find(p => p.userId === voterUserId && p.isAlive);
        if (!voter) {
            return { success: false, message: '你无法投票（可能已死亡或不在游戏中）。' };
        }
         if (!voter.canVote) {
             return { success: false, message: '你已经投过票了。' };
         }

        const targetPlayer = this.players.find(p => p.tempId === targetTempId && p.isAlive);
        if (!targetPlayer) {
            return { success: false, message: '投票目标无效或已死亡。' };
        }

        // 不能投自己 (常见规则)
        if (voter.userId === targetPlayer.userId) {
            return { success: false, message: '不能投票给自己。' };
        }

        this.gameState.votes[voter.userId] = targetTempId;
        voter.canVote = false; // 标记已投票
        return { success: true, message: `${voter.nickname} (${voter.tempId}号) 投票给了 ${targetPlayer.nickname} (${targetTempId}号)。`, voteRecorded: true };
    }

    processVotes() {
        if (this.gameState.status !== 'day_vote') return { message: '非投票阶段，无法计票' };

        const voteCounts = {}; // { targetTempId: count }
        const voteDetails = {}; // { targetTempId: [voterNickname1, voterNickname2] }

        // 统计票数和投票详情
        this.players.filter(p => p.isAlive).forEach(voter => {
            const targetTempId = this.gameState.votes[voter.userId];
            if (targetTempId) {
                voteCounts[targetTempId] = (voteCounts[targetTempId] || 0) + 1;
                if (!voteDetails[targetTempId]) voteDetails[targetTempId] = [];
                voteDetails[targetTempId].push(`${voter.nickname}(${voter.tempId})`);
            } else {
                // 记录弃票
                 voteCounts['弃票'] = (voteCounts['弃票'] || 0) + 1;
                 if (!voteDetails['弃票']) voteDetails['弃票'] = [];
                 voteDetails['弃票'].push(`${voter.nickname}(${voter.tempId})`);
            }
        });

        this.gameState.voteCounts = voteCounts; // 保存计票结果

        let voteSummary = ["投票结果："];
        for (const targetTempId in voteCounts) {
            if (targetTempId === '弃票') continue;
            const targetPlayer = this.players.find(p => p.tempId === targetTempId);
            if (!targetPlayer) continue;
            const voters = voteDetails[targetTempId] || [];
             voteSummary.push(`${targetPlayer.nickname}(${targetTempId}号): ${voteCounts[targetTempId]}票 (${voters.join(', ')})`);
        }
         if (voteCounts['弃票']) {
             const voters = voteDetails['弃票'] || [];
             voteSummary.push(`弃票: ${voteCounts['弃票']}票 (${voters.join(', ')})`);
         }


        // 找出最高票数者
        let maxVotes = 0;
        let tiedPlayers = []; // 可能平票
        for (const targetTempId in voteCounts) {
             if (targetTempId === '弃票') continue;
             if (voteCounts[targetTempId] > maxVotes) {
                 maxVotes = voteCounts[targetTempId];
                 tiedPlayers = [targetTempId];
             } else if (voteCounts[targetTempId] === maxVotes && maxVotes > 0) {
                 tiedPlayers.push(targetTempId);
             }
        }

        let eliminatedPlayerInfo = null;
        let eliminatedHunterId = null; // 记录被投出的猎人ID

        if (tiedPlayers.length === 1) {
            // 唯一最高票，执行处决
            const eliminatedTempId = tiedPlayers[0];
            const eliminatedPlayer = this.players.find(p => p.tempId === eliminatedTempId);
            if (eliminatedPlayer) {
                eliminatedPlayer.isAlive = false;
                eliminatedPlayerInfo = `${eliminatedPlayer.nickname} (${eliminatedPlayer.tempId}号) 被投票出局。`;
                // 检查是否为猎人
                if (eliminatedPlayer.role === 'HUNTER') {
                    eliminatedHunterId = eliminatedPlayer.userId;
                }
            }
        } else if (tiedPlayers.length > 1) {
            // 平票，通常进入下一轮或PK发言再投 (简化处理：无人出局)
            eliminatedPlayerInfo = `出现平票 (${tiedPlayers.join(', ')}号)，本轮无人出局。`;
            // 可以增加PK环节逻辑
         } else {
            // 无人获得有效票数（例如全部弃票）
            eliminatedPlayerInfo = "所有人都弃票或投票无效，本轮无人出局。";
        }

         voteSummary.push(eliminatedPlayerInfo);

        // 清空本轮投票记录
        this.gameState.votes = {};
        this.gameState.voteCounts = {};


        // 检查游戏是否结束
        const gameStatus = this.checkGameStatus();
         if (gameStatus.isEnd) {
            this.endGame(gameStatus.winner);
             return {
                 success: true,
                 summary: voteSummary.join('\n') + `\n游戏结束！${gameStatus.winner} 阵营获胜！`,
                 gameEnded: true,
                 winner: gameStatus.winner,
                 finalRoles: this.getFinalRoles()
             };
         } else {
            // 进入下一天夜晚
            this.gameState.currentDay++;
            this.gameState.status = 'night';
             // 重置夜晚相关状态
                   this.gameState.nightActions = {};
             return { success: true, summary: voteSummary.join('\n'), gameEnded: false };
         }
     }

    // --- 游戏状态检查与结束 ---
    checkGameStatus() {
        const alivePlayers = this.players.filter(p => p.isAlive);
        const aliveWerewolves = alivePlayers.filter(p => p.role === 'WEREWOLF').length;
        const aliveGods = alivePlayers.filter(p => ['SEER', 'WITCH', 'HUNTER', 'GUARD'].includes(p.role)).length;
        const aliveVillagers = alivePlayers.filter(p => p.role === 'VILLAGER').length;
        const aliveHumans = aliveGods + aliveVillagers; // 好人阵营

        // 胜利条件：
        // 1. 屠边：所有神职死亡 或 所有村民死亡
        // 2. 屠城：所有好人阵营死亡 (狼人 >= 好人 通常意味着好人无法抗衡)
        // 3. 狼人死光：好人获胜

        if (aliveWerewolves === 0) {
            return { isEnd: true, winner: '好人' }; // 包含村民和神职
        }

        // 屠边判断 (根据具体规则调整)
        // if (aliveGods === 0) {
        //     return { isEnd: true, winner: '狼人' }; // 屠边神
        // }
        // if (aliveVillagers === 0 && aliveGods > 0) { // 如果屠光村民但神还在，游戏可能继续？看规则
        //     return { isEnd: true, winner: '狼人' }; // 屠边民
        // }

        // 屠城判断 (更通用的判断)
        if (aliveWerewolves >= aliveHumans) {
            return { isEnd: true, winner: '狼人' };
        }


        return { isEnd: false }; // 游戏继续
    }


    endGame(winner) {
        this.gameState.isRunning = false;
        this.gameState.status = 'ended';
        // 清理可能存在的计时器
        this.clearGameTimeouts();
        // 可以在这里记录游戏结果等
    }

    getFinalRoles() {
        return this.players.map(p => `${p.nickname}(${p.tempId}号): ${this.roles[p.role] || '未知'}`).join('\n');
    }

    // --- 辅助方法 ---
    getPlayerInfo(userIdOrTempId) {
        const player = this.players.find(p => p.userId === userIdOrTempId || p.tempId === userIdOrTempId);
        return player ? `${player.nickname}(${player.tempId}号)` : '未知玩家';
    }

     getAlivePlayerList() {
         return this.players.filter(p => p.isAlive)
             .map(p => `${p.tempId}号: ${p.nickname}`)
             .join('\n');
     }

     findPlayerByTempId(tempId) {
         return this.players.find(p => p.tempId === tempId);
     }

    // 清理游戏内的计时器
    clearGameTimeouts() {
        for (const key in this.gameTimeouts) {
            clearTimeout(this.gameTimeouts[key]);
            delete this.gameTimeouts[key];
        }
    }

    // 获取游戏数据用于保存
    getGameData() {
        const dataToSave = {
            players: this.players,
            roles: this.roles,
            gameState: this.gameState,
            potions: this.potions,
            userGroupMap: this.userGroupMap, // 保存映射关系
        };
        // gameTimeouts 不保存
        return dataToSave;
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
                // 夜晚行动指令
                 { reg: '^#?杀\\s*(\\d+)$', fnc: 'handleWerewolfKill', permission: 'private' },
                 { reg: '^#?查验\\s*(\\d+)$', fnc: 'handleSeerCheck', permission: 'private' },
                 { reg: '^#?救\\s*(\\d+)$', fnc: 'handleWitchSave', permission: 'private' },
                 { reg: '^#?毒\\s*(\\d+)$', fnc: 'handleWitchKill', permission: 'private' },
                 { reg: '^#?守\\s*(\\d+)$', fnc: 'handleGuardProtect', permission: 'private' },
                // 白天行动指令
                 { reg: '^#结束发言$', fnc: 'handleEndSpeech' },
                 { reg: '^#投票\\s*(\\d+)$', fnc: 'handleVote' },
                // 猎人开枪指令
                { reg: '^#开枪\\s*(\\d+)$', fnc: 'handleHunterShoot', permission: 'private' },
                // 调试或管理指令
                { reg: '^#结束夜晚初始阶段$', fnc: 'manualEndNightInit', permission: 'master'},
                { reg: '^#结束女巫阶段$', fnc: 'manualEndWitch', permission: 'master'},
                { reg: '^#结束发言阶段$', fnc: 'manualEndSpeechTurn', permission: 'master'},
                 { reg: '^#结束投票$', fnc: 'manualEndVote', permission: 'master'},
                 { reg: '^#结束猎人开枪$', fnc: 'manualEndHunterShoot', permission: 'master'},
            ]
        });

        this.gameInstances = new Map();
        this.actionTimeouts = new Map();
        this.NIGHT_INIT_TIMEOUT = 70 * 1000;
        this.WITCH_ACTION_TIMEOUT = 30 * 1000;
        this.SPEECH_TIMEOUT = 45 * 1000;
        this.VOTE_TIMEOUT = 60 * 1000;
        this.HUNTER_SHOOT_TIMEOUT = 30 * 1000;

        process.on('exit', () => this.cleanup());
        process.on('SIGINT', () => this.cleanup());
    }

    // --- 核心方法 ---
    async getGameInstance(groupId, createIfNotExist = false, hostUserId = null, hostNickname = null) {
        let game = this.gameInstances.get(groupId);
        if (!game) {
            const gameData = await GameDataManager.load(groupId);
            if (gameData) {
                game = new WerewolfGame(gameData);
                this.gameInstances.set(groupId, game);
                console.log(`[${PLUGIN_NAME}] 从文件恢复游戏 (${groupId})`);
                 if (game.gameState.isRunning) {
                    GameCleaner.registerGame(groupId, this);
                 }
                 this.resumeGameTimers(groupId, game);
            } else if (createIfNotExist && hostUserId && hostNickname) {
                game = new WerewolfGame();
                game.initGame(hostUserId, hostNickname, groupId);
                this.gameInstances.set(groupId, game);
                await GameDataManager.save(groupId, game.getGameData());
                console.log(`[${PLUGIN_NAME}] 创建新游戏实例 (${groupId})`);
                GameCleaner.registerGame(groupId, this);
            }
        }
        return game;
    }

    async saveGame(groupId, game) {
        if (game) {
            await GameDataManager.save(groupId, game.getGameData());
        }
    }

    async deleteGame(groupId) {
        this.clearActionTimeout(groupId); // 清理计时器
        GameCleaner.cleanupGame(groupId); // 清理自动结束任务
        this.gameInstances.delete(groupId);
        await GameDataManager.delete(groupId);
        console.log(`[${PLUGIN_NAME}] 已删除游戏数据 (${groupId})`);
    }

     resumeGameTimers(groupId, game) {
        if (!game || !game.gameState.isRunning) return;

        const now = Date.now();
        const currentStatus = game.gameState.status;
        let remaining = -1;
        let timeoutType = null;
        let startTime = null;
        let duration = 0;

        if (currentStatus === 'night_init' && game.gameState.nightStartTime) {
            timeoutType = 'night_init'; startTime = game.gameState.nightStartTime; duration = this.NIGHT_INIT_TIMEOUT;
        } else if (currentStatus === 'night_witch' && game.gameState.witchStartTime) {
            timeoutType = 'night_witch'; startTime = game.gameState.witchStartTime; duration = this.WITCH_ACTION_TIMEOUT;
        } else if (currentStatus === 'day_speak' && game.gameState.speechStartTime) {
            timeoutType = 'speech'; startTime = game.gameState.speechStartTime; duration = this.SPEECH_TIMEOUT;
        } else if (currentStatus === 'day_vote' && game.gameState.voteStartTime) {
            timeoutType = 'vote'; startTime = game.gameState.voteStartTime; duration = this.VOTE_TIMEOUT;
        } else if (currentStatus === 'hunter_shooting' && game.gameState.hunterShootStartTime) {
            timeoutType = 'hunter_shoot'; startTime = game.gameState.hunterShootStartTime; duration = this.HUNTER_SHOOT_TIMEOUT;
        }


        if (timeoutType && startTime) {
            const elapsed = now - startTime;
            remaining = duration - elapsed;
            if (remaining > 0) {
                console.log(`[${PLUGIN_NAME}] 恢复 ${timeoutType} 计时器 (${groupId}), 剩余 ${Math.round(remaining/1000)}s`);
                this.setActionTimeout(groupId, timeoutType, remaining);
            } else {
                console.log(`[${PLUGIN_NAME}] 恢复 ${timeoutType} 计时器 (${groupId}), 已超时，立即结算`);
                if (timeoutType === 'night_init') this.processNightInitEnd(groupId, game);
                else if (timeoutType === 'night_witch') this.processWitchEnd(groupId, game, false);
                else if (timeoutType === 'speech') this.processSpeechTimeout(groupId, game);
                else if (timeoutType === 'vote') this.processVoteEnd(groupId, game);
                else if (timeoutType === 'hunter_shoot') this.processHunterShootEnd(groupId, game);
            }
        }
    }

    // --- 插件命令处理 ---
    async createGame(e) {
        const groupId = e.group_id;
        if (!groupId) return e.reply("请在群聊中使用此命令。");

        let game = await this.getGameInstance(groupId);
        if (game && game.gameState.status !== 'ended') {
             // 使用 e.reply 回复，通常不引用原消息
             return e.reply(`本群已有一个正在进行或等待中的狼人杀游戏（状态: ${game.gameState.status}）。\n请先输入 #结束狼人杀 结束当前游戏。`, false);
        }

        game = await this.getGameInstance(groupId, true, e.user_id, e.sender.card || e.sender.nickname);
        if (game) {
            const initResult = game.initGame(e.user_id, e.sender.card || e.sender.nickname, groupId);
            // 回复创建成功消息，可以考虑引用触发命令的消息
            return e.reply(initResult.message, true);
        } else {
            return e.reply("创建游戏失败，请稍后再试。", true);
        }
    }

    async joinGame(e) {
        const groupId = e.group_id;
        if (!groupId) return e.reply("请在群聊中使用此命令。", true);

        const game = await this.getGameInstance(groupId);
        if (!game || game.gameState.status === 'ended') {
            return e.reply("本群当前没有等待加入的狼人杀游戏。", true);
        }
        // 允许在 'waiting' 或 'starting' 状态加入
        if (game.gameState.status !== 'waiting' && game.gameState.status !== 'starting') {
             return e.reply("游戏已经开始或结束，无法加入了哦。", true);
        }

        const result = game.addPlayer(e.user_id, e.sender.card || e.sender.nickname, groupId);
        await this.saveGame(groupId, game);
        // 回复加入结果，考虑 at 发送者
        return e.reply(result.message, false, { at: true });
    }

    async leaveGame(e) {
        const groupId = e.group_id;
        if (!groupId) return e.reply("请在群聊中使用此命令。", true);

        const game = await this.getGameInstance(groupId);
        if (!game || game.gameState.status === 'ended') {
            return e.reply("本群当前没有狼人杀游戏。", true);
        }
         if (game.gameState.status !== 'waiting' && game.gameState.status !== 'starting') {
             return e.reply("游戏已经开始，无法退出了。", true);
         }

        const result = game.removePlayer(e.user_id);
        if (result.success) {
            if (result.gameDissolved) {
                await this.deleteGame(groupId);
            } else {
                 await this.saveGame(groupId, game);
            }
        }
        // 回复退出结果，考虑 at 发送者
        return e.reply(result.message, false, { at: true });
    }

    async startGame(e) { // 触发准备流程
        const groupId = e.group_id;
        if (!groupId) return e.reply("请在群聊中使用此命令。", true);

        const game = await this.getGameInstance(groupId);
        if (!game || game.gameState.status === 'ended') {
            return e.reply("本群当前没有狼人杀游戏。", true);
        }
        if (game.gameState.hostUserId !== e.user_id) {
            return e.reply("只有房主才能开始游戏。", true);
        }
         if (game.gameState.status !== 'waiting') {
             return e.reply(`游戏当前状态为 ${game.gameState.status}，无法开始。`, true);
         }

        // 调用 prepareGameStart 获取准备结果
        const prepareResult = await game.prepareGameStart(this);
        await this.saveGame(groupId, game);

        if (!prepareResult.success) {
             if (prepareResult.gameEnded) {
                 await this.deleteGame(groupId);
             }
            return e.reply(prepareResult.message, true); // 回复准备失败消息
        }

        // 准备成功，发送角色信息
        await e.reply(prepareResult.message, true); // 回复 "角色分配完毕！准备发送身份..."
        const sendRolesSuccess = await this.sendRolesToPlayers(groupId, game);

        if (sendRolesSuccess) {
             // 发送成功，正式开始游戏
             game.gameState.isRunning = true;
             game.gameState.status = 'night_init'; // 进入夜晚初始阶段
             game.gameState.currentPhase = 'NIGHT';
             game.gameState.currentDay = 1;
             // ... (其他状态在 prepareGameStart 中已设置或 game init 时初始化)
             await this.saveGame(groupId, game); // 保存最终开始状态
             await this.startNightInitPhase(groupId, game); // 开始夜晚第一阶段
        } else {
            // 发送角色失败，回滚状态或结束游戏
            game.gameState.status = 'ended'; // 假设失败则结束
            await this.saveGame(groupId, game);
            await this.deleteGame(groupId);
            await e.reply("发送部分玩家角色信息失败，游戏无法开始，已强制结束。", true);
        }
    }

    async sendRolesToPlayers(groupId, game) {
        await this.sendSystemGroupMsg(groupId, "正在私聊发送角色身份和临时编号，请注意查收...");
        let allSent = true;
        for (const player of game.players) {
            const roleName = game.roles[player.role] || '未知角色';
            const message = `你在本局狼人杀中的身份是：【${roleName}】\n你的临时编号是：【${player.tempId}号】\n请牢记你的身份和编号！`;
            // 使用 sendDirectMessage
            const success = await this.sendDirectMessage(player.userId, message, groupId);
            if (!success) {
                 // 不再在群里发警告，由 sendDirectMessage 内部处理
                 // await this.sendSystemGroupMsg(groupId, `[警告] 发送身份给玩家 ${player.nickname} 失败...`);
                 allSent = false; // 标记发送失败
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (allSent) {
            await this.sendSystemGroupMsg(groupId, "所有身份已发送完毕！");
        } else {
            await this.sendSystemGroupMsg(groupId, "部分玩家身份发送失败，请检查私聊。游戏仍将开始。");
            // 即使部分失败，也认为可以开始，避免卡住流程
        }
        return true; // 调整为总是返回 true，让 startGame 继续
    }


     async startNightInitPhase(groupId, game) {
         if (!game || game.gameState.status !== 'night_init') return;

         const day = game.gameState.currentDay;
         await this.sendSystemGroupMsg(groupId, `--- 第 ${day} 天 - 夜晚 ---`);
         await this.sendSystemGroupMsg(groupId, `天黑请闭眼... (初始行动阶段)`);

         let actionPrompts = [];
         const alivePlayers = game.players.filter(p => p.isAlive);
         const alivePlayerList = game.getAlivePlayerList();

         alivePlayers.forEach(player => {
             let prompt = null;
             switch (player.role) {
                 case 'WEREWOLF': prompt = `狼人请行动。\n请私聊我：杀 [目标编号]\n${alivePlayerList}`; break;
                 case 'SEER': prompt = `预言家请行动。\n请私聊我：查验 [目标编号]\n${alivePlayerList}`; break;
                 case 'GUARD':
                     let guardPrompt = `守卫请行动。\n`;
                     if (game.gameState.lastProtectedId) {
                         const lastProtected = game.getPlayerInfo(game.gameState.lastProtectedId);
                         guardPrompt += `（你上晚守护了 ${lastProtected}，不能连守）\n`;
                     }
                     guardPrompt += `请私聊我：守 [目标编号]\n${alivePlayerList}`;
                     prompt = guardPrompt;
                     break;
                 case 'WITCH':
                     prompt = "女巫请睁眼，请等待夜晚初步结算结果后再行动...";
                     break;
             }
             if (prompt) actionPrompts.push({ userId: player.userId, message: prompt });
         });

         for (const p of actionPrompts) {
             await this.sendDirectMessage(p.userId, p.message, groupId);
             await new Promise(resolve => setTimeout(resolve, 200));
         }

         game.gameState.nightStartTime = Date.now();
         await this.saveGame(groupId, game);
         this.setActionTimeout(groupId, 'night_init', this.NIGHT_INIT_TIMEOUT);

         await this.sendSystemGroupMsg(groupId, `夜晚初始行动阶段开始，相关角色有 ${this.NIGHT_INIT_TIMEOUT / 1000} 秒操作时间。`);
     }

     async startWitchPhase(groupId, game) {
          if (!game || game.gameState.status !== 'night_witch') return;
          const witchPlayer = game.players.find(p => p.role === 'WITCH' && p.isAlive);
          if (!witchPlayer) {
              console.log(`[${PLUGIN_NAME}] 没有存活的女巫，跳过女巫阶段 (${groupId})`);
              await this.processWitchEnd(groupId, game, false);
              return;
          }

          const alivePlayerList = game.getAlivePlayerList();
          let witchPrompt = `女巫请行动。\n`;
          const targetId = game.gameState.lastNightAttackTargetId;
          if (targetId) {
              const targetInfo = game.getPlayerInfo(targetId);
              witchPrompt += `昨晚 ${targetInfo} 被袭击了。\n`;
          } else {
              witchPrompt += `昨晚无人被袭击（或袭击目标被守护）。\n`;
          }
           witchPrompt += `药剂状态：解药 ${game.potions.save ? '可用' : '已用'}，毒药 ${game.potions.kill ? '可用' : '已用'}。\n`;
           if (game.potions.save) witchPrompt += `使用解药请私聊我：救 [目标编号]\n`;
           if (game.potions.kill) witchPrompt += `使用毒药请私聊我：毒 [目标编号]\n`;
           witchPrompt += `你有 ${this.WITCH_ACTION_TIMEOUT / 1000} 秒时间。\n${alivePlayerList}`;

           await this.sendDirectMessage(witchPlayer.userId, witchPrompt, groupId);

           game.gameState.witchStartTime = Date.now();
           await this.saveGame(groupId, game);
           this.setActionTimeout(groupId, 'night_witch', this.WITCH_ACTION_TIMEOUT);

           await this.sendSystemGroupMsg(groupId, `等待女巫行动... (${this.WITCH_ACTION_TIMEOUT / 1000} 秒)`);
     }


    async handleNightAction(e, role, actionData) {
         const userId = e.user_id;
         const gameInfo = await this.findUserActiveGame(userId, role); // 返回 { groupId, instance }
         if (!gameInfo || !gameInfo.instance) {
             const expectedPhase = (role === 'WITCH') ? '女巫行动' : '夜晚初始行动';
             // 使用 e.reply 回复私聊消息
             return e.reply(`未找到你参与的、处于 ${expectedPhase} 阶段的游戏，或者你的身份/状态不符。`);
         }
         const groupId = gameInfo.groupId;
         const gameInstance = gameInfo.instance;

         const timeoutInfo = this.actionTimeouts.get(groupId);
         const expectedTimeoutType = (role === 'WITCH') ? 'night_witch' : 'night_init';
         if (!timeoutInfo || timeoutInfo.type !== expectedTimeoutType) {
             return e.reply(`当前不是你的行动时间或行动时间已结束。`);
         }

         const result = gameInstance.recordNightAction(role, userId, actionData);
         await this.saveGame(groupId, gameInstance); // 保存行动记录
         // 使用 e.reply 回复私聊，包含确认信息或查验结果
         await e.reply(result.message);

         if (!result.success) {
             // 如果 recordNightAction 内部验证失败，result.message 会包含原因
             // e.reply 已经发送了失败信息，这里不需要再发
         }
     }

    async findUserActiveGame(userId, role = null) {
         // ... (不变) ...
         for (const [gid, gInstance] of this.gameInstances.entries()) {
             const player = gInstance.players.find(p => p.userId === userId && p.isAlive);
             if (!player) continue;

             const currentStatus = gInstance.gameState.status;
             const isPlayerRoleMatch = role ? player.role === role : true;

             let isActivePhase = false;
             if (role === 'WITCH') isActivePhase = currentStatus === 'night_witch';
             else if (role === 'WEREWOLF' || role === 'SEER' || role === 'GUARD') isActivePhase = currentStatus === 'night_init';
             else if (role === 'HUNTER') isActivePhase = currentStatus === 'hunter_shooting' && gInstance.gameState.hunterNeedsToShoot === userId;
             // 对于 handleEndSpeech (role=null), 检查 day_speak
             else if (role === null && currentStatus === 'day_speak') isActivePhase = true;
             // 对于 handleVote (role=null), 检查 day_vote
             else if (role === null && currentStatus === 'day_vote') isActivePhase = true;


             if (isPlayerRoleMatch && isActivePhase) {
                 return { groupId: gid, instance: gInstance };
             }
         }
         return null;
     }


    async handleEndSpeech(e) {
        const groupId = e.group_id;
        if (!groupId) return; // 必须在群内

        const game = await this.getGameInstance(groupId);
        if (!game || game.gameState.status !== 'day_speak') {
            return; // 静默处理
        }
        if (game.gameState.currentSpeakerUserId !== e.user_id) {
            // 使用 e.reply at 发送者
            return e.reply("现在不是你的发言时间哦。", false, { at: true });
        }

        this.clearActionTimeout(groupId); // 清除当前发言计时器

        const speaker = game.getCurrentSpeaker();
        // 使用 sendSystemGroupMsg 发送系统消息
        await this.sendSystemGroupMsg(groupId, `${speaker?.nickname || '玩家'} (${speaker?.tempId || '??'}号) 已结束发言。`);

        const nextSpeakerUserId = game.moveToNextSpeaker();
        await this.saveGame(groupId, game);

        if (nextSpeakerUserId) {
             await this.announceAndSetSpeechTimer(groupId, game);
        } else {
            // 使用 sendSystemGroupMsg 发送系统消息
            await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
            await this.startVotingPhase(groupId, game);
        }
    }


    async handleVote(e) {
        const groupId = e.group_id;
        if (!groupId) return e.reply("请在群聊中使用此命令。", true);

        const game = await this.getGameInstance(groupId);
        if (!game || game.gameState.status !== 'day_vote') {
            return e.reply("当前不是投票时间。", true);
        }
         const timeoutInfo = this.actionTimeouts.get(groupId);
         if (!timeoutInfo || timeoutInfo.type !== 'vote') {
             return e.reply("投票时间已结束。", true);
         }

        const match = e.msg.match(/^#投票\s*(\d+)$/);
        if (!match) return; // 格式不符，不回复
        const targetTempId = match[1].padStart(2, '0');

        const result = game.recordVote(e.user_id, targetTempId);
        await this.saveGame(groupId, game); // 保存投票记录
        // 使用 e.reply 回复投票结果或失败信息，at 发送者
        await e.reply(result.message, false, { at: true });

        // 检查是否可以提前结束投票（可选）
        // ...
    }

    async handleHunterShoot(e) {
        const userId = e.user_id;
        const gameInfo = await this.findUserActiveGame(userId, 'HUNTER');
        if (!gameInfo || !gameInfo.instance) {
            return e.reply("现在不是你开枪的时间或你不是猎人。");
        }
        const groupId = gameInfo.groupId;
        const game = gameInfo.instance;

        const timeoutInfo = this.actionTimeouts.get(groupId);
        if (!timeoutInfo || timeoutInfo.type !== 'hunter_shoot') {
            return e.reply("开枪时间已结束。");
        }

        const match = e.msg.match(/^#开枪\s*(\d+)$/);
        if (!match) return; // 格式不对，不回复
        const targetTempId = match[1].padStart(2, '0');

        this.clearActionTimeout(groupId); // 清除计时器

        const result = game.processHunterShoot(userId, targetTempId);
        await this.saveGame(groupId, game);
        // 使用 sendSystemGroupMsg 发送公开的开枪结果
        await this.sendSystemGroupMsg(groupId, result.summary);

        if (result.gameEnded) {
            await this.sendSystemGroupMsg(groupId, "游戏已结束，公布所有玩家身份：\n" + game.getFinalRoles());
            await this.deleteGame(groupId);
        } else {
             await this.transitionToNextPhase(groupId, game);
        }
    }


     setActionTimeout(groupId, type, duration) {
        this.clearActionTimeout(groupId); // 清除旧的计时器

        const timeoutId = setTimeout(async () => {
            console.log(`[${PLUGIN_NAME}] ${type} 时间到 (${groupId})`);
            const existingTimeout = this.actionTimeouts.get(groupId);
            if (existingTimeout && existingTimeout.timeoutId === timeoutId) {
               this.actionTimeouts.delete(groupId);
            } else {
                console.log(`[${PLUGIN_NAME}] ${type} 超时回调触发，但记录已不存在或不匹配 (${groupId})，跳过处理。`);
                return;
            }

            const game = await this.getGameInstance(groupId);
            if (!game || game.gameState.status !== type) {
                console.log(`[${PLUGIN_NAME}] ${type} 超时回调触发，但游戏不存在或状态已改变 (${groupId})，跳过处理。`);
                return;
            }

            switch (type) {
                case 'night_init': await this.processNightInitEnd(groupId, game); break;
                case 'night_witch': await this.processWitchEnd(groupId, game, false); break;
                case 'speech': await this.processSpeechTimeout(groupId, game); break;
                case 'vote': await this.processVoteEnd(groupId, game); break;
                case 'hunter_shoot': await this.processHunterShootEnd(groupId, game); break;
            }
        }, duration);

        this.actionTimeouts.set(groupId, { type: type, timeoutId: timeoutId });
    }

    clearActionTimeout(groupId) {
        const timeoutInfo = this.actionTimeouts.get(groupId);
        if (timeoutInfo) {
            clearTimeout(timeoutInfo.timeoutId);
            this.actionTimeouts.delete(groupId);
        }
    }

    async processNightInitEnd(groupId, game) {
        if (!game || game.gameState.status !== 'night_init') return;
        console.log(`[${PLUGIN_NAME}] 处理夜晚初始阶段结束 (${groupId})`);
        await this.sendSystemGroupMsg(groupId, "夜晚初始行动时间结束，正在结算...");

        const result = game.processNightInitActions();
        await this.saveGame(groupId, game);

        if (result.success) {
            await this.startWitchPhase(groupId, game);
        } else {
             await this.sendSystemGroupMsg(groupId, `结算出错: ${result.message}`);
        }
    }

    async processWitchEnd(groupId, game, witchActionTaken = false) {
        if (!game || game.gameState.status !== 'night_witch') return;
        console.log(`[${PLUGIN_NAME}] 处理女巫行动结束 (${groupId})`);
        if (!witchActionTaken) {
            await this.sendSystemGroupMsg(groupId, "女巫行动时间结束，进行最终结算...");
        }

        const result = game.processWitchAndFinalizeNight(witchActionTaken);
        await this.saveGame(groupId, game);
        await this.sendSystemGroupMsg(groupId, result.summary);

         if (result.gameEnded) {
             await this.sendSystemGroupMsg(groupId, "游戏已结束，公布所有玩家身份：\n" + game.getFinalRoles());
             await this.deleteGame(groupId);
         } else {
              await this.transitionToNextPhase(groupId, game);
         }
    }

    async processSpeechTimeout(groupId, game) {
        if (!game || game.gameState.status !== 'day_speak') return;

        const timedOutSpeaker = game.getCurrentSpeaker();
        if (!timedOutSpeaker) return;

        await this.sendSystemGroupMsg(groupId, `${timedOutSpeaker.nickname}(${timedOutSpeaker.tempId}号) 发言时间到。`);

        const nextSpeakerUserId = game.moveToNextSpeaker();
        await this.saveGame(groupId, game);

        if (nextSpeakerUserId) {
            await this.announceAndSetSpeechTimer(groupId, game);
        } else {
            await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
            await this.startVotingPhase(groupId, game);
        }
    }

    async announceAndSetSpeechTimer(groupId, game) {
        if (!game || game.gameState.status !== 'day_speak' || !game.gameState.currentSpeakerUserId) return;
        const speaker = game.getCurrentSpeaker();
        if (!speaker) return;

        // 考虑 at 发言者
        const msg = [
            segment.at(speaker.userId), // at 发言者
            ` 请开始发言 (${this.SPEECH_TIMEOUT / 1000}秒)。`
        ];
        await this.sendSystemGroupMsg(groupId, msg);

        await this.saveGame(groupId, game); // speechStartTime 已在 moveToNextSpeaker 更新
        this.setActionTimeout(groupId, 'speech', this.SPEECH_TIMEOUT);
    }


    async startDayPhase(groupId, game) {
        if (!game) return;
        if (game.gameState.status !== 'day_speak' && game.gameState.status !== 'hunter_shooting') {
            console.warn(`[${PLUGIN_NAME}] 尝试在非预期状态 (${game.gameState.status}) 进入白天发言阶段 (${groupId})`);
            return;
        }
         game.gameState.status = 'day_speak';

        const day = game.gameState.currentDay;
        await this.sendSystemGroupMsg(groupId, `--- 第 ${day} 天 - 白天 ---`);

        const speechStartResult = game.startSpeechRound();
        await this.saveGame(groupId, game);

        if (speechStartResult.success) {
            await this.sendSystemGroupMsg(groupId, speechStartResult.message);
            if (speechStartResult.nextSpeakerUserId) {
                await this.announceAndSetSpeechTimer(groupId, game);
            } else if (speechStartResult.nextStatus === 'day_vote') {
                await this.startVotingPhase(groupId, game);
            }
        } else {
            await this.sendSystemGroupMsg(groupId, `开始发言阶段时出错: ${speechStartResult.message}`);
        }
    }

    async startVotingPhase(groupId, game) {
        if (!game || game.gameState.status !== 'day_vote') {
            if (game.gameState.status !== 'day_speak') {
                console.warn(`[${PLUGIN_NAME}] 尝试在非预期状态 (${game.gameState.status}) 进入投票阶段 (${groupId})`);
            }
            game.gameState.status = 'day_vote';
        }
        await this.saveGame(groupId, game);

        const alivePlayerList = game.getAlivePlayerList();
        await this.sendSystemGroupMsg(groupId, `现在开始投票，请选择你要投出的人。\n发送 #投票 [目标编号]\n你有 ${this.VOTE_TIMEOUT / 1000} 秒时间。\n存活玩家列表：\n${alivePlayerList}`);

        game.gameState.voteStartTime = Date.now();
        await this.saveGame(groupId, game);
        this.setActionTimeout(groupId, 'vote', this.VOTE_TIMEOUT);
    }


    async processVoteEnd(groupId, game) {
        if (!game || game.gameState.status !== 'day_vote') return;
        console.log(`[${PLUGIN_NAME}] 处理投票结束 (${groupId})`);

        await this.sendSystemGroupMsg(groupId, "投票时间结束，正在计票...");
        const result = game.processVotes();
        await this.saveGame(groupId, game);
        await this.sendSystemGroupMsg(groupId, result.summary);

        if (result.gameEnded) {
             await this.sendSystemGroupMsg(groupId, "游戏已结束，公布所有玩家身份：\n" + game.getFinalRoles());
             await this.deleteGame(groupId);
        } else {
            await this.transitionToNextPhase(groupId, game);
        }
    }

     async processHunterShootEnd(groupId, game) {
        if (!game || game.gameState.status !== 'hunter_shooting') return;
        console.log(`[${PLUGIN_NAME}] 处理猎人开枪超时 (${groupId})`);

        const result = game.processHunterShootTimeout();
        await this.saveGame(groupId, game);
        await this.sendSystemGroupMsg(groupId, result.summary);

        if (result.gameEnded) {
            await this.sendSystemGroupMsg(groupId, "游戏已结束，公布所有玩家身份：\n" + game.getFinalRoles());
            await this.deleteGame(groupId);
        } else {
             await this.transitionToNextPhase(groupId, game);
        }
    }

    async transitionToNextPhase(groupId, game) {
        if (!game || game.gameState.status === 'ended') return;
        const nextStatus = game.gameState.status;
        console.log(`[${PLUGIN_NAME}] Transitioning phase for group ${groupId} to: ${nextStatus}`);

        switch (nextStatus) {
             case 'night_init': await this.startNightInitPhase(groupId, game); break;
             case 'day_speak': await this.startDayPhase(groupId, game); break;
             case 'day_vote': await this.startVotingPhase(groupId, game); break;
             case 'hunter_shooting': await this.startHunterShootPhase(groupId, game); break;
             case 'ended': console.log(`[${PLUGIN_NAME}] Game ended for group ${groupId}`); break;
             default: console.warn(`[${PLUGIN_NAME}] Unknown next status in transitionToNextPhase: ${nextStatus} for group ${groupId}`);
        }
    }

    async startHunterShootPhase(groupId, game) {
        if (!game || game.gameState.status !== 'hunter_shooting' || !game.gameState.hunterNeedsToShoot) return;
        const hunterUserId = game.gameState.hunterNeedsToShoot;
        const hunterInfo = game.getPlayerInfo(hunterUserId);
        const alivePlayerList = game.getAlivePlayerList();

        await this.sendSystemGroupMsg(groupId, `${hunterInfo} 是猎人！临死前可以选择开枪带走一人！\n你有 ${this.HUNTER_SHOOT_TIMEOUT / 1000} 秒时间。\n存活玩家：\n${alivePlayerList}`);
        await this.sendDirectMessage(hunterUserId, `你是猎人，请开枪！\n发送 #开枪 [目标编号]\n你有 ${this.HUNTER_SHOOT_TIMEOUT / 1000} 秒时间。\n${alivePlayerList}`, groupId);

        game.gameState.hunterShootStartTime = Date.now();
        await this.saveGame(groupId, game);
        this.setActionTimeout(groupId, 'hunter_shoot', this.HUNTER_SHOOT_TIMEOUT);
    }


    async forceEndGame(e, isAutoCleanup = false) {
        const groupId = e.group_id;
        if (!groupId) return;

        const game = await this.getGameInstance(groupId);
        if (!game) {
            // 自动清理时无 e 对象，不能 reply
            return isAutoCleanup ? null : e.reply("本群当前没有狼人杀游戏。", true);
        }

        let canEnd = false;
        if (isAutoCleanup) {
            canEnd = true;
        } else if (game.gameState.hostUserId === e.user_id) {
            canEnd = true;
        } else if (e.member && await e.member.is_admin) { // 检查群管理员
            canEnd = true;
        } else if (e.isMaster) { // 检查机器人主人
             canEnd = true;
        }

        if (!canEnd) {
             return e.reply("只有房主、群管理员或机器人主人才能强制结束游戏。", true);
        }

        const status = game.gameState.status;
        const enderNickname = isAutoCleanup ? '系统自动' : (e.sender.card || e.sender.nickname);

        // 使用 sendSystemGroupMsg 发送结束消息
        await this.sendSystemGroupMsg(groupId, `游戏已被 ${enderNickname} 强制结束。`);

        if (status !== 'waiting' && status !== 'ended') {
             await this.sendSystemGroupMsg(groupId, "公布所有玩家身份：\n" + game.getFinalRoles());
        }

        await this.deleteGame(groupId);
        // 不再回复 "游戏已成功结束"
        return true;
    }

    async showGameStatus(e) {
        const groupId = e.group_id;
        if (!groupId) return;

        const game = await this.getGameInstance(groupId);
        if (!game || game.gameState.status === 'ended') {
            return e.reply("本群当前没有正在进行的狼人杀游戏。", true);
        }

        let statusMsg = `--- ${PLUGIN_NAME} 游戏状态 ---\n`;
        statusMsg += `状态: ${game.gameState.status}\n`;
        statusMsg += `天数: ${game.gameState.currentDay}\n`;
        statusMsg += `房主: ${game.getPlayerInfo(game.gameState.hostUserId)}\n`;
        statusMsg += `存活玩家 (${game.players.filter(p => p.isAlive).length}/${game.players.length}):\n`;
        statusMsg += game.getAlivePlayerList();
        // 显示当前发言者（如果正在发言）
        if (game.gameState.status === 'day_speak' && game.gameState.currentSpeakerUserId) {
            statusMsg += `\n当前发言: ${game.getPlayerInfo(game.gameState.currentSpeakerUserId)}`;
        }


        // 使用 e.reply 回复状态信息，引用原消息
        return e.reply(statusMsg, true);
    }

     // --- GM调试命令 ---
     async manualEndNightInit(e) {
         if (!e.isMaster) return;
         const groupId = e.group_id;
         if (!groupId) return;
         const game = await this.getGameInstance(groupId);
         if (!game || game.gameState.status !== 'night_init') {
             return e.reply("当前不是夜晚初始阶段或没有游戏。", true);
         }
         await e.reply("收到指令，手动结束夜晚初始阶段...", true);
         this.clearActionTimeout(groupId);
         await this.processNightInitEnd(groupId, game);
     }

     async manualEndWitch(e) {
          if (!e.isMaster) return;
          const groupId = e.group_id;
          if (!groupId) return;
          const game = await this.getGameInstance(groupId);
          if (!game || game.gameState.status !== 'night_witch') {
              return e.reply("当前不是女巫行动阶段或没有游戏。", true);
          }
          await e.reply("收到指令，手动结束女巫行动阶段...", true);
          this.clearActionTimeout(groupId);
          await this.processWitchEnd(groupId, game, false);
      }

     async manualEndSpeechTurn(e) { // GM跳过当前发言者
         if (!e.isMaster) return;
         const groupId = e.group_id;
         if (!groupId) return;
         const game = await this.getGameInstance(groupId);
         if (!game || game.gameState.status !== 'day_speak') {
              return e.reply("当前不是发言阶段或没有游戏。", true);
          }
          const currentSpeaker = game.getCurrentSpeaker();
          if (!currentSpeaker) {
              return e.reply("当前没有发言者。", true);
          }
          await e.reply(`收到指令，手动结束 ${currentSpeaker.nickname} 的发言...`, true);
          this.clearActionTimeout(groupId);
          const nextSpeakerUserId = game.moveToNextSpeaker();
          await this.saveGame(groupId, game);
          if (nextSpeakerUserId) {
              await this.announceAndSetSpeechTimer(groupId, game);
          } else {
              await this.sendSystemGroupMsg(groupId, "所有玩家发言完毕，进入投票阶段。");
              await this.startVotingPhase(groupId, game);
          }
     }


     async manualEndVote(e) {
        // ... (不变, 使用 e.reply) ...
          if (!e.isMaster) return;
          const groupId = e.group_id;
          if (!groupId) return;
          const game = await this.getGameInstance(groupId);
          if (!game || game.gameState.status !== 'day_vote') {
              return e.reply("当前不是投票阶段或没有游戏。", true);
          }
          await e.reply("收到指令，手动结束投票...", true);
          this.clearActionTimeout(groupId);
          await this.processVoteEnd(groupId, game);
      }

     async manualEndHunterShoot(e) {
        // ... (不变, 使用 e.reply) ...
          if (!e.isMaster) return;
          const groupId = e.group_id;
          if (!groupId) return;
          const game = await this.getGameInstance(groupId);
          if (!game || game.gameState.status !== 'hunter_shooting') {
               return e.reply("当前不是猎人开枪阶段或没有游戏。", true);
           }
           await e.reply("收到指令，手动结束猎人开枪阶段（视为超时）...", true);
           this.clearActionTimeout(groupId);
           await this.processHunterShootEnd(groupId, game);
      }


    // --- 辅助函数 ---
    /**
     * 发送系统触发的群消息 (非回复特定用户)
     * @param {string} groupId 群号
     * @param {string | import('oicq').MessageElem[]} msg 消息内容
     */
    async sendSystemGroupMsg(groupId, msg) {
        if (!groupId || !msg) return;
        try {
            // 使用 Bot 对象发送，因为没有 e 对象可以 reply
            await Bot.pickGroup(groupId).sendMsg(msg);
        } catch (err) {
            console.error(`[${PLUGIN_NAME}] 发送系统群消息失败 (${groupId}):`, err);
        }
    }

    /**
     * 发送私聊消息给指定用户
     * @param {string} userId 用户QQ号
     * @param {string | import('oicq').MessageElem[]} msg 消息内容
     * @param {string | null} sourceGroupId 来源群号，用于在发送失败时在群内提示
     * @param {boolean} notifyGroupOnError 是否在发送失败时通知来源群组
     * @returns {Promise<boolean>} 是否发送成功
     */
    async sendDirectMessage(userId, msg, sourceGroupId = null, notifyGroupOnError = true) {
        if (!userId || !msg) return false;
        try {
            await Bot.pickUser(userId).sendMsg(msg);
            return true;
        } catch (err) {
            console.error(`[${PLUGIN_NAME}] 发送私聊消息失败 (userId: ${userId}):`, err);
             if (sourceGroupId && notifyGroupOnError) {
                 try {
                     // 使用新的系统群消息函数
                     await this.sendSystemGroupMsg(sourceGroupId, `[!] 无法向玩家 QQ:${userId} 发送私聊消息，请检查好友关系或机器人是否被屏蔽。`);
                 } catch (groupErr) {
                    console.error(`[${PLUGIN_NAME}] 发送私聊失败提示到群聊时再次失败 (${sourceGroupId}):`, groupErr);
                 }
             }
            return false;
        }
    }

    // 清理资源
    cleanup() {
        console.log(`[${PLUGIN_NAME}] 正在清理插件资源...`);
        for (const groupId of this.actionTimeouts.keys()) {
            this.clearActionTimeout(groupId);
        }
        this.actionTimeouts.clear();
        GameCleaner.cleanupAll();
        console.log(`[${PLUGIN_NAME}] 清理完成。`);
        // process.exit(0); // 通常不由插件主动退出进程
    }
}