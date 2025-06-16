export class XtowerHelp extends plugin {
  constructor () {
    super({
      name: 'Xtower 插件帮助',
      dsc: 'Xtower-Plugin 插件功能帮助',
      event: 'message',
      priority: 500, // 较高的优先级，确保能响应帮助指令
      rule: [
        {
          reg: '^#弦塔帮助$', // 匹配 #弦塔帮助
          fnc: 'showHelp'
        }
      ]
    })
  }

  /**
   * 异步执行的帮助函数
   * @param {object} e 消息事件对象
   */
  async showHelp (e) {
    const helpMsg = `Xtower-Plugin 功能帮助
--------------------
【随机歌词】
• #抽歌词 ：随机抽取歌词
• #抽歌词 <数量> ：批量抽取歌词
• PS：后加-riv参数可去除歌词出处信息。

【聪明 Bingo】
• #今日bingo：获取今日题目
• #bingo <答案>：提交答案 (例: #bingo 13 24 35)
• #查询Bingo排名：查询个人及前三排名

【谁是卧底（测试）】
• #卧底创建 [模式]：创建房间 (明牌/暗牌)
• #加入卧底：加入当前游戏
• #退出卧底：退出等待中的游戏
• #开始卧底：(房主)开始游戏
• #发言结束 / #结束发言：结束自己的发言回合
• #投票 <编号>：投票淘汰玩家 (例: #投票 01)
• #结束卧底：(房主)强制结束游戏`

    // 回复帮助信息
    await e.reply(helpMsg)

    // return true 阻止消息继续向下传递
    return true
  }
}