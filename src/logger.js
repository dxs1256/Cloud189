const log4js = require("log4js");
const fs = require("fs");

log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
      layout: {
        type: "pattern",
        pattern: "[%d] [%p] %X{user}: %m",
      },
    },
    file: {
      type: "multiFile",
      base: ".logs/",
      property: "categoryName",
      extension: ".log",
      maxLogSize: 10485760,
      backups: 3,
      compress: true,
      layout: {
        type: "pattern",
        pattern: "[账号：%X{user}] %m",
      },
    },
  },
  categories: {
    default: { appenders: ["out", "file"], level: "info" },
    push: { appenders: ["out", "vcr"], level: "info" },
  },
});

const cleanLogs = () => {
  if (!fs.existsSync(".logs")) {
    return;
  }
  const logs = fs.readdirSync(".logs");
  logs.forEach(log => {
    if (log.endsWith(".log")) {
      fs.unlinkSync(`.logs/${log}`);
    }
  })
};

const catLogs = () => {
  if (!fs.existsSync(".logs")) {
    return "";
  }
  const logs = fs.readdirSync(".logs");
  const content = logs
    .map((file) => fs.readFileSync(`.logs/${file}`, { encoding: "utf-8" }))
    .join("\n\n");
  return content;
};

// recording appender（log4js 内置，用于捕获推送日志）
const recording = require("log4js/lib/appenders/recording");

const replayLogs = () => {
  const events = recording.replay();
  return events.map((e) => `${e.data.join("")}`).join("  \n");
};

const eraseLogs = () => {
  recording.erase();
};

module.exports = { log4js, cleanLogs, catLogs, replayLogs, eraseLogs };
