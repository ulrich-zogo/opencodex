import type { Locale } from "./catalogs";

export type LogGuardLabelKey = "inspectionOnly" | "externalSqliteHome";

const LABELS: Record<Locale, Record<LogGuardLabelKey, string>> = {
  en: {
    inspectionOnly: "Inspection only",
    externalSqliteHome: "External SQLite storage",
  },
  de: {
    inspectionOnly: "Nur Inspektion",
    externalSqliteHome: "Externer SQLite-Speicher",
  },
  ko: {
    inspectionOnly: "검사 전용",
    externalSqliteHome: "외부 SQLite 저장소",
  },
  zh: {
    inspectionOnly: "仅检查",
    externalSqliteHome: "外部 SQLite 存储",
  },
  "zh-TW": {
    inspectionOnly: "僅檢查",
    externalSqliteHome: "外部 SQLite 儲存空間",
  },
  ru: {
    inspectionOnly: "Только проверка",
    externalSqliteHome: "Внешнее хранилище SQLite",
  },
  ja: {
    inspectionOnly: "検査のみ",
    externalSqliteHome: "外部 SQLite ストレージ",
  },
  tr: {
    inspectionOnly: "Yalnızca inceleme",
    externalSqliteHome: "Harici SQLite depolaması",
  },
};

export function logGuardLabel(locale: Locale, key: LogGuardLabelKey): string {
  return LABELS[locale][key];
}
