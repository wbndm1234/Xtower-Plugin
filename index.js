import fs from 'node:fs'
if (!global.segment) {
    try {
        global.segment = (await import("icqq")).segment
    } catch {
        global.segment = (await import("oicq")).segment
    }
}

logger.info('---------QAQ---------')

const files = fs.readdirSync('./plugins/phi-plugin/apps').filter(file => file.endsWith('.js'))
let errvis = false
let ret = []

files.forEach((file) => {
    ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
    let name = files[i].replace('.js', '')

    if (ret[i].status != 'fulfilled') {
        // console.error(ret[i])
        throw new Error(ret[i].reason)
    }
    apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

export { apps }

if (!errvis) {
    logger.mark(` xtower-plugin载入成功`)
}
