import { buildUnparsedAction, getCreatedDate } from "./helpers.js";

export function parseInternalOrder(event) {
  const imageAttachments = event.attachments.filter((attachment) => attachment.contentType.startsWith("image/"));

  if (imageAttachments.length === 0) {
    return buildUnparsedAction(event, "Во внутреннем обороте не найдено изображение для распознавания.");
  }

  return {
    type: "internal_order_needs_ocr",
    targetSheet: "Discord импорт",
    confidence: "low",
    lookup: {},
    row: {
      "Дата": getCreatedDate(event),
      "Канал": event.channel.name,
      "Тип": "Приказ изображением",
      "Текст": event.cleanContent || event.content,
      "Ссылка": event.messageUrl,
      "Вложения": imageAttachments.map((attachment) => attachment.url).join(" "),
    },
    data: {
      imageCount: imageAttachments.length,
      imageUrls: imageAttachments.map((attachment) => attachment.url),
      note: "Приказ-картинка распознаётся OCR-модулем, если задан OCR_API_KEY.",
    },
  };
}
