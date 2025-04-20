import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 获取当前模块路径
const __dirname = path.dirname(fileURLToPath(import.meta.url))

logger.info('--------- Xtower-Plugin 初始化 ---------')

// 安全读取apps目录
let files = []
try {
    files = fs.readdirSync(path.join(__dirname, 'apps'))
        .filter(file => file.endsWith('.js') && !file.startsWith('_'))
} catch (err) {
    logger.error('读取apps目录失败:', err)
    throw err
}

// 异步加载所有模块
const loadModules = async () => {
    const imports = files.map(file => 
        import(`./apps/${file}?t=${Date.now()}`) // 添加时间戳防止缓存
            .then(module => {
                return {
                    name: file.replace('.js', ''),
                    module
                }
            })
            .catch(err => {
                logger.error(`加载模块 ${file} 失败:`, err)
                return {
                    name: file.replace('.js', ''),
                    error: err
                }
            })
    )

    const results = await Promise.all(imports)
    const apps = {}
    let hasError = false

    results.forEach(({name, module, error}) => {
        if (error) {
            hasError = true
            return
        }
        
        // 获取模块的默认导出或第一个导出
        const exported = module.default || module[Object.keys(module)[0]]
        if (exported) {
            apps[name] = exported
        } else {
            logger.warn(`模块 ${name} 没有有效导出`)
            hasError = true
        }
    })

    if (hasError) {
        logger.warn('部分模块加载失败，但插件将继续运行')
    } else {
        logger.mark('Xtower-Plugin 所有模块载入成功')
    }

    return apps
}

// 导出加载好的模块
export const apps = await loadModules().catch(err => {
    logger.error('插件初始化失败:', err)
    process.exit(1)
})