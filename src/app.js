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

      // 2. Cookie 注入逻辑 (修复核心风控问题)
      if (cookie) {
        logger.log("检测到 Cookie 配置，正在注入以绕过设备验证...");
        
        // 方案A: 针对标准 cloud189-sdk (基于 got)
        if (cloudClient.request && typeof cloudClient.request.extend === 'function') {
            cloudClient.request = cloudClient.request.extend({
                headers: { 'Cookie': cookie }
            });
            logger.log("✅ [方案A] 成功通过 request.extend 注入 Cookie");
        } 
        // 方案B: 针对旧版 SDK 或内部结构
        else if (cloudClient._client && typeof cloudClient._client.extend === 'function') {
            cloudClient._client = cloudClient._client.extend({
                headers: { 'Cookie': cookie }
            });
            logger.log("✅ [方案B] 成功通过 _client.extend 注入 Cookie");
        }
        // 方案C: 暴力劫持 (兼容性最强)
        else {
            logger.warn("⚠️ [方案C] 未找到标准扩展点，使用函数代理强制注入 Cookie");
            const originalRequest = cloudClient.request;
            // 重新定义 request 方法
            cloudClient.request = function(...args) {
                // got 支持 (url, options) 或 (options) 两种调用方式
                let options = args[0];
                if (typeof args[0] === 'string') {
                    options = args[1] || {};
                }
                
                // 强制写入 Cookie
                options.headers = options.headers || {};
                options.headers['Cookie'] = cookie;
                
                // 确保参数回填
                if (typeof args[0] === 'string') {
                    args[1] = options;
                } else {
                    args[0] = options;
                }
                
                // 绑定 this 上下文调用原方法
                return originalRequest.apply(this, args);
            }.bind(cloudClient);
        }
      }

      // 3. 执行业务逻辑
      // 注意：带了 Cookie 后，getUserSizeInfo 会直接通过，不再触发登录流程
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
        if(e.response.statusCode === 401) {
            logger.error("❌ Cookie 可能已失效，请重新抓取！");
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
  // 用于统计实际容量变化
  const userSizeInfoMap = new Map();
  
  // 遍历所有账号
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

  // 数据汇总
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
        logger.error("获取签后容量失败: " + error.message);
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
