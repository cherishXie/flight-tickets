import { createPriceSnapshot } from "./pricing.js";

export const PRICE_SOURCE_TYPES = {
  MOCK: "mock",
  MANUAL: "manual",
  CSV: "csv"
};

export function listPriceSources() {
  return [
    {
      id: PRICE_SOURCE_TYPES.MOCK,
      name: "模拟价格源",
      mode: "automatic",
      status: "enabled",
      note: "用于 v1 本地原型验证；后续可替换为真实航班价格 API。"
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
