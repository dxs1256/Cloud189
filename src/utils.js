const superagent = require("superagent");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ipAddrHosts = [
  {
    url: "https://ipinfo.io/json",
    get: (res) => res["ip"],
  },
  {
    url: "https://ifconfig.me/all.json",
    get: (res) => res["ip_addr"],
  },
];

const getIpAddr = async () => {
  if (!process.env.IP_ADDRESS) {
    try {
      const requests = ipAddrHosts.map((host) =>
        superagent
          .get(host.url)
          .then((res) => host.get(res.body))
          .catch((error) => {
            throw new Error(
              `Failed to fetch IP from ${host.url} : ${error.message}`
            );
          })
      );
      const ipAddr = await Promise.any(requests);
      if (ipAddr) {
        process.env.IP_ADDRESS = ipAddr;
      }
    } catch (e) {
      console.warn(`获取 IP 地址失败: ${e.message}`);
    }
  }
  return process.env.IP_ADDRESS;
};

function groupByNum(array, groupNum) {
  const result = [];
  for (let i = 0; i < array.length; i += groupNum) {
    result.push(array.slice(i, i + groupNum));
  }
  return result;
}

module.exports = {
  mask,
  delay,
  getIpAddr,
  groupByNum
};
