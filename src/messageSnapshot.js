function toIso(value) {
  if (!value) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return "";
}

function toJsonOrNull(value) {
  if (!value) {
    return null;
  }

  if (typeof value.toJSON === "function") {
    return value.toJSON();
  }

  return null;
}

function collectionValues(collection) {
  if (!collection) {
    return [];
  }

  if (typeof collection.values === "function") {
    return Array.from(collection.values());
  }

  return [];
}

function serializeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username ?? "",
    globalName: user.globalName ?? "",
    discriminator: user.discriminator ?? "",
    tag: user.tag ?? "",
    bot: user.bot ?? false,
    system: user.system ?? false,
    avatar: user.avatar ?? "",
    avatarURL: typeof user.displayAvatarURL === "function" ? user.displayAvatarURL() : "",
    createdAt: toIso(user.createdAt),
  };
}

function serializeRole(role) {
  if (!role) {
    return null;
  }

  return {
    id: role.id,
    name: role.name ?? "",
    color: role.hexColor ?? "",
    position: role.position ?? null,
    managed: role.managed ?? false,
  };
}

function serializeMember(member) {
  if (!member) {
    return null;
  }

  return {
    id: member.id,
    displayName: member.displayName ?? "",
    nickname: member.nickname ?? "",
    joinedAt: toIso(member.joinedAt),
    premiumSince: toIso(member.premiumSince),
    avatar: member.avatar ?? "",
    roles: collectionValues(member.roles?.cache).map(serializeRole).filter(Boolean),
  };
}

function serializeChannel(channel) {
  if (!channel) {
    return null;
  }

  return {
    id: channel.id,
    name: channel.name ?? "",
    type: channel.type ?? null,
    parentId: channel.parentId ?? "",
    topic: channel.topic ?? "",
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rateLimitPerUser ?? null,
  };
}

function serializeGuild(guild) {
  if (!guild) {
    return null;
  }

  return {
    id: guild.id,
    name: guild.name ?? "",
    description: guild.description ?? "",
    ownerId: guild.ownerId ?? "",
    memberCount: guild.memberCount ?? null,
    preferredLocale: guild.preferredLocale ?? "",
    icon: guild.icon ?? "",
  };
}

function serializeAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name ?? "",
    description: attachment.description ?? "",
    contentType: attachment.contentType ?? "",
    size: attachment.size ?? 0,
    url: attachment.url ?? "",
    proxyURL: attachment.proxyURL ?? "",
    height: attachment.height ?? null,
    width: attachment.width ?? null,
    ephemeral: attachment.ephemeral ?? false,
    duration: attachment.duration ?? null,
    waveform: attachment.waveform ?? null,
  };
}

function serializeEmbed(embed) {
  return toJsonOrNull(embed) ?? {
    title: embed.title ?? "",
    description: embed.description ?? "",
    url: embed.url ?? "",
    color: embed.color ?? null,
    timestamp: embed.timestamp ?? "",
    fields: embed.fields ?? [],
  };
}

function serializeReaction(reaction) {
  return {
    emoji: {
      id: reaction.emoji?.id ?? "",
      name: reaction.emoji?.name ?? "",
      animated: reaction.emoji?.animated ?? false,
    },
    count: reaction.count ?? 0,
    me: reaction.me ?? false,
  };
}

function serializeSticker(sticker) {
  return {
    id: sticker.id,
    name: sticker.name ?? "",
    description: sticker.description ?? "",
    format: sticker.format ?? null,
    url: sticker.url ?? "",
  };
}

function serializeMentions(message) {
  return {
    everyone: message.mentions?.everyone ?? false,
    users: collectionValues(message.mentions?.users).map(serializeUser).filter(Boolean),
    members: collectionValues(message.mentions?.members).map(serializeMember).filter(Boolean),
    roles: collectionValues(message.mentions?.roles).map(serializeRole).filter(Boolean),
    channels: collectionValues(message.mentions?.channels).map(serializeChannel).filter(Boolean),
    repliedUser: serializeUser(message.mentions?.repliedUser),
  };
}

export function createMessageSnapshot(message) {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    message: {
      id: message.id,
      url: message.url ?? "",
      type: message.type ?? null,
      system: message.system ?? false,
      content: message.content ?? "",
      cleanContent: message.cleanContent ?? message.content ?? "",
      createdAt: toIso(message.createdAt),
      createdTimestamp: message.createdTimestamp ?? null,
      editedAt: toIso(message.editedAt),
      editedTimestamp: message.editedTimestamp ?? null,
      guildId: message.guildId ?? "",
      channelId: message.channelId,
      webhookId: message.webhookId ?? "",
      applicationId: message.applicationId ?? "",
      position: message.position ?? null,
      pinned: message.pinned ?? false,
      tts: message.tts ?? false,
      nonce: message.nonce ?? null,
      flagsBitfield: message.flags?.bitfield ?? 0,
      reference: message.reference
        ? {
            messageId: message.reference.messageId ?? "",
            channelId: message.reference.channelId ?? "",
            guildId: message.reference.guildId ?? "",
            type: message.reference.type ?? null,
          }
        : null,
      activity: message.activity ?? null,
    },
    guild: serializeGuild(message.guild),
    channel: serializeChannel(message.channel),
    author: serializeUser(message.author),
    member: serializeMember(message.member),
    mentions: serializeMentions(message),
    attachments: collectionValues(message.attachments).map(serializeAttachment),
    embeds: message.embeds.map(serializeEmbed),
    components: message.components.map((component) => toJsonOrNull(component)).filter(Boolean),
    stickers: collectionValues(message.stickers).map(serializeSticker),
    reactions: collectionValues(message.reactions?.cache).map(serializeReaction),
    poll: toJsonOrNull(message.poll),
    interaction: toJsonOrNull(message.interaction),
    interactionMetadata: toJsonOrNull(message.interactionMetadata),
  };
}
