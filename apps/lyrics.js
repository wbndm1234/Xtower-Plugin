import fs from 'fs';
import path from 'path';
import fse from 'fs-extra';
import common from '../../../lib/common/common.js';
import { glob } from 'glob'; 

// ================= 核心配置 =================
// 修改数据存储路径到plugin/data
const CONFIG_PATH = path.join(process.cwd(),  'data', 'lyrics', 'config.json')
const COMMON_LYRICS_DIR = path.join(process.cwd(),  'data', 'lyrics', 'common_lyrics')
const TEMP_DIR = path.join(process.cwd(),  'data', 'temp')

// 默认配置模板
const DEFAULT_CONFIG = {
    libraries: {},       // 用户歌词库 {'库名称': '路径'}
    repositories: {},    // Git仓库 {'仓库名': 'URL'}
    groupMapping: {},    // 群组映射 {'群号': '库名称'}
    rateLimit: {         // 频率限制
        maxPerHour: 60,
        cooldown: 3600 * 1000
    }
}

// ================= 插件主类 =================
export class LyricsPlugin extends plugin {
    constructor() {
        super({
            name: '随机歌词',
            desc: '随机歌词与仓库管理',
            event: 'message',
            priority: 0,
            rule: [
                { reg: '^#抽歌词\\s*(-riv)?$', fnc: 'drawLyrics' },
                { reg: '^#抽歌词\\s+(\\d+)\\s*(-riv)?$', fnc: 'batchDraw' },
                { reg: '^#获取歌词\\s+(.+?)\\s+(.+)$', fnc: 'fetchFromRepo' },
                { reg: '^#新建歌词仓库\\s+(.+)\\s+(.+)$', fnc: 'addRepo' },
                { reg: '^#删除歌词仓库\\s+(.+)$', fnc: 'removeRepo' },
                { reg: '^#新建歌词库\\s+(.+)$', fnc: 'createLib' },
                { reg: '^#删除歌词库\\s+(.+)$', fnc: 'removeLib' },
                { reg: '^#关联群组\\s+(\\d+)\\s+(.+)$', fnc: 'linkGroup' },
                { reg: '^#歌词库列表$', fnc: 'listLibs' },
                { reg: '^#仓库列表$', fnc: 'listRepos' },
                { reg: '^#设置频率限制\\s+(\\d+)\\s+(\\d+)$', fnc: 'setRateLimit' },
                { reg: '^#更新公用库\\s+(.+)$', fnc: 'updateCommon' }
            ]
        })

        this.logger = {
            mark: (...args) => console.log('[MARK]', ...args),
            error: (...args) => console.error('[ERROR]', ...args),
            warn: (...args) => console.warn('[WARN]', ...args)
        }

        // 初始化系统
        this.#initSystem()
    }

    // ================= 私有方法 =================
    #initSystem() {
        // 加载配置并迁移旧数据
        this.config = this.#loadConfigWithMigration()
        
        // 预加载歌词缓存
        this.cache = {
            lyrics: new Map(),    // 歌词目录缓存 {路径: {files: [], mtime}}
            rateLimit: new Map()  // 频率限制缓存 {群号: {count, resetAt}}
        }
        this.#refreshCache(COMMON_LYRICS_DIR)
    }

    // 带数据迁移的配置加载
    #loadConfigWithMigration() {
        // 新配置直接加载
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH))
        }

        const migrated = {...DEFAULT_CONFIG}
        Object.entries(legacyPaths).forEach(([key, filePath]) => {
            if (fs.existsSync(filePath)) {
                migrated[key] = JSON.parse(fs.readFileSync(filePath))
                fs.unlinkSync(filePath)
            }
        })

        this.#saveConfig(migrated)
        return migrated
    }

    // 防抖保存配置
    #saveConfig(data) {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer)
        }
        this.saveTimer = setTimeout(() => {
            try {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2))
                this.logger.mark('[随机歌词]配置保存成功')
            } catch (err) {
                this.logger.error('[随机歌词]配置保存失败:', err)
            } finally {
                this.saveTimer = null
            }
        }, 500) // 500ms 防抖延迟
    }

    // ================= 歌词核心功能 =================
    // 刷新歌词缓存（自动去重）
    #refreshCache(dir) {
        if (!fs.existsSync(dir)) return
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.txt'))
            .filter(f => fs.statSync(path.join(dir, f)).isFile())
        
        this.cache.lyrics.set(dir, {
            files,
            mtime: Date.now()
        })
    }

    // 获取歌词目录
    #getTargetDir(groupId) {
        const libName = this.config.groupMapping[groupId]
        return libName ? 
            (this.config.libraries[libName] || COMMON_LYRICS_DIR) :
            COMMON_LYRICS_DIR
    }

    // 随机歌词获取
    #getRandomLyric(targetDir, isRiv) {
        try {
            // 自动刷新缓存（30分钟有效期）
            const cache = this.cache.lyrics.get(targetDir)
            if (!cache || Date.now() - cache.mtime > 1800000) {
                this.#refreshCache(targetDir)
            }

            const { files } = this.cache.lyrics.get(targetDir)
            if (!files?.length) throw new Error('空歌词库')

            // 随机选择文件
            const file = files[Math.random() * files.length | 0]
            const filePath = path.join(targetDir, file)
            const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n?/g, '\n')

            // 处理内容格式
            const chunks = content.split('\n\n')
            const author = `——${path.basename(file, '.txt')}`

            return chunks.length === 1 ?
                this.#handleSingleLine(content, author, isRiv) :
                this.#handleMultiLine(chunks, author, isRiv)
        } catch (err) {
            console.error('歌词获取失败:', err)
            return '[随机歌词] 歌词服务暂时不可用'
        }
    }

    // 处理单段落歌词
    #handleSingleLine(content, author, isRiv) {
        const lines = content.split('\n')
        const selected = lines[Math.random() * lines.length | 0]
        return isRiv ? selected : `${selected}\n${author}`
    }

    // 处理多段落歌词
    #handleMultiLine(chunks, author, isRiv) {
        const chunk = chunks[Math.random() * chunks.length | 0]
        return isRiv ? chunk : `${chunk}\n${author}`
    }

    // ================= 指令处理 =================
    // 抽歌词（带频率限制）
    async drawLyrics(e) {
        const groupId = e.group_id
        const { maxPerHour, cooldown } = this.config.rateLimit
        
        // 初始化限流
        if (!this.cache.rateLimit.has(groupId)) {
            this.cache.rateLimit.set(groupId, { count:0, resetAt:Date.now() })
        }
        
        const limit = this.cache.rateLimit.get(groupId)
        if (Date.now() - limit.resetAt > cooldown) {
            limit.count = 0
            limit.resetAt = Date.now()
        }

        if (limit.count >= maxPerHour) {
            await e.reply(`[随机歌词]冷却中哦~再等等 (剩余 ${Math.ceil((cooldown - (Date.now() - limit.resetAt))/60000)} 分钟)`)
            return
        }

        const isRiv = e.msg.includes('-riv')
        const lyrics = this.#getRandomLyric(this.#getTargetDir(groupId), isRiv)
        await e.reply(lyrics)
        
        limit.count++
    }
    
    // 批量抽歌词（转发消息）
    async batchDraw(e) {
        const match = e.msg.match(/^抽歌词\s+(\d+)\s*(-riv)?$/)
        if (!match) return await e.reply('❌ 格式：抽歌词 数量 [-riv]')

        const [_, countStr, isRiv] = match
        const count = Math.min(parseInt(countStr), 20) // 最多20条
        
        const lyricsList = Array.from({length: count}, () => 
            this.#getRandomLyric(this.#getTargetDir(e.group_id), !!isRiv)
        )
        
        const msg = await common.makeForwardMsg(e, lyricsList, `[随机歌词] x${count}`)
        await e.reply(msg)
    }
    // ================= 管理功能 =================
    async addRepo(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^添加歌词仓库\s+(.+)\s+(.+)$/)
        if (!match) return await e.reply('[随机歌词]格式错误！正确格式：添加歌词仓库 名称 仓库URL')
        const [_, name, url] = match

        try {
            new URL(url)
        } catch {
            await e.reply('[随机歌词]仓库URL格式无效，请使用完整的git地址')
            return
        }

        if (this.config.repositories[name]) {
            await e.reply('[随机歌词]仓库已经存在啦，换个名字试试？')
            return
        }

        this.config.repositories[name] = url
        this.#saveConfig(this.config)
        await e.reply(`[随机歌词]新仓库！: ${name}`)
    }

    async updateCommon(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const repoName = e.msg.split(' ')[1]
        const repoUrl = this.config.repositories[repoName]
        
        if (!repoUrl) {
            await e.reply('[随机歌词]没找到这个仓库咕~检查下名字对不对？')
            return
        }

        try {
            await this.#syncRepo(COMMON_LYRICS_DIR, repoUrl)
            this.#refreshCache(COMMON_LYRICS_DIR)
            await e.reply(`[随机歌词]公用库已更新完成！: ${repoName}`)
        } catch (err) {
            await e.reply('[随机歌词]同步失败: ' + err.message)
        }
    }

    // ================= Git操作核心 =================
    async #syncRepo(targetDir, repoUrl) {
        const { execa } = await import('execa')
        const repoName = new URL(repoUrl).pathname.split('/').pop().replace('.git', '')
        const tempDir = path.join(TEMP_DIR, `sync_${Date.now()}_${repoName}`)
        
        try {
            await fse.ensureDir(tempDir)
            this.logger.mark(`🆕 创建临时沙盒: ${path.basename(tempDir)}`) // 简化路径显示
    
            const isExist = await fse.pathExists(path.join(targetDir, '.git'))
            if (isExist) {
                this.logger.mark('⏬ 仓库存在，执行快速更新...')
                await execa('git', ['-C', targetDir, 'pull', '--rebase'], { 
                    timeout: 60000,
                    stdio: 'inherit' // 隐藏git原生输出
                })
            } else {
                this.logger.mark(`⏬ 初始克隆仓库: ${repoName}`)
                await execa('git', ['clone', '--depth=1', repoUrl, tempDir], { 
                    timeout: 120000,
                    stdio: 'pipe' // 抑制控制台输出
                })
            }
    
            this.logger.mark('🔄 开始智能同步...')
            const fileCount = await this.#syncFiles({  // 获取文件计数
                src: isExist ? targetDir : tempDir,
                dest: targetDir,
                patterns: ['**/*.txt', '!**/.git']
            })
    
            const { stdout: hash } = await execa('git', ['rev-parse', 'HEAD'], { 
                cwd: targetDir,
                stdio: ['ignore', 'pipe', 'ignore'] // 隐藏错误流
            })
            
            this.logger.mark([
                `✅ 同步完成！`,
                `📦 仓库版本: ${hash.slice(0,7)}`,
            ].join('\n'))
    
        } finally {
            await this.#nukeDirectory(tempDir).catch(err => 
                this.logger.warn(`⚠️ 清理临时目录遇到小问题: ${err.message}`) // 降级为警告
            )
        }
    }

    async #syncFiles({ src, dest, patterns }) {
        const { execa } = await import('execa')
        
        if (process.platform === 'win32') {
            await execa('robocopy', [
                src, dest, 
                '/MIR', '/NJH', '/NJS', '/NDL', '/NC', '/NS',
                ...patterns.map(p => `/IF:${p}`)
            ], {
                windowsVerbatimArguments: true,
                shell: true
            })
        } else {
            try {
                // 1. 清理目标目录
                await fse.emptyDir(dest)
                
                // 2. 匹配文件模式
                const files = await glob(patterns, { 
                    cwd: src,
                    nodir: true,
                    ignore: ['**/.git/**']
                })
                
                // 3. 并行复制文件
                await Promise.all(files.map(async file => {
                    const srcPath = path.join(src, file)
                    const destPath = path.join(dest, file)
                    await fse.copy(srcPath, destPath)
                }))
                
            } catch (err) {
                this.logger.error(`💥 同步失败详情:
                错误信息: ${err.message}
                堆栈追踪: ${err.stack}
                系统信息: ${process.platform}/${process.arch}
                Node版本: ${process.version}`)
                throw err
            }
        }
    }

    async #nukeDirectory(dir) {
        const { execa } = await import('execa')

        if (!await fse.pathExists(dir)) return
        
        try {
            await fse.remove(dir)
            this.logger.mark(`[随机歌词]正常清理完成: ${dir}`)
            return
        } catch (err) {
            this.logger.warn(`[随机歌词]普通删除失败，尝试强制清理... (${err.message})`)
        }

        const isWin = process.platform === 'win32'
        await execa(isWin ? 'rmdir' : 'rm', [
            isWin ? ['/s', '/q', `"${dir}"`] : ['-rf', dir]
        ].flat(), {
            shell: true
        })

        if (await fse.pathExists(dir)) {
            throw new Error(`[随机歌词]无法删除顽固目录: ${dir}`)
        }
        this.logger.mark(`[随机歌词]强制清理完成: ${dir}`)
    }

    async createLib(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const libName = e.msg.split(' ')[1]?.trim()
        if (!libName) return await e.reply('[随机歌词]要给歌词库起个名字')

        if (/[\\/:*?"<>|]/.test(libName)) {
            return await e.reply('[随机歌词]不允许使用 \\/:*?"<>| 这些符号')
        }

        // 修改为新的资源路径
        const libPath = path.join(process.cwd(), 'data', 'lyrics', libName)
        
        try {
            if (fs.existsSync(libPath)) {
                return await e.reply('[随机歌词]这个歌词库已经存在啦，换个名字试试？')
            }
            
            await fs.promises.mkdir(libPath, { recursive: true })
            this.config.libraries[libName] = libPath
            this.#saveConfig(this.config)
            await e.reply(`[随机歌词]新建歌词库成功！快用【获取歌词 ${libName} 仓库名】添加内容吧～`)
        } catch (err) {
            await e.reply(`[随机歌词]创建失败：${err.message}`)
        }
    }

    async linkGroup(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^关联群组\s+(\\d+)\\s+(.+)$/)
        if (!match) return await e.reply('[随机歌词]格式不对哦～示范：【关联群组 群号 歌词库名】')
        
        const [_, groupId, libName] = match
        if (!this.config.libraries[libName]) {
            return await e.reply(`[随机歌词]没找到【${libName}】歌词库，先创建它吧！`)
        }
        
        this.config.groupMapping[groupId] = libName
        this.#saveConfig(this.config)
        await e.reply(`[随机歌词]群组 ${groupId} 成功绑定 ${libName} 啦！现在可以愉快抽歌了～`)
    }

    async fetchFromRepo(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^获取歌词\s+(.+?)\\s+(.+)$/)
        if (!match) return await e.reply('📌 格式：获取歌词 库名 仓库名')
        
        const [_, libName, repoName] = match
        if (!this.config.libraries[libName]) {
            return await e.reply(`[随机歌词]没找到【${libName}】库，先创建它吧～`)
        }
        if (!this.config.repositories[repoName]) {
            return await e.reply(`[随机歌词]没找到【${repoName}】仓库，先创建它吧～`)
        }

        try {
            await this.#syncRepo(this.config.libraries[libName], this.config.repositories[repoName])
            await e.reply(`[随机歌词]【${libName}】同步完成！`)
        } catch (err) {
            await e.reply(`[随机歌词]同步失败：${err.message}`)
        }
    }

    async listLibs(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const libs = Object.keys(this.config.libraries)
        await e.reply(libs.length 
            ? `[随机歌词] 现有歌词库：\n${libs.join('\n')}` 
            : '[随机歌词] 空空如也～请【新建歌词库】吧！'
        )
    }

    async listRepos(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const entries = Object.entries(this.config.repositories)
        await e.reply(entries.length 
            ? `[随机歌词]云端仓库列表：\n${
                entries.map(([name, url]) => 
                    `✨ ${name}\n   ➤ ${url.replace(/\.git$/, '')}`
                ).join('\n')
              }\n\n使用【获取歌词 库名 仓库名】同步吧～` 
            : '[随机歌词]好像没有云端仓库，请【添加歌词仓库】吧！'
        )
    }

    async removeLib(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const libName = e.msg.split(' ')[1]
        if (!libName) return await e.reply('[随机歌词]删除哪个库呢')
        
        if (!this.config.libraries[libName]) {
            return await e.reply('[随机歌词]这个歌词库早就消失了')
        }
        
        try {
            await this.#safeRemoveDir(this.config.libraries[libName])
            delete this.config.libraries[libName]
            this.#saveConfig(this.config)
            await e.reply(`[随机歌词]【${libName}】已永久删除，真的很久～`)
        } catch (err) {
            await e.reply(`[随机歌词]删除失败：${err.message}`)
        }
    }

    async removeRepo(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const repoName = e.msg.split(' ')[1]?.trim()
        if (!repoName) return await e.reply('[随机歌词]请指定要删除的仓库名称')
    
        if (!this.config.repositories[repoName]) {
            return await e.reply(`[随机歌词]仓库【${repoName}】不存在`)
        }
    
        // 查找所有关联群组
        const affectedGroups = []
        Object.entries(this.config.groupMapping).forEach(([groupId, libName]) => {
            const libPath = this.config.libraries[libName]
            if (libPath && this.#getRepoUrl(libPath) === this.config.repositories[repoName]) {
                affectedGroups.push(groupId)
            }
        })
    
        // 如果有关联群组，要求确认
        if (affectedGroups.length > 0 && !e.msg.includes('--force')) {
            return await e.reply([
                `[随机歌词] 仓库【${repoName}】被 ${affectedGroups.length} 个群组关联`,
                `关联群组: ${affectedGroups.join(', ')}`,
                `使用【删除歌词仓库 ${repoName} --force】强制删除(将自动解除关联)`,
            ].join('\n'))
        }
    
        // 强制删除时自动解除关联
        if (affectedGroups.length > 0) {
            affectedGroups.forEach(groupId => {
                delete this.config.groupMapping[groupId]
            })
        }
    
        // 执行删除
        delete this.config.repositories[repoName]
        this.#saveConfig(this.config)
    
        const reply = [
            `[随机歌词] 仓库【${repoName}】已删除`,
            affectedGroups.length > 0 
                ? `[随机歌词] 已自动解除 ${affectedGroups.length} 个群组的关联`
                : '没有群组关联此仓库'
        ]
        
        await e.reply(reply.join('\n'))
    }
    
    // 辅助方法：获取本地仓库的远程URL
    #getRepoUrl(dir) {
        try {
            const gitConfigPath = path.join(dir, '.git', 'config')
            if (fs.existsSync(gitConfigPath)) {
                const config = fs.readFileSync(gitConfigPath, 'utf-8')
                const match = config.match(/url\s*=\s*(.+)/)
                return match ? match[1].trim() : null
            }
        } catch (err) {
            this.logger.warn(`获取仓库URL失败: ${err.message}`)
        }
        return null
    }

    async setRateLimit(e) {
        if (!e.isMaster) {
            e.reply("无权限");
            return false;
        }
        const match = e.msg.match(/^设置频率限制\s+(\\d+)\\s+(\\d+)$/)
        if (!match) return await e.reply('⏳ 格式：设置频率限制 次数 冷却秒数')
        
        const [_, maxStr, cdStr] = match
        const max = Math.min(parseInt(maxStr), 999)
        const cooldown = Math.max(parseInt(cdStr)*1000, 30000)

        this.config.rateLimit = { 
            maxPerHour: max, 
            cooldown: cooldown 
        }
        this.#saveConfig(this.config)
        
        await e.reply([
            `[随机歌词]频率限制已更新！`,
            `每小时最多抽歌: ${max}次`,
            `冷却时间: ${cooldown/1000}秒`,
        ].join('\n'))
    }

    #safeRemoveDir(targetDir) {
        if (!fs.existsSync(targetDir)) return

        // 更新安全路径检查
        const safeBase = path.join(process.cwd(),  'data', 'lyrics')
        const relativePath = path.relative(safeBase, targetDir)
        
        if (relativePath.includes('..') || !targetDir.startsWith(safeBase)) {
            throw new Error('[随机歌词]只能管理歌词库目录')
        }

        const deleteStack = [targetDir]
        while (deleteStack.length) {
            const current = deleteStack.pop()
            
            if (fs.statSync(current).isDirectory()) {
                fs.readdirSync(current).forEach(f => 
                    deleteStack.push(path.join(current, f))
                )
                fs.rmdirSync(current)
            } else {
                fs.unlinkSync(current)
            }
        }
        
        if (fs.existsSync(targetDir)) {
            throw new Error('[随机歌词]目录居然还活着，可能需要手动清理')
        }
    }

    #validateConfig() {
        this.config.libraries = Object.fromEntries(
            Object.entries(this.config.libraries)
                .filter(([name, p]) => fs.existsSync(p))
        )
        this.#saveConfig(this.config)
        
        if (!this._validated) {
            setInterval(() => this.#validateConfig(), 86400000) // 每日自检
            this._validated = true
        }
    }
}