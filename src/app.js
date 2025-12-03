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
// 【关键修改】尝试直接引入 got 库，创建一个纯净的请求实例
let got;
try {
    got = require('got');
} catch (e) {
    // 如果直接引入失败，尝试从 sdk 内部路径引入（通常 actions 环境是扁平的，直接 require 没问题）
    got = require('cloud189-sdk/node_modules/got');
}

const execThreshold = process.env.EXEC_THRESHOLD || 1;
const tokenDir = ".token";

sdkLogger.configure({
  isDebugEnabled: process.env.CLOUD189_VERBOSE === "1",
});

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
      
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });

      if (cookie) {
        // 打印 Cookie 前几位，确认读取成功 (注意保护隐私，不要打印全)
        logger.log(`检测到 Cookie 配置 (${cookie.substring(0, 10)}...)，准备暴力注入...`);
        
        // =========================================================
        // 终极方案：创建一个全新的 got 实例，彻底甩掉 SDK 的包袱
        // =========================================================
        
        if (got) {
            // 创建一个纯净的请求客户端，没有任何 SDK 的拦截钩子
            const pureRequest = got.extend({
                headers: {
                    'Cookie': cookie,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://cloud.189.cn/',
                    'Host': 'cloud.189.cn',
                    'Accept': 'application/json;charset=UTF-8'
                },
                // 显式禁用重试
                retry: 0, 
                // 显式清空钩子 (虽然新实例本就没有，但为了保险)
                hooks: {
                    beforeRequest: [],
                    afterResponse: [],
                    beforeError: []
                }
            });

            // 【移花接木】直接替换 SDK 内部的 request 实例
            cloudClient.request = pureRequest;
            logger.log("✅ 已将 SDK 请求核心替换为纯净实例 (自动登录已物理屏蔽)");

        } else {
            logger.warn("⚠️ 未能加载原生 got 库，降级使用 header 注入...");
            // 降级逻辑...
            if (cloudClient.request && cloudClient.request.extend) {
                 cloudClient.request = cloudClient.request.extend({
                    headers: { 'Cookie': cookie },
                    retry: 0
                 });
            }
        }

        // 屏蔽 Login 方法，防止任何意外触发
        cloudClient.login = async function() {
            logger.error("🛑 警告：触发了 login 调用！说明 Cookie 已经失效，服务器返回了 401。");
            throw new Error("CookieInvalid: 注入的 Cookie 已失效，请重新抓取。");
        };

        // 伪造已登录状态
        cloudClient.sessionKey = "FAKE_SESSION_FOR_COOKIE_MODE";
        cloudClient.accessToken = "FAKE_TOKEN_FOR_COOKIE_MODE";
      }

      logger.log("正在获取用户信息...");
      // 此时发送请求，如果 Cookie 有效，直接返回数据。
      // 如果 Cookie 无效，服务器返 401，pureRequest 会直接抛出错误，不会去调用 login。
      const beforeUserSizeInfo = await cloudClient.getUserSizeInfo();
      
      userSizeInfoMap.set(userName, {
        cloudClient,
        userSizeInfo: beforeUserSizeInfo,
        logger,
      });
      await Promise.all([doUserTask(cloudClient, logger)]);

    } catch (e) {
      if (e.response) {
        logger.log(`❌ 请求被服务器拒绝，状态码: ${e.response.statusCode}`);
        // 打印简短的错误体，帮助分析
        try {
            const body = typeof e.response.body === 'string' ? e.response.body : JSON.stringify(e.response.body);
            logger.log("❌ 错误详情: " + body.substring(0, 200));
        } catch(err) {}

        if (e.response.statusCode === 401 || (e.response.body && JSON.stringify(e.response.body).includes("InvalidSession"))) {
             logger.error("👉 结论：Cookie 已过期或格式错误。请在 PC 浏览器重新登录并复制完整 Cookie。");
        }
      } else if (e.message && e.message.includes("CookieInvalid")) {
          // 这是我们上面自定义拦截抛出的错误
          logger.error(e.message);
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
