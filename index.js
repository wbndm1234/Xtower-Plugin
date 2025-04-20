import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 安全加载函数
async function safeImport(modulePath) {
    try {
        // 添加时间戳防止缓存
        return await import(`${modulePath}?t=${Date.now()}`)
    } catch (err) {
        console.error(`加载模块 ${modulePath} 失败:`, err)
        return null
    }
}

// 加载所有插件
export async function loadApps() {
    const appsDir = path.join(__dirname, 'apps')
    const apps = {}
    
    try {
        const files = fs.readdirSync(appsDir)
            .filter(file => file.endsWith('.js'))
            .filter(file => !file.startsWith('_'))

        for (const file of files) {
            const name = path.basename(file, '.js')
            const module = await safeImport(`./apps/${file}`)
            
            if (module) {
                apps[name] = module.default || module
                console.log(`成功加载模块: ${name}`)
            }
        }
    } catch (err) {
        console.error('加载插件时出错:', err)
    }

    return apps
}

export const apps = await loadApps()