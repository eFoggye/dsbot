// Карта каналов проекта.
// trigger: "create"   — обрабатывать при появлении сообщения (по умолчанию);
//          "reaction" — обрабатывать только когда на сообщение поставили approveEmoji.
//
// Сейчас здесь БОЕВЫЕ ID. Тестовые ID (для отката на тестовый сервер):
//   распределение-дел-ск 1514052581297492018 | дела-ск 1514052653145915473
//   состав-ск 1514052689062002798 | аудит-взысканий 1514052604324479006
//   рапорта-на-отпуск 1514052629993357363 | внутренний-оборот 1514053016091623629

export const channelRules = {
  "1297989307474378753": {
    key: "sk_assignments",
    name: "распределение-дел-ск",
    description: "Назначение новых материалов следователям.",
    trigger: "create",
  },
  "1298651480399548499": {
    key: "sk_cases",
    name: "дела-ск",
    description: "Публикации о возбуждении, завершении, отказе и прекращении дел.",
    trigger: "create",
  },
  "1297988413924048907": {
    key: "staff",
    name: "состав-ск",
    description: "Публикации по составу сотрудников.",
    trigger: "create",
  },
  "1298663394366324736": {
    key: "discipline_audit",
    name: "аудит-взысканий",
    description: "Взыскания, предупреждения, выговоры и снятия взысканий.",
    trigger: "create",
  },
  "1497540715427790868": {
    key: "vacation_reports",
    name: "рапорта-на-отпуск",
    description: "Рапорта на отпуск. Уходят в таблицу только после одобрения реакцией ✅.",
    trigger: "reaction",
    approveEmoji: "✅",
  },
  "1297990569049456640": {
    key: "internal_orders",
    name: "внутренний-оборот",
    description: "Приказы и внутренние документы, часто в виде изображений.",
    trigger: "create",
  },
};

export const defaultChannelIds = Object.keys(channelRules);

export function getChannelRule(channelId) {
  return (
    channelRules[channelId] ?? {
      key: "unknown",
      name: "unknown",
      description: "Канал не описан в локальных правилах.",
      trigger: "create",
    }
  );
}
