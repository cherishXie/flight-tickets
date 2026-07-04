import { createPriceSnapshot } from "./pricing.js";

export const PRICE_SOURCE_TYPES = {
  MOCK: "mock",
  AMADEUS: "amadeus",
  MANUAL: "manual",
  CSV: "csv"
};

export function listPriceSources(liveStatus = null) {
  const amadeusConfigured = Boolean(liveStatus?.amadeus?.configured);
  const amadeusOk = Boolean(liveStatus?.amadeus?.ok);
  return [
    {
      id: PRICE_SOURCE_TYPES.MOCK,
      name: "模拟价格源",
      mode: "automatic",
      status: "enabled",
      note: "用于无 API key 时验证监控、提醒和趋势流程。"
    },
    {
      id: PRICE_SOURCE_TYPES.AMADEUS,
      name: "Amadeus Flight Offers Search",
      mode: "automatic",
      status: amadeusOk ? "enabled" : amadeusConfigured ? "needs_verification" : "not_configured",
      note: amadeusOk
        ? `已连接 ${liveStatus.amadeus.environment} 环境，通过本地服务端代理查询真实航班报价。`
        : amadeusConfigured
        ? "已检测到 Amadeus 配置，请点击“测试真实连接”验证 API key 是否可用。"
        : "真实机票价格源。需在本地服务端配置 AMADEUS_CLIENT_ID 和 AMADEUS_CLIENT_SECRET。"
    },
    {
      id: PRICE_SOURCE_TYPES.MANUAL,
      name: "手动录入",
      mode: "manual",
      status: "enabled",
      note: "适合把航司官网或 OTA 查到的价格录入到同一条历史曲线。"
    },
    {
      id: PRICE_SOURCE_TYPES.CSV,
      name: "CSV 批量导入",
      mode: "manual",
      status: "enabled",
      note: "适合从表格整理多条价格快照后一次导入。"
    }
  ];
}

export function collectPriceSnapshots({ task, destinations, dateOptions, sourceType = PRICE_SOURCE_TYPES.MOCK, searchedAt = new Date() }) {
  if (sourceType !== PRICE_SOURCE_TYPES.MOCK) {
    return [];
  }

  const strategies = [
    task.monitorDirect ? "direct" : null,
    task.monitorTransfer ? "transfer" : null
  ].filter(Boolean);

  return destinations.flatMap((destination) =>
    dateOptions.flatMap((dateOption) => {
      const taskForDate = {
        ...task,
        departDate: dateOption.departDate,
        returnDate: dateOption.returnDate
      };
      return strategies.map((strategyType) =>
        createPriceSnapshot({
          task: taskForDate,
          destination,
          strategyType,
          searchedAt
        })
      );
    })
  );
}

export async function collectLivePriceSnapshots({ task, destinations, dateOptions, maxOffersPerSearch = 8, maxQueriesPerRun = 24 }) {
  const response = await fetch("/api/price-snapshots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      task,
      destinations,
      dateOptions,
      maxOffersPerSearch,
      maxQueriesPerRun
    })
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload.error?.message || "真实价格查询失败。");
  }
  return payload;
}

export async function getLivePriceSourceStatus({ deep = false } = {}) {
  try {
    const response = await fetch(`/api/price-source-status${deep ? "?deep=1" : ""}`);
    if (!response.ok) return null;
    return await readJsonResponse(response);
  } catch {
    return null;
  }
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("真实价格 API 不可用。请使用 `node scripts/serve.mjs` 启动本地服务，而不是仅启动静态预览。");
  }
  return response.json();
}
