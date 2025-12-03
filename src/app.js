require("dotenv").config();
const {
  CloudClient,
  FileTokenStore,
  logger: sdkLogger,
} = require("cloud189-sdk");
const recording = require("log4js/lib/appenders/recording");
const accounts = require("../accounts");
const { mask, delay } = require("./utils");
const push = require("./push");
const { log4js, cleanLogs, catLogs } = require("./logger");
const execThreshold = process.env.EXEC_THRESHOLD || 1;
const tokenDir = ".token";

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

// 个人任务签到
const doUserTask = async (cloudClient, logger) => {
  const tasks = Array.from({ length: execThreshold }, () =>
    cloudClient.userSign()
  );
  const result = (await Promise.allSettled(tasks)).filter(
    ({ status, value }) =>
      status === "fulfilled" && !value.isSign && value.netdiskBonus
  );
  logger.info(
    `个人签到任务: 成功数/总请求数 ${result.length}/${tasks.length} 获得 ${
      result.map(({ value }) => value.netdiskBonus)?.join(",") || "0"
    }M 空间`
  );
};

const run = async (userName, password, cookie, userSizeInfoMap, logger) => {
  if (userName && password) {
    const before = Date.now();
    try {
      logger.log("开始执行");
      
      // 1. 初始化客户端
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });

      // 2. Cookie 注入与状态伪造核心逻辑
      if (cookie) {
        logger.log("检测到 Cookie 配置，正在注入并伪造登录状态...");
        
        // 步骤A: 注入请求头 (Headers)
        const commonHeaders = {
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // 尝试通过 request.extend 注入
        if (cloudClient.request && typeof cloudClient.request.extend === 'function') {
            cloudClient.request = cloudClient.request.extend({
                headers: commonHeaders
            });
            logger.log("✅ 请求头注入成功");
        } 
        // 兼容性注入：暴力代理 request 方法 (防止 extend 不存在)
        else {
             const originalRequest = cloudClient.request;
             cloudClient.request = function(...args) {
                let options = args[0];
                if (typeof args[0] === 'string') options = args[1] || {};
                
                options.headers = { ...options.headers, ...commonHeaders };
                
                if (typeof args[0] === 'string') args[1] = options;
                else args[0] = options;
                
                return originalRequest.apply(this, args);
             }.bind(cloudClient);
             logger.log("✅ 请求方法代理成功");
        }

        // 步骤B: 【关键】伪造内部 Session 状态
        // 这一步是为了欺骗 SDK，让它以为已经登录成功，从而不再调用 login() 接口
        cloudClient.sessionKey = "COOKIE_LOGIN_BYPASS";
        cloudClient.accessToken = "COOKIE_LOGIN_BYPASS";
      }

      // 3. 执行业务
      // 由于上面设置了 sessionKey，SDK 会跳过登录，直接用我们注入的 Cookie 发请求
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });
      await Promise.all([doUserTask(cloudClient, logger)]);

    } catch (e) {
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}, ${e.response.body}`);
        // 专门捕获 401 错误，提示 Cookie 失效
        if (e.response.statusCode === 401 || (e.response.body && JSON.stringify(e.response.body).includes("InvalidSession"))) {
            logger.error("❌ 严重错误: Cookie 已失效或 IP 变动导致拒绝访问。请重新在浏览器抓取 Cookie！");
        }
      } else {
        logger.error(e);
      }
      if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") {
        logger.error("请求超时");
        throw e;
      }
    } finally {
      logger.log(
        `执行完毕, 耗时 ${((Date.now() - before) / 1000).toFixed(2)} 秒`
      );
    }
  }
};

// 开始执行程序
async function main() {
  //  用于统计实际容量变化
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    // 解构出 cookie
    const { userName, password, cookie } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    
    // 将 cookie 传入 run 函数
    await run(userName, password, cookie, userSizeInfoMap, logger);
  }

  //数据汇总
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
    try {
        const afterUserSizeInfo = await cloudClient.getUserSizeInfo();
        logger.log(
          `个人容量：⬆️  ${(
            (afterUserSizeInfo.cloudCapacityInfo.totalSize -
              userSizeInfo.cloudCapacityInfo.totalSize) /
            1024 /
            1024
          ).toFixed(2)}M/${(
            afterUserSizeInfo.cloudCapacityInfo.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2)}G`,
          `家庭容量：⬆️  ${(
            (afterUserSizeInfo.familyCapacityInfo.totalSize -
              userSizeInfo.familyCapacityInfo.totalSize) /
            1024 /
            1024
          ).toFixed(2)}M/${(
            afterUserSizeInfo.familyCapacityInfo.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2)}G`
        );
    } catch (error) {
        logger.warn("获取签后容量失败 (可能是Cookie部分接口受限): " + error.message);
    }
  }
}

(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    const logs = catLogs();
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push("天翼云盘自动签到任务", logs + content);
    recording.erase();
    cleanLogs();
  }
})();
