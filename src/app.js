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

const run = async (userName, password, userSizeInfoMap, logger) => {
  if (userName && password) {
    const before = Date.now();
    try {
      logger.log("开始执行");
      const cloudClient = new CloudClient({
        username: userName,
        password,
        token: new FileTokenStore(`${tokenDir}/${userName}.json`),
      });
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
    const { userName, password } = account;
    const userNameInfo = mask(userName, 3, 7);
    const logger = log4js.getLogger(userName);
    logger.addContext("user", userNameInfo);
    await run(userName, password, userSizeInfoMap, logger);
  }

  //数据汇总
  for (const [
    userName,
    { cloudClient, userSizeInfo, logger },
  ] of userSizeInfoMap) {
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
  }
}

// 修改后的推送逻辑
(async () => {
  try {
    await main();
    //等待日志文件写入
    await delay(1000);
  } finally {
    // 获取内存中的日志事件
    const events = recording.replay();
    
    // 美化内容处理
    const beautifulContent = events
      .map((e) => e.data.join("")) // 提取日志文本
      .filter((text) => {
        // 过滤掉不需要显示的流水账日志
        const noise = ["开始执行", "执行完毕"];
        return !noise.some(n => text.includes(n));
      })
      .map((text) => {
        // 针对特定内容添加排版
        if (text.includes("个人签到任务")) {
           // 提取数字部分，加粗显示结果
           return `✅ **签到结果**\n${text.replace("个人签到任务: ", "")}`;
        }
        if (text.includes("个人容量")) {
           // 将逗号替换为换行，让个人和家庭容量分开显示
           // 这里的 replace 是为了匹配 main 函数中 logger.log 的输出格式
           // 如果 main 函数输出是用空格分开的，这里可能需要调整 regex
           return `📈 **容量变动**\n${text.replace(/，/g, "\n").replace(/, /g, "\n")}`; 
        }
        if (text.includes("请求失败") || text.includes("超时") || text.includes("Error")) {
           return `❌ **异常提醒**\n${text}`;
        }
        // 其他保留的日志
        return text;
      })
      .join("\n\n"); // 使用双换行进行段落分割

    // 如果没有有效内容，给个提示
    const finalMessage = beautifulContent || "本次运行未产生重要日志信息";
    
    // 推送优化后的内容
    await push("天翼云盘签到通知", finalMessage);
    
    recording.erase();
    cleanLogs();
  }
})();
