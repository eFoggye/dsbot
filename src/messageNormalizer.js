import { parseMessageText } from "./messageParser.js";
import { routeMessageEvent } from "./channelRouter.js";
import { createMessageSnapshot } from "./messageSnapshot.js";

function normalizeAttachments(message) {
  return Array.from(message.attachments.values()).map((attachment) => ({
    id: attachment.id,
    name: attachment.name ?? "",
    url: attachment.url,
    contentType: attachment.contentType ?? "",
    size: attachment.size ?? 0,
  }));
}

function normalizeEmbeds(message) {
  return message.embeds.map((embed) => ({
    title: embed.title ?? "",
    description: embed.description ?? "",
    url: embed.url ?? "",
    fields: embed.fields.map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline ?? false,
    })),
  }));
}

function normalizeMentions(message) {
  return Array.from(message.mentions.users.values()).map((user) => {
    const member = message.mentions.members?.get(user.id);

    return {
      id: user.id,
      username: user.username ?? "",
      globalName: user.globalName ?? "",
      tag: user.tag ?? "",
      displayName: member?.displayName ?? user.globalName ?? user.username ?? "",
      isBot: user.bot ?? false,
    };
  });
}

// Упомянутые роли — нужны для определения должности в списке состава
// (формат строки: <@&роль> - <@юзер> [<:звание:>]).
function normalizeRoleMentions(message) {
  return Array.from(message.mentions.roles?.values() ?? []).map((role) => ({
    id: role.id,
    name: role.name ?? "",
  }));
}

export function normalizeMessage(message) {
  const content = message.content ?? "";
  const cleanContent = message.cleanContent ?? content;

  const event = {
    eventType: "message_create",
    receivedAt: new Date().toISOString(),
    createdAt: message.createdAt?.toISOString() ?? "",
    guildId: message.guildId ?? "",
    channelId: message.channelId,
    messageId: message.id,
    messageUrl: message.guildId
      ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
      : "",
    author: {
      id: message.author?.id ?? "",
      username: message.author?.username ?? "",
      globalName: message.author?.globalName ?? "",
      tag: message.author?.tag ?? "",
      isBot: message.author?.bot ?? false,
    },
    member: {
      displayName: message.member?.displayName ?? "",
    },
    content,
    cleanContent,
    parsed: parseMessageText(`${cleanContent}\n${content}`),
    mentions: normalizeMentions(message),
    roleMentions: normalizeRoleMentions(message),
    attachments: normalizeAttachments(message),
    embeds: normalizeEmbeds(message),
    rawSnapshot: createMessageSnapshot(message),
  };

  return routeMessageEvent(event);
}
