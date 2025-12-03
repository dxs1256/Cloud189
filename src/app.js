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
  // 这里捕获一下异常，防止单个任务失败炸掉整个流程
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
      
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });

      if (cookie) {
        logger.log("检测到 Cookie，正在配置【手机端】伪装...");
        
        // =========================================================
        // 修改区：切换为手机 User-Agent
        // =========================================================
        
        const commonHeaders = {
            'Cookie': cookie,
            // 【修改点】改为 Android 手机 User-Agent
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
            // 【修改点】Referer 也改为移动端地址
            'Referer': 'https://m.cloud.189.cn/', 
            'Host': 'cloud.189.cn',
            'Origin': 'https://m.cloud.189.cn'
        };

        // 1. 强制注入 Headers 并清空 Hooks
        if (cloudClient.request && typeof cloudClient.request.extend === 'function') {
            cloudClient.request = cloudClient.request.extend({
                headers: commonHeaders,
                hooks: {
                    // 依然保持清空钩子，防止 SDK 自动跳转登录
                    beforeRequest: [],
                    afterResponse: [],
                    beforeRetry: [],
                    beforeError: []
                },
                retry: { limit: 0 }
            });
            logger.log("✅ 已伪装为 Android 手机设备");
        } 
        
        // 2. 物理屏蔽 Login 方法
        cloudClient.login = async function() {
            logger.warn("🛑 拦截到 SDK 尝试自动登录，已阻止！(手机 Cookie 模式)");
            return { sessionKey: "COOKIE_MODE_MOBILE", accessToken: "COOKIE_MODE_MOBILE" };
        };

        // 3. 伪造内部状态
        cloudClient.sessionKey = "COOKIE_MODE_SESSION";
        cloudClient.accessToken = "COOKIE_MODE_TOKEN";
      }

      // =========================================================

      logger.log("正在获取用户信息...");
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });
      await Promise.all([doUserTask(cloudClient, logger)]);

    } catch (e) {
      if (e.response) {
        logger.log(`请求失败: ${e.response.statusCode}`);
        if (e.response.statusCode === 401 || (e.response.body && JSON.stringify(e.response.body).includes("Invalid"))) {
             logger.error("❌ Cookie 无效或已过期！");
        } else if (e.message && e.message.includes("设备ID不存在")) {
             logger.error("❌ 依然触发设备验证，建议重新抓取【手机网页版】的 Cookie 尝试。");
        } else {
             logger.log("响应体片段: " + JSON.stringify(e.response.body).substring(0, 150));
        }
      } else {
        logger.error(e);
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
  const userSizeInfoMap = new Map();
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password, cookie } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    
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
        logger.warn("获取签后容量失败: " + error.message);
    }
  }
}

(async () => {
  try {
    await main();
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
