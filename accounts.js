function loadAccountsFromEnv() {
    let accounts = []

    // 读取旧版环境变量
    if (process.env.TY_ACCOUNTS) {
        try {
            accounts = JSON.parse(process.env.TY_ACCOUNTS)
        } catch (e) {
            console.error(`TY_ACCOUNTS 解析失败: ${e.message}，请检查账号配置格式`)
            return []
        }
    } else {
        // 从环境变量中读取账号，支持任意数量
        let index = 1
        while (true) {
            const userName = process.env[`TY_USERNAME_${index}`]
            const password = process.env[`TY_PASSWORD_${index}`]
            if (!userName || !password) {
                break
            }
            accounts.push({
                userName,
                password
            })
            index++
        }
    }

    return accounts
}

const accounts = loadAccountsFromEnv()
module.exports = accounts
